import SwiftUI
import Photos

struct CleanupView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(\.scenePhase) private var phase
    @Environment(\.openURL) private var openURL
    @State private var store = CleanupStore()
    @State private var showReview = false
    @State private var filter: Filter = .duplicates

    private enum Filter: String, CaseIterable {
        case duplicates = "Дубли", old = "До 2020", text = "Реклама / инструкции"
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Освободите место осознанно", systemImage: "photo.stack")
                            .font(.title2.bold())
                        Text("Проверьте находки и выберите лишнее. Избранные фото защищены.")
                            .foregroundStyle(.secondary)
                    }.padding(.vertical, 6)
                    if store.isLimited {
                        Label("Видны только разрешённые вами фото", systemImage: "lock.shield")
                        Button("Изменить доступ в настройках") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                    Toggle("Загружать оригиналы из iCloud", isOn: $store.allowCloudDownload)
                        .disabled(store.running || store.deleting)
                    Toggle("Искать рекламу и инструкции по тексту", isOn: $store.readText)
                        .disabled(store.running || store.deleting)
                } footer: {
                    Text("Очистка проверяет все доступные фото, без ограничения в 500 снимков. Скрытые фото, видео и приложение «Файлы» сюда не входят. Распознавание работает на iPhone. iCloud может расходовать трафик.")
                }

                Section {
                    if store.running {
                        ProgressView(value: Double(store.scanned), total: Double(max(store.total, 1)))
                        Text("Проверено \(store.scanned) из \(store.total)")
                            .monospacedDigit()
                        Button("Остановить проверку", role: .cancel) { store.stop() }
                        Text("Оставьте приложение открытым. После остановки или ухода в фон удаление блокируется до новой проверки.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Button {
                            store.start(cached: library.analyses)
                        } label: {
                            Label(store.photos.isEmpty ? "Проверить фото" : "Проверить заново", systemImage: "magnifyingglass")
                                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
                        }.disabled(store.deleting || library.isScanning)
                        if library.isScanning { Text("Дождитесь завершения сортировки по категориям.").font(.footnote) }
                    }
                    if let message = store.message {
                        Text(message).font(.callout).foregroundStyle(.secondary)
                    }
                }

                if !store.running && !store.photos.isEmpty {
                    Section("Найдено") {
                        LabeledContent("Групп точных дублей", value: String(store.groups.count))
                        LabeledContent("Снято до 2020 года", value: String(store.old.count))
                        LabeledContent("Реклама / инструкции — проверить", value: String(store.textCandidates.count))
                        if store.skippedHashes > 0 {
                            Text("Не сравнены по содержимому: \(store.skippedHashes). Сюда входят Live Photos, серии, отредактированные или недоступные оригиналы.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if store.unreadText > 0 {
                            Text("Не удалось прочитать текст: \(store.unreadText). Это не означает, что снимки ненужные.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Picker("Показать", selection: $filter) {
                            ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                    }
                    results
                }
            }
            .navigationTitle("Очистка фото")
            .safeAreaInset(edge: .bottom) {
                if !store.selected.isEmpty {
                    Button {
                        showReview = true
                    } label: {
                        Label("Проверить выбранные: \(store.selected.count)", systemImage: "checklist")
                            .font(.headline).frame(maxWidth: .infinity).padding(10)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.valid || store.running || store.deleting)
                    .padding().background(.bar)
                }
            }
            .sheet(isPresented: $showReview) { CleanupReviewView(store: store) }
            .onChange(of: phase) { _, phase in
                // An inactive system confirmation is not the same as background.
                if phase == .background { store.invalidateAfterBackground() }
            }
        }
    }

    @ViewBuilder private var results: some View {
        switch filter {
        case .duplicates:
            Section {
                Button("Выбрать лишние копии") { store.selectDuplicateCopies() }
                    .disabled(!store.valid || store.groups.isEmpty)
            } footer: {
                Text("Сравниваются исходные файлы. В каждой группе остаётся минимум одно фото; избранные сохраняются. Дата и альбомы у копий могут различаться — проверьте их перед удалением.")
            }
            ForEach(Array(store.groups.enumerated()), id: \.element.id) { index, group in
                Section("Группа \(index + 1) · \(group.photoIDs.count) фото") {
                    ForEach(group.photoIDs, id: \.self) { id in
                        if let photo = store.photoIndex[id] {
                            CleanupRow(photo: photo, store: store, detail: id == group.keeperID ? "Предлагаем сохранить" : "Точный дубль")
                        }
                    }
                }
            }
        case .old:
            Section {
                Button("Выбрать старые фото для просмотра") { store.selectOldPhotos() }
                    .disabled(!store.valid || store.old.isEmpty)
                ForEach(store.old) { CleanupRow(photo: $0, store: store, detail: "Дата съёмки до 01.01.2020") }
            } footer: {
                Text("Возраст не означает, что фото лишнее. Избранные и минимум одна копия из группы дублей сохраняются. Снимки без даты не попадают в подборку. Граница — 1 января 2020 года, UTC.")
            }
        case .text:
            Section {
                ForEach(store.textCandidates) { CleanupRow(photo: $0, store: store, detail: $0.textHints.joined(separator: ", ")) }
            } footer: {
                Text("Подсказки основаны на словах в тексте. Они могут ошибаться и не определяют актуальность инструкции или ценность документа.")
            }
        }
    }
}

