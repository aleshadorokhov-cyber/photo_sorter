import SwiftUI

struct PhotoDetailView: View {
    let id: String
    @Environment(LibraryStore.self) private var store

    var body: some View {
        List {
            Section {
                AssetImageView(id: id, side: 900, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 240)
                    .listRowInsets(EdgeInsets())
            }

            if let analysis = store.analyses[id] {
                Section("Предложенное имя") {
                    Text(store.proposedName(for: id) ?? "")
                        .font(.headline)
                        .textSelection(.enabled)
                }

                Section("Что на фото") {
                    LabeledContent("Объект", value: analysis.label)
                    LabeledContent("Уверенность", value: percent(analysis.labelConfidence))
                    if let date = store.assets[id]?.creationDate {
                        LabeledContent("Снято", value: date.formatted(date: .long, time: .shortened))
                    }
                    if let place = analysis.place {
                        LabeledContent("Место", value: place)
                    }
                }

                Section {
                    Picker("Категория", selection: categoryBinding(analysis)) {
                        ForEach(store.taxonomy?.allCategories ?? []) { category in
                            Label(category.name, systemImage: category.symbol).tag(category.id)
                        }
                    }
                } header: {
                    Text("Категория")
                } footer: {
                    if analysis.userCategoryID != nil {
                        Text("Выбрана вручную.")
                    } else if analysis.isDoubtful {
                        Text("Модель сомневается: больше всего похоже на «\(store.taxonomy?.category(id: analysis.categoryID)?.name ?? analysis.categoryID)» (\(percent(analysis.categoryConfidence))). Выберите категорию сами.")
                    } else {
                        Text("Модель уверена на \(percent(analysis.categoryConfidence)). Можно выбрать другую.")
                    }
                }

                if !analysis.text.isEmpty {
                    Section("Текст на фото") {
                        Text(analysis.text.joined(separator: "\n"))
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func categoryBinding(_ analysis: PhotoAnalysis) -> Binding<String> {
        Binding(
            get: { store.analyses[id]?.effectiveCategoryID ?? analysis.effectiveCategoryID },
            set: { store.setCategory($0, for: id) })
    }

    private func percent(_ value: Float) -> String {
        "\(Int((value * 100).rounded())) %"
    }
}
