import Foundation

/// Результат разбора одного фото. Хранится в кеше, чтобы не разбирать фото повторно.
struct PhotoAnalysis: Codable, Hashable {
    var categoryID: String
    var categoryConfidence: Float
    var label: String
    var labelConfidence: Float
    var text: [String]
    var place: String?
    var assetModified: Date?
    /// Категория, которую человек выбрал вручную. Она важнее предложенной моделью.
    var userCategoryID: String?

    /// Если модель уверена меньше чем на 60%, фото идёт в «Прочее», а не в сомнительную категорию.
    /// Порог тот же, что в веб-версии: подобран на настоящих снимках
    static let doubtThreshold: Float = 0.6

    var isDoubtful: Bool { categoryConfidence < Self.doubtThreshold }
    var autoCategoryID: String { isDoubtful ? Taxonomy.otherID : categoryID }
    var effectiveCategoryID: String { userCategoryID ?? autoCategoryID }
}

enum Naming {
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Имя вида «2026-07-23 Пятигорск, Белка».
    static func proposedName(date: Date?, place: String?, what: String) -> String {
        var parts: [String] = []
        if let date { parts.append(dateFormatter.string(from: date)) }
        if let place, !place.isEmpty { parts.append(place + ",") }
        parts.append(what)
        return parts.joined(separator: " ")
    }
}
