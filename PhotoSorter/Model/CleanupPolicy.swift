import Foundation

struct CleanupPhoto: Identifiable, Equatable {
    let id: String
    let date: Date?
    let modified: Date?
    let isFavorite: Bool
    let filename: String
    var digest: String?
    var bytes: Int64 = 0
    var textHints: [String] = []
}

struct DuplicateGroup: Identifiable {
    let id: String
    let photoIDs: [String]
    let keeperID: String
}

/// Suggestions never authorize deletion. Age is a filter, not a value judgement.
enum CleanupPolicy {
    static let cutoff = Date(timeIntervalSince1970: 1_577_836_800) // 2020-01-01 UTC

    static func isOld(_ date: Date?) -> Bool {
        guard let date else { return false }
        return date < cutoff
    }

    static func textHints(_ lines: [String]) -> [String] {
        let text = lines.joined(separator: " ").lowercased()
        let commerce = ["скидк", "распродаж", "промокод", "sale", "discount"].contains { text.contains($0) }
        let action = ["купить", "заказать", "доставка", "руб", "₽", "shop", "buy"].contains { text.contains($0) }
        let manual = ["инструкция по", "руководство пользователя", "user manual", "installation guide"].contains { text.contains($0) }
        var result: [String] = []
        if commerce && action { result.append("Возможно, реклама") }
        if manual { result.append("Возможно, инструкция") }
        return result
    }

    static func duplicates(_ photos: [CleanupPhoto]) -> [DuplicateGroup] {
        let buckets = Dictionary(grouping: photos.filter { $0.digest != nil }, by: { $0.digest! })
        return buckets.compactMap { digest, members -> DuplicateGroup? in
            guard members.count > 1 else { return nil }
            let sorted = members.sorted {
                if $0.isFavorite != $1.isFavorite { return $0.isFavorite }
                if $0.date != $1.date { return ($0.date ?? .distantFuture) < ($1.date ?? .distantFuture) }
                return $0.id < $1.id
            }
            return DuplicateGroup(id: digest, photoIDs: sorted.map(\.id), keeperID: sorted[0].id)
        }.sorted { $0.id < $1.id }
    }

    static func duplicateSelection(_ groups: [DuplicateGroup], photos: [CleanupPhoto]) -> Set<String> {
        let protected = Set(photos.filter(\.isFavorite).map(\.id))
        return Set(groups.flatMap { group in
            group.photoIDs.filter { $0 != group.keeperID && !protected.contains($0) }
        })
    }

    static func deletionProblem(selected: Set<String>, photos: [CleanupPhoto], groups: [DuplicateGroup]) -> String? {
        guard !selected.isEmpty else { return "Ничего не выбрано." }
        let known = Set(photos.map(\.id))
        guard selected.isSubset(of: known) else { return "Медиатека изменилась. Повторите проверку." }
        guard !photos.contains(where: { selected.contains($0.id) && $0.isFavorite }) else {
            return "Избранные фото защищены. Сначала снимите отметку избранного в приложении «Фото»."
        }
        guard !groups.contains(where: { Set($0.photoIDs).isSubset(of: selected) }) else {
            return "Оставьте хотя бы одно фото в каждой группе дублей."
        }
        return nil
    }
}
