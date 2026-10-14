import CoreLocation

/// Название города по координатам фото. Запрос уходит в Apple Maps, сами фото не отправляются.
/// Ответы кешируются по координатам, округлённым примерно до километра.
@MainActor
final class PlaceNamer {
    private let geocoder = CLGeocoder()
    private let defaultsKey = "placeNames.v1"
    private var cache: [String: String]

    init() {
        cache = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }

    func name(latitude: Double, longitude: Double) async -> String? {
        let key = String(format: "%.2f,%.2f", latitude, longitude)
        if let cached = cache[key] { return cached.isEmpty ? nil : cached }
        do {
            let placemarks = try await geocoder.reverseGeocodeLocation(
                CLLocation(latitude: latitude, longitude: longitude),
                preferredLocale: Locale(identifier: "ru_RU"))
            let mark = placemarks.first
            let name = mark?.locality ?? mark?.subAdministrativeArea ?? mark?.administrativeArea ?? ""
            cache[key] = name
            UserDefaults.standard.set(cache, forKey: defaultsKey)
            return name.isEmpty ? nil : name
        } catch {
            // Нет сети или слишком частые запросы: в кеш не пишем, попробуем при следующем разборе.
            return nil
        }
    }
}
