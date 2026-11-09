import Photos
import UIKit

/// Сведения о фото, которые нужны без загрузки самой картинки.
struct AssetInfo: Hashable {
    let id: String
    let creationDate: Date?
    let modificationDate: Date?
    let isScreenshot: Bool
    let latitude: Double?
    let longitude: Double?
}

/// Тонкая обёртка над PhotoKit.
enum PhotoLibrary {
    static func fetchRecentImages(limit: Int) -> [AssetInfo] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = limit
        var result: [AssetInfo] = []
        PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in
            result.append(AssetInfo(
                id: asset.localIdentifier,
                creationDate: asset.creationDate,
                modificationDate: asset.modificationDate,
                isScreenshot: asset.mediaSubtypes.contains(.photoScreenshot),
                latitude: asset.location?.coordinate.latitude,
                longitude: asset.location?.coordinate.longitude))
        }
        return result
    }

    static func asset(id: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
    }

    /// Картинка со стороной не больше `side` точек. Фото из iCloud при необходимости скачиваются.
    static func image(for asset: PHAsset, side: CGFloat, network: Bool = true) async -> UIImage? {
        let operation = PhotoImageOperation()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                operation.start(asset: asset, side: side, network: network, continuation: continuation)
            }
        } onCancel: { operation.cancel() }
    }

    static func image(id: String, side: CGFloat) async -> UIImage? {
        guard let asset = asset(id: id) else { return nil }
        return await image(for: asset, side: side)
    }

    static func albums(titled titles: Set<String>) -> [String: PHAssetCollection] {
        var result: [String: PHAssetCollection] = [:]
        PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
            .enumerateObjects { collection, _, _ in
                if let title = collection.localizedTitle, titles.contains(title), result[title] == nil {
                    result[title] = collection
                }
            }
        return result
    }
}

/// Cancels an in-flight iCloud/image request with its Swift task. PhotoKit may
/// deliver multiple callbacks, including one after cancelImageRequest.
private final class PhotoImageOperation: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<UIImage?, Never>?
    private var request: PHImageRequestID?
    private var cancelled = false
    private var finished = false

    func start(asset: PHAsset, side: CGFloat, network: Bool, continuation: CheckedContinuation<UIImage?, Never>) {
        lock.lock()
        if cancelled { lock.unlock(); continuation.resume(returning: nil); return }
        self.continuation = continuation
        lock.unlock()
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = network
        let id = PHImageManager.default().requestImage(for: asset,
            targetSize: CGSize(width: side, height: side), contentMode: .aspectFit, options: options) { [self] image, info in
            if (info?[PHImageCancelledKey] as? Bool) == true || info?[PHImageErrorKey] != nil {
                complete(nil)
            } else if (info?[PHImageResultIsDegradedKey] as? Bool) != true {
                complete(image)
            }
        }
        lock.lock()
        request = id
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { PHImageManager.default().cancelImageRequest(id) }
    }

    private func complete(_ image: UIImage?) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let callback = continuation
        continuation = nil
        let result = cancelled ? nil : image
        lock.unlock()
        callback?.resume(returning: result)
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let id = request
        lock.unlock()
        complete(nil)
        if let id { PHImageManager.default().cancelImageRequest(id) }
    }
}

extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