private struct CleanupRow: View {
    let photo: CleanupPhoto
    let store: CleanupStore
    let detail: String
    @State private var preview = false

    var body: some View {
        HStack(spacing: 12) {
            Button { preview = true } label: {
                SquareThumbnail(id: photo.id, side: 72).frame(width: 72, height: 72)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Открыть фото \(photo.filename)")
            VStack(alignment: .leading, spacing: 4) {
                Text(photo.filename).font(.headline).lineLimit(1)
                Text(photo.date?.formatted(date: .abbreviated, time: .omitted) ?? "Дата неизвестна")
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(detail).font(.caption).foregroundStyle(.secondary)
                if photo.isFavorite { Label("Избранное защищено", systemImage: "heart.fill").font(.caption) }
            }
            Spacer(minLength: 0)
            Button { store.toggle(photo) } label: {
                Image(systemName: store.selected.contains(photo.id) ? "checkmark.circle.fill" : "circle")
                    .font(.title2).frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .disabled(photo.isFavorite || !store.valid || store.deleting)
            .accessibilityLabel(store.selected.contains(photo.id) ? "Убрать из выбранных" : "Выбрать для удаления")
        }
        .sheet(isPresented: $preview) {
            NavigationStack {
                AssetImageView(id: photo.id, side: 1600, contentMode: .fit)
                    .navigationTitle(photo.filename).navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button("Готово") { preview = false } }
            }
        }
    }
}

private struct CleanupReviewView: View {
    let store: CleanupStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Выбрано фото: \(store.selected.count)").font(.title2.bold())
                    Text("Удаление затронет медиатеку «Фото». При включённых Фото iCloud изменения синхронизируются с другими устройствами. Снимки попадут в «Недавно удалённые»; место может освободиться не сразу.")
                }
                Section("Проверьте каждое фото") {
                    ForEach(store.selectedPhotos) { CleanupRow(photo: $0, store: store, detail: "Будет удалено из медиатеки") }
                }
                if let problem = CleanupPolicy.deletionProblem(selected: store.selected, photos: store.photos, groups: store.groups) {
                    Text(problem).foregroundStyle(.secondary)
                }
                Section {
                    Button("Удалить выбранные фото", role: .destructive) { confirm = true }
                        .disabled(!canDelete)
                    Button("Снять весь выбор") { store.clearSelection(); dismiss() }
                        .disabled(store.deleting)
                }
            }
            .navigationTitle("Перед удалением")
            .toolbar { Button("Закрыть") { dismiss() }.disabled(store.deleting) }
            .interactiveDismissDisabled(store.deleting)
            .confirmationDialog("Удалить фото: \(store.selected.count)?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Продолжить удаление", role: .destructive) {
                    Task { await store.deleteReviewed(); dismiss() }
                }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("После этого iOS попросит подтвердить изменение медиатеки.")
            }
            .overlay { if store.deleting { ProgressView("Удаление…").padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
        }
    }

    private var canDelete: Bool {
        store.valid && !store.deleting &&
        CleanupPolicy.deletionProblem(selected: store.selected, photos: store.photos, groups: store.groups) == nil
    }
}
