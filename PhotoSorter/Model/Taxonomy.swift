import Foundation

/// Категории и подписи «что на фото» из Resources/taxonomy.json.
/// Порядок элементов совпадает с порядком строк в categories.f32 и labels.f32.
struct Taxonomy: Decodable {
    struct Category: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let symbol: String
        let prompts: [String]
    }

    struct Label: Decodable, Hashable {
        let en: String
        let ru: String
    }

    let version: Int
    let categories: [Category]
    let labels: [Label]

    static let screenshotsID = "screenshots"
    static let otherID = "other"

    /// Сюда попадают фото, в категории которых модель не уверена
    static let other = Category(id: otherID, name: "Прочее", symbol: "tray", prompts: [])

    /// Категории модели и «Прочее» последним
    var allCategories: [Category] { categories + [Self.other] }

    func category(id: String) -> Category? {
        allCategories.first { $0.id == id }
    }

    static func loadFromBundle() throws -> Taxonomy {
        guard let url = Bundle.main.url(forResource: "taxonomy", withExtension: "json") else {
            throw AppError.missingResource("taxonomy.json")
        }
        return try JSONDecoder().decode(Taxonomy.self, from: Data(contentsOf: url))
    }
}

enum AppError: LocalizedError {
    case missingResource(String)
    case badResource(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let name): return "В приложении не найден файл \(name)."
        case .badResource(let name): return "Файл \(name) повреждён."
        }
    }
}

/// Нормированные эмбеддинги, записанные построчно (float32, little endian).
struct EmbeddingMatrix {
    let rows: Int
    let dim: Int
    private let values: [Float]

    init(resource: String, rows: Int, dim: Int = 512) throws {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "f32") else {
            throw AppError.missingResource("\(resource).f32")
        }
        let data = try Data(contentsOf: url)
        guard data.count == rows * dim * MemoryLayout<Float>.size else {
            throw AppError.badResource("\(resource).f32")
        }
        var values = [Float](repeating: 0, count: rows * dim)
        _ = values.withUnsafeMutableBytes { data.copyBytes(to: $0) }
        self.rows = rows
        self.dim = dim
        self.values = values
    }

    /// Вероятности по строкам: softmax от косинусной близости, умноженной на масштаб CLIP.
    func probabilities(for vector: [Float], scale: Float = 100) -> [Float] {
        precondition(vector.count == dim)
        var logits = [Float](repeating: 0, count: rows)
        for row in 0..<rows {
            let base = row * dim
            var sum: Float = 0
            for d in 0..<dim { sum += values[base + d] * vector[d] }
            logits[row] = sum * scale
        }
        let maxLogit = logits.max() ?? 0
        let exps = logits.map { expf($0 - maxLogit) }
        let total = exps.reduce(0, +)
        return exps.map { $0 / total }
    }
}
