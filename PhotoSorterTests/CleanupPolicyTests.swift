import XCTest
@testable import PhotoSorter

final class CleanupPolicyTests: XCTestCase {
    private func photo(_ id: String, hash: String? = "same", favorite: Bool = false, date: Date? = nil) -> CleanupPhoto {
        CleanupPhoto(id: id, date: date, modified: nil, isFavorite: favorite, filename: id, digest: hash)
    }

    func testDateBoundaryAndMissingDate() {
        XCTAssertFalse(CleanupPolicy.isOld(nil))
        XCTAssertFalse(CleanupPolicy.isOld(CleanupPolicy.cutoff))
        XCTAssertTrue(CleanupPolicy.isOld(CleanupPolicy.cutoff.addingTimeInterval(-1)))
    }

    func testNoDuplicateEvidenceForMissingHashesOrDifferentFiles() {
        XCTAssertTrue(CleanupPolicy.duplicates([photo("a", hash: nil), photo("b", hash: nil), photo("c", hash: "c"), photo("d", hash: "d")]).isEmpty)
    }

    func testFavoriteIsKeptEvenWhenNewer() {
        let photos = [photo("a", date: .distantPast), photo("b", favorite: true, date: .now), photo("c", favorite: true)]
        let groups = CleanupPolicy.duplicates(photos)
        XCTAssertEqual(groups.first?.keeperID, "b")
        XCTAssertEqual(CleanupPolicy.duplicateSelection(groups, photos: photos), ["a"])
    }

    func testDeterministicKeeperAndAtLeastOneSurvivor() {
        let photos = [photo("b"), photo("a"), photo("c")]
        let groups = CleanupPolicy.duplicates(photos)
        XCTAssertEqual(groups.first?.keeperID, "a")
        XCTAssertEqual(CleanupPolicy.duplicateSelection(groups, photos: photos), ["b", "c"])
        XCTAssertNotNil(CleanupPolicy.deletionProblem(selected: ["a", "b", "c"], photos: photos, groups: groups))
        XCTAssertNil(CleanupPolicy.deletionProblem(selected: ["b", "c"], photos: photos, groups: groups))
    }

    func testRejectsUnknownAndFavoriteIDs() {
        let photos = [photo("a", favorite: true), photo("b")]
        XCTAssertNotNil(CleanupPolicy.deletionProblem(selected: ["missing"], photos: photos, groups: []))
        XCTAssertNotNil(CleanupPolicy.deletionProblem(selected: ["a"], photos: photos, groups: []))
        XCTAssertNotNil(CleanupPolicy.deletionProblem(selected: [], photos: photos, groups: []))
    }

    func testAdvertisementNeedsTwoSignals() {
        XCTAssertTrue(CleanupPolicy.textHints(["Скидка на память о путешествии"]).isEmpty)
        XCTAssertEqual(CleanupPolicy.textHints(["СКИДКА 20%", "Заказать с доставкой"]), ["Возможно, реклама"])
    }

    func testBulkOldSelectionProtectsFavoritesAndLastCopy() {
        let photos = [photo("a"), photo("b"), photo("f", hash: nil, favorite: true), photo("old", hash: nil)]
        let result = CleanupPolicy.safeSelection(candidates: ["a", "b", "f", "old", "missing"],
                                                 groups: CleanupPolicy.duplicates(photos), photos: photos)
        XCTAssertEqual(result, ["b", "old"])
    }

    func testManualIsOnlyAHintNotAutomaticDeletion() {
        XCTAssertEqual(CleanupPolicy.textHints(["Руководство пользователя насоса"]), ["Возможно, инструкция"])
        XCTAssertTrue(CleanupPolicy.textHints(["Семейный праздник"]).isEmpty)
        XCTAssertTrue(CleanupPolicy.duplicateSelection([], photos: [photo("manual", hash: nil)]).isEmpty)
    }
}
