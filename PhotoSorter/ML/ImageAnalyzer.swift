import CoreGraphics
import CoreML
import Vision

/// Определяет категорию фото и что на нём изображено с помощью CLIP.
/// Модель кодирует картинку, а тексты категорий и подписей закодированы заранее (ml/export_models.py).
final class ImageAnalyzer: @unchecked Sendable {
    struct Output {
        let categoryIndex: Int
        let categoryConfidence: Float
        let labelIndex: Int
        let labelConfidence: Float
    }

    private let model: VNCoreMLModel
    private let categories: EmbeddingMatrix
    private let labels: EmbeddingMatrix

    init(taxonomy: Taxonomy) throws {
        guard let url = Bundle.main.url(forResource: "ImageEncoder", withExtension: "mlmodelc") else {
            throw AppError.missingResource("ImageEncoder.mlmodelc")
        }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        model = try VNCoreMLModel(for: MLModel(contentsOf: url, configuration: configuration))
        categories = try EmbeddingMatrix(resource: "categories", rows: taxonomy.categories.count)
        labels = try EmbeddingMatrix(resource: "labels", rows: taxonomy.labels.count)
    }

    func analyze(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> Output {
        let vector = try embedding(for: image, orientation: orientation)
        let (category, categoryConfidence) = Self.best(categories.probabilities(for: vector))
        let (label, labelConfidence) = Self.best(labels.probabilities(for: vector))
        return Output(categoryIndex: category, categoryConfidence: categoryConfidence,
                      labelIndex: label, labelConfidence: labelConfidence)
    }

    /// Нормированный эмбеддинг картинки (512 чисел). Открыт для теста PhotoSorterTests.
    func embedding(for image: CGImage, orientation: CGImagePropertyOrientation) throws -> [Float] {
        let request = VNCoreMLRequest(model: model)
        // Как в CLIP: короткая сторона приводится к 224 точкам, лишнее обрезается по краям.
        request.imageCropAndScaleOption = .centerCrop
        try VNImageRequestHandler(cgImage: image, orientation: orientation).perform([request])
        guard let observation = request.results?.first as? VNCoreMLFeatureValueObservation,
              let array = observation.featureValue.multiArrayValue else {
            throw AppError.badResource("ImageEncoder")
        }
        return (0..<array.count).map { Float(truncating: array[$0]) }
    }

    private static func best(_ probabilities: [Float]) -> (Int, Float) {
        var index = 0
        for i in probabilities.indices where probabilities[i] > probabilities[index] { index = i }
        return (index, probabilities[index])
    }
}
