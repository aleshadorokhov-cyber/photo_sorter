import Observation
import Photos
import UIKit

@MainActor
@Observable
final class CleanupStore {
    private(set) var photos: [CleanupPhoto] = []
    private(set) var photoIndex: [String: CleanupPhoto] = [:]
    private(set) var groups: [DuplicateGroup] = []
    private(set) var selected: Set<String> = []
    private(set) var running = false
    private(set) var deleting = false
    private(set) var scanned = 0
    private(set) var total = 0
    private(set) var skippedHashes = 0
    private(set) var unreadText = 0
    private(set) var valid = false
    var message: String?
    var allowCloudDownload = false
    var readText = true
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var observer: CleanupObserver?

    var isLimited: Bool { PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited }
    var old: [CleanupPhoto] { photos.filter { CleanupPolicy.isOld($0.date) } }
    var textCandidates: [CleanupPhoto] { photos.filter { !$0.textHints.isEmpty } }
    var selectedPhotos: [CleanupPhoto] { photos.filter { selected.contains($0.id) } }

    init() {
        observer = CleanupObserver { [weak self] in
            Task { @MainActor in self?.libraryChanged() }
        }
    }

    func start(cached: [String: PhotoAnalysis]) {
        guard !running && !deleting else { return }
        selected.removeAll(); photos = []; photoIndex = [:]; groups = []; valid = false
        scanned = 0; total = 0; skippedHashes = 0; unreadText = 0; message = nil
        running = true
        let network = allowCloudDownload, ocr = readText
        task = Task { [weak self] in
            guard let self else { return }
            await scan(cached: cached, network: network, ocr: ocr)
            running = false
            task = nil
        }
    }

    func stop() { task?.cancel() }

    func invalidateAfterBackground() {
        guard valid || running else { return }
        libraryChanged()
    }

    private func libraryChanged() {
        guard !deleting else { return }
        task?.cancel(); valid = false; selected.removeAll()
        if !photos.isEmpty || running { message = "Медиатека или доступ изменились. Повторите проверку перед удалением." }
    }

    private func scan(cached: [String: PhotoAnalysis], network: Bool, ocr: Bool) async {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            message = "Разрешите доступ к фото в настройках."; return
        }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let fetched = PHAsset.fetchAssets(with: .image, options: options)
        total = fetched.count
        for index in 0..<fetched.count {
            if Task.isCancelled { break }
            let asset = fetched.object(at: index)
            let resource = ResourceHasher.resource(for: asset)
            var item = CleanupPhoto(id: asset.localIdentifier, date: asset.creationDate,
                                    modified: asset.modificationDate, isFavorite: asset.isFavorite,
                                    filename: PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "Фото")
            if let resource {
                do {
                    let (digest, bytes) = try await ResourceHasher.hash(resource, network: network)
                    item.digest = digest; item.bytes = bytes
                } catch { skippedHashes += 1 }
            } else { skippedHashes += 1 }
            if Task.isCancelled { break }
            if ocr {
                if let existing = cached[item.id], existing.assetModified == item.modified {
                    item.textHints = CleanupPolicy.textHints(existing.text)
                } else if let image = await PhotoLibrary.image(for: asset, side: 1400, network: network),
                          let cgImage = image.cgImage {
                    let orientation = CGImagePropertyOrientation(image.imageOrientation)
                    let lines = await Task.detached(priority: .utility) {
                        try? TextReader.read(cgImage, orientation: orientation)
                    }.value
                    if let lines { item.textHints = CleanupPolicy.textHints(lines) }
                    else { unreadText += 1 }
                } else { unreadText += 1 }
            }
            if Task.isCancelled { break }
            photos.append(item)
            photoIndex[item.id] = item
            scanned += 1
        }
        groups = CleanupPolicy.duplicates(photos)
        valid = !Task.isCancelled
        if !valid && message == nil { message = "Проверка остановлена. Для удаления завершите новую проверку." }
    }

    func toggle(_ photo: CleanupPhoto) {
        guard valid, !running, !deleting, !photo.isFavorite else { return }
        if selected.contains(photo.id) { selected.remove(photo.id) }
        else { selected.insert(photo.id) }
    }

    func selectDuplicateCopies() {
        guard valid, !running, !deleting else { return }
        selected = CleanupPolicy.duplicateSelection(groups, photos: photos)
    }

    func clearSelection() { selected.removeAll() }

    func selectOldPhotos() {
        guard valid, !running, !deleting else { return }
        selected = CleanupPolicy.safeSelection(candidates: Set(old.map(\.id)), groups: groups, photos: photos)
    }

    /// Refetch every photo involved in the plan, including keepers, immediately
    /// before the PhotoKit change. A changed date, favorite, or missing asset
    /// invalidates the plan; the user must scan and review again.
    func deleteReviewed() async {
        guard valid, !running, !deleting else { return }
        if let problem = CleanupPolicy.deletionProblem(selected: selected, photos: photos, groups: groups) {
            message = problem; return
        }
        let selection = selected
        var involved = selection
        for group in groups where !selection.isDisjoint(with: group.photoIDs) {
            involved.formUnion(group.photoIDs)
        }
        let snapshot = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
        let fresh = PHAsset.fetchAssets(withLocalIdentifiers: Array(involved), options: nil)
        var current: [String: PHAsset] = [:]
        fresh.enumerateObjects { asset, _, _ in current[asset.localIdentifier] = asset }
        for id in involved {
            guard let asset = current[id], let old = snapshot[id],
                  asset.modificationDate == old.modified, asset.creationDate == old.date,
                  asset.isFavorite == old.isFavorite else {
                libraryChanged(); return
            }
        }
        let assetsToDelete = selection.compactMap { current[$0] }
        guard assetsToDelete.count == selection.count else { libraryChanged(); return }
        deleting = true
        defer { deleting = false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.deleteAssets(assetsToDelete as NSArray)
            }
            selected.removeAll(); valid = false; photos = []; photoIndex = [:]; groups = []
            message = "Удалено фото: \(assetsToDelete.count). Их можно восстановить в «Недавно удалённых». Проверьте медиатеку заново."
        } catch {
            // Also invalidate after cancellation: Photos may have changed while
            // the system dialog was displayed. Do not label a failure success.
            selected.removeAll(); valid = false
            message = "Удаление не завершено: \(error.localizedDescription). Повторите проверку."
        }
    }
}

private final class CleanupObserver: NSObject, PHPhotoLibraryChangeObserver {
    private let changed: () -> Void
    init(changed: @escaping () -> Void) {
        self.changed = changed
        super.init()
        PHPhotoLibrary.shared().register(self)
    }
    deinit { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    func photoLibraryDidChange(_ changeInstance: PHChange) { changed() }
}
