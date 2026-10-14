import CoreGraphics
import XCTest
@testable import PhotoSorter

/// Сравнивает эмбеддинг из Core ML с эмбеддингом, который посчитал PyTorch (ml/export_models.py).
/// Если конвертация испортила нормализацию, порядок цветов или веса, близость сильно упадёт.
final class ImageEncoderTests: XCTestCase {
    func testCoreMLMatchesPyTorch() throws {
        let analyzer = try ImageAnalyzer(taxonomy: Taxonomy.loadFromBundle())
        let vector = try analyzer.embedding(for: Self.referenceImage(), orientation: .up)
        let reference = try Self.referenceEmbedding()
        XCTAssertEqual(vector.count, reference.count)

        let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
        let cosine = zip(vector, reference).reduce(0) { $0 + $1.0 * $1.1 } / norm
        print("Близость Core ML и PyTorch: \(cosine)")
        XCTAssertEqual(norm, 1, accuracy: 0.01)
        XCTAssertGreaterThan(cosine, 0.97)
    }

    /// Та же картинка, что reference_image() в ml/export_models.py: R = x, G = y, B = (x + y) / 2.
    static func referenceImage(side: Int = 224) -> CGImage {
        var pixels = [UInt8](repeating: 255, count: side * side * 4)
        for y in 0..<side {
            for x in 0..<side {
                let i = (y * side + x) * 4
                pixels[i] = UInt8(x)
                pixels[i + 1] = UInt8(y)
                pixels[i + 2] = UInt8((x + y) / 2)
            }
        }
        return CGImage(
            width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: CGDataProvider(data: Data(pixels) as CFData)!,
            decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }

    static func referenceEmbedding() throws -> [Float] {
        let bundle = Bundle(for: ImageEncoderTests.self)
        let url = try XCTUnwrap(bundle.url(forResource: "reference", withExtension: "f32"))
        let data = try Data(contentsOf: url)
        var values = [Float](repeating: 0, count: data.count / MemoryLayout<Float>.size)
        _ = values.withUnsafeMutableBytes { data.copyBytes(to: $0) }
        return values
    }
}
