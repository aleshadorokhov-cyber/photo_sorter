import SwiftUI

struct CategoryPhotosView: View {
    let categoryID: String
    @Environment(LibraryStore.self) private var store

    private let columns = [GridItem(.adaptive(minimum: 100), spacing: 4)]

    var body: some View {
        let group = store.group(id: categoryID)
        ScrollView {
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(group?.photoIDs ?? [], id: \.self) { id in
                    NavigationLink {
                        PhotoDetailView(id: id)
                    } label: {
                        SquareThumbnail(id: id)
                    }
                }
            }
            .padding(4)
        }
        .navigationTitle(group?.category.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
    }
}
