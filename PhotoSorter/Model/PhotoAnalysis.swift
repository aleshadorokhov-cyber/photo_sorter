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

    var effectiveCategoryID: String { userCategoryID ?? categoryID }
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
