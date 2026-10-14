import Foundation
import Observation
import Photos
import UIKit

/// Фото одной категории: от новых к старым, фото без даты в конце.
struct CategoryGroup: Identifiable {
    let category: Taxonomy.Category
    let photoIDs: [String]
    var id: String { category.id }
}

@MainActor
@Observable
final class LibraryStore {
    enum Access { case unknown, granted, denied }

    private(set) var access: Access = .unknown
    private(set) var isScanning = false
    private(set) var scannedCount = 0
    private(set) var scanTotal = 0
    private(set) var analyses: [String: PhotoAnalysis] = [:]
    private(set) var assets: [String: AssetInfo] = [:]
    private(set) var order: [String] = []
    private(set) var errorMessage: String?

    /// Сколько последних фото разбирать. В первой версии ограничение, чтобы разбор шёл недолго.
    let scanLimit = 500

    let taxonomy: Taxonomy?
    private let analyzer: ImageAnalyzer?
    private let places = PlaceNamer()

    init() {
        var taxonomy: Taxonomy?
        var analyzer: ImageAnalyzer?
        var message: String?
        do {
            let loaded = try Taxonomy.loadFromBundle()
            taxonomy = loaded
            analyzer = try ImageAnalyzer(taxonomy: loaded)
        } catch {
            message = error.localizedDescription
        }
        self.taxonomy = taxonomy
        self.analyzer = analyzer
        self.errorMessage = message
        loadCache()
        refreshAccess()
    }

    // MARK: - Доступ к фото

    func refreshAccess() {
        access = Self.access(from: PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    func requestAccess() async {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        access = Self.access(from: status)
    }

    private static func access(from status: PHAuthorizationStatus) -> Access {
        switch status {
        case .authorized, .limited: return .granted
        case .notDetermined: return .unknown
        default: return .denied
        }
    }

    // MARK: - Группы

    var groups: [CategoryGroup] {
        guard let taxonomy else { return [] }
        var buckets: [String: [String]] = [:]
        for id in order {
            if let analysis = analyses[id] {
                buckets[analysis.effectiveCategoryID, default: []].append(id)
            }
        }
        let groups = taxonomy.allCategories
            .compactMap { category -> CategoryGroup? in
                guard let ids = buckets[category.id], !ids.isEmpty else { return nil }
                return CategoryGroup(category: category, photoIDs: sortedNewestFirst(ids))
            }
            .sorted { $0.photoIDs.count > $1.photoIDs.count }
        // «Прочее» всегда в конце
        return groups.filter { $0.id != Taxonomy.otherID } + groups.filter { $0.id == Taxonomy.otherID }
    }

    func group(id: String) -> CategoryGroup? {
        groups.first { $0.id == id }
    }

    private func sortedNewestFirst(_ ids: [String]) -> [String] {
        ids.sorted { a, b in
            switch (assets[a]?.creationDate, assets[b]?.creationDate) {
            case let (da?, db?): return da > db
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return a < b
            }
        }
    }

    func proposedName(for id: String) -> String? {
        guard let analysis = analyses[id] else { return nil }
        return Naming.proposedName(date: assets[id]?.creationDate, place: analysis.place, what: analysis.label)
    }

    func setCategory(_ categoryID: String, for id: String) {
        guard analyses[id] != nil else { return }
        analyses[id]?.userCategoryID = categoryID == analyses[id]?.autoCategoryID ? nil : categoryID
        saveCache()
    }

    // MARK: - Разбор галереи

    func scan() async {
        guard access == .granted, !isScanning, let taxonomy, let analyzer else { return }
        isScanning = true
        defer { isScanning = false }

        let fetched = PhotoLibrary.fetchRecentImages(limit: scanLimit)
        assets = Dictionary(fetched.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        order = fetched.map(\.id)

        let todo = fetched.filter { info in
            guard let analysis = analyses[info.id] else { return true }
            return analysis.assetModified != info.modificationDate
        }
        scanTotal = todo.count
        scannedCount = 0
        // На iOS 26 разбор не останавливается, если приложение свернуть
        let background = BackgroundScan(total: todo.count)
        defer { background?.finish() }

        for info in todo {
            if Task.isCancelled { break }
            if var analysis = await analyze(info, analyzer: analyzer, taxonomy: taxonomy) {
                analysis.userCategoryID = analyses[info.id]?.userCategoryID
                analyses[info.id] = analysis
            }
            scannedCount += 1
            background?.advance(to: scannedCount)
            if scannedCount % 25 == 0 { saveCache() }
        }
        saveCache()
    }

    private func analyze(_ info: AssetInfo, analyzer: ImageAnalyzer, taxonomy: Taxonomy) async -> PhotoAnalysis? {
        guard let asset = PhotoLibrary.asset(id: info.id),
              let image = await PhotoLibrary.image(for: asset, side: 1024),
              let cgImage = image.cgImage else { return nil }
        let orientation = CGImagePropertyOrientation(image.imageOrientation)

        let result = await Task.detached(priority: .userInitiated) { () -> (ImageAnalyzer.Output, [String])? in
            guard let output = try? analyzer.analyze(cgImage, orientation: orientation) else { return nil }
            let text = (try? TextReader.read(cgImage, orientation: orientation)) ?? []
            return (output, text)
        }.value
        guard let result else { return nil }
        let (output, text) = result

        // PhotoKit сам знает, что фото является скриншотом, модель тут не нужна.
        let categoryID = info.isScreenshot ? Taxonomy.screenshotsID : taxonomy.categories[output.categoryIndex].id
        var place: String?
        if let latitude = info.latitude, let longitude = info.longitude {
            place = await places.name(latitude: latitude, longitude: longitude)
        }
        return PhotoAnalysis(
            categoryID: categoryID,
            categoryConfidence: info.isScreenshot ? 1 : output.categoryConfidence,
            label: taxonomy.labels[output.labelIndex].ru,
            labelConfidence: output.labelConfidence,
            text: text,
            place: place,
            assetModified: info.modificationDate,
            userCategoryID: nil)
    }

    // MARK: - Альбомы

    nonisolated static func albumTitle(for category: Taxonomy.Category) -> String {
        "Сортировка: \(category.name)"
    }

    /// Создаёт по альбому на категорию или дополняет уже созданные. Фото не копируются и не удаляются.
    func createAlbums() async throws {
        let plan = groups.map { (title: Self.albumTitle(for: $0.category), photoIDs: $0.photoIDs) }
        let existing = PhotoLibrary.albums(titled: Set(plan.map(\.title)))
        try await PHPhotoLibrary.shared().performChanges {
            for item in plan {
                let photos = PHAsset.fetchAssets(withLocalIdentifiers: item.photoIDs, options: nil)
                if let album = existing[item.title] {
                    PHAssetCollectionChangeRequest(for: album)?.addAssets(photos)
                } else {
                    PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: item.title)
                        .addAssets(photos)
                }
            }
        }
    }

    // MARK: - Кеш

    private struct CacheFile: Codable {
        var taxonomyVersion: Int
        var analyses: [String: PhotoAnalysis]
    }

    private var cacheURL: URL? {
        try? FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("analyses.json")
    }

    private func loadCache() {
        guard let url = cacheURL, let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(CacheFile.self, from: data),
              file.taxonomyVersion == taxonomy?.version else { return }
        analyses = file.analyses
    }

    private func saveCache() {
        guard let url = cacheURL, let version = taxonomy?.version else { return }
        let file = CacheFile(taxonomyVersion: version, analyses: analyses)
        if let data = try? JSONEncoder().encode(file) {
            try? data.write(to: url, options: .atomic)
        }
    }
}
