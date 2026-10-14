import SwiftUI

@main
struct PhotoSorterApp: App {
    @State private var store = LibraryStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
        }
    }
}
