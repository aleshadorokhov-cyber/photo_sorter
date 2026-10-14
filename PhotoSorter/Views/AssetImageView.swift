import SwiftUI

/// Картинка из галереи по идентификатору фото.
struct AssetImageView: View {
    let id: String
    var side: CGFloat = 120
    var contentMode: ContentMode = .fill

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.quaternary)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            }
        }
        .task(id: id) {
            image = await PhotoLibrary.image(id: id, side: side * displayScale)
        }
    }
}

/// Квадратная миниатюра для сеток.
struct SquareThumbnail: View {
    let id: String
    var side: CGFloat = 120

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay(AssetImageView(id: id, side: side))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}
