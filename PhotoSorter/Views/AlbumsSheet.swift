import SwiftUI

/// Подтверждение перед тем, как приложение создаст альбомы в «Фото».
struct AlbumsSheet: View {
    @Environment(LibraryStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Status: Equatable {
        case idle, working, done, failed(String)
    }

    @State private var status: Status = .idle

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(store.groups) { group in
                        LabeledContent(LibraryStore.albumTitle(for: group.category),
                                       value: photoCount(group.photoIDs.count))
                    }
                } footer: {
                    Text("Фото не копируются и не удаляются: альбом только ссылается на них. Если альбом уже есть, в него добавятся новые фото.")
                }

                Section {
                    switch status {
                    case .idle:
                        Button("Создать альбомы") { create() }
                    case .working:
                        HStack { ProgressView(); Text("Создаю альбомы…") }
                    case .done:
                        Label("Готово. Альбомы есть в приложении «Фото».", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    case .failed(let message):
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Button("Попробовать ещё раз") { create() }
                    }
                }
            }
            .navigationTitle("Альбомы")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(status == .done ? "Закрыть" : "Отмена") { dismiss() }
                }
            }
        }
    }

    private func create() {
        status = .working
        Task {
            do {
                try await store.createAlbums()
                status = .done
            } catch {
                status = .failed("Не получилось создать альбомы: \(error.localizedDescription)")
            }
        }
    }
}
