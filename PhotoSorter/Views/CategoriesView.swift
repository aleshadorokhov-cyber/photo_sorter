import SwiftUI

struct CategoriesView: View {
    @Environment(LibraryStore.self) private var store
    @State private var showAlbums = false

    var body: some View {
        NavigationStack {
            List {
                if let message = store.errorMessage {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                if store.isScanning {
                    Section {
                        ScanProgressRow(done: store.scannedCount, total: store.scanTotal)
                    }
                }
                Section {
                    ForEach(store.groups) { group in
                        NavigationLink(value: group.id) {
                            CategoryRow(group: group)
                        }
                    }
                } footer: {
                    if !store.groups.isEmpty {
                        Text("Разобраны последние \(store.scanLimit) фото или меньше. Внутри категорий фото идут от новых к старым.")
                    }
                }
            }
            .overlay {
                if store.groups.isEmpty && !store.isScanning && store.errorMessage == nil {
                    ContentUnavailableView("Пока пусто", systemImage: "photo.on.rectangle",
                                           description: Text("Потяните список вниз, чтобы разобрать фото."))
                }
            }
            .navigationTitle("Категории")
            .navigationDestination(for: String.self) { id in
                CategoryPhotosView(categoryID: id)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("В альбомы") { showAlbums = true }
                        .disabled(store.groups.isEmpty || store.isScanning)
                }
            }
            .refreshable { await store.scan() }
            .task { await store.scan() }
            .sheet(isPresented: $showAlbums) {
                AlbumsSheet()
            }
        }
    }
}

private struct ScanProgressRow: View {
    let done: Int
    let total: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(total == 0 ? "Ищу новые фото…" : "Разбираю фото: \(done) из \(total)")
                .font(.subheadline)
            ProgressView(value: Double(done), total: Double(max(total, 1)))
        }
        .padding(.vertical, 4)
    }
}

private struct CategoryRow: View {
    let group: CategoryGroup

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: group.category.symbol)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(group.category.name)
                    .font(.body.weight(.medium))
                Text(photoCount(group.photoIDs.count))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                ForEach(group.photoIDs.prefix(3), id: \.self) { id in
                    SquareThumbnail(id: id, side: 44)
                        .frame(width: 44, height: 44)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// «1 фото», «5 фото»: слово «фото» не склоняется, но число нужно показывать всегда.
func photoCount(_ count: Int) -> String {
    "\(count) фото"
}
