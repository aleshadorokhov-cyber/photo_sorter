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
    static func image(for asset: PHAsset, side: CGFloat) async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: CGSize(width: side, height: side),
                contentMode: .aspectFit,
                options: options
            ) { image, info in
                // При highQualityFormat Photos вызывает обработчик один раз, но черновую картинку на всякий случай пропускаем.
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                continuation.resume(returning: image)
            }
        }
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
