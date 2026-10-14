import CoreGraphics
import Vision

/// Читает текст на фото встроенным распознаванием Apple (русский и английский).
enum TextReader {
    static func read(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["ru-RU", "en-US"]
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image, orientation: orientation).perform([request])
        return (request.results ?? [])
            .compactMap { $0.topCandidates(1).first }
            .filter { $0.confidence >= 0.5 }
            .map(\.string)
    }
}
