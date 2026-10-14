import SwiftUI

struct RootView: View {
    @Environment(LibraryStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch store.access {
            case .unknown: OnboardingView()
            case .denied: AccessDeniedView()
            case .granted: CategoriesView()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.refreshAccess() }
        }
    }
}

struct OnboardingView: View {
    @Environment(LibraryStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 48, weight: .semibold))
                .foregroundStyle(.tint)
            Text("Фото по полочкам")
                .font(.largeTitle.bold())
            VStack(alignment: .leading, spacing: 12) {
                Text("Приложение смотрит, что на фото, читает текст на снимках и раскладывает их по категориям, внутри от новых к старым.")
                Text("Всё работает прямо на телефоне: фото никуда не отправляются. Чтобы подписать город, приложение спрашивает у Apple Maps название места по координатам.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await store.requestAccess() }
            } label: {
                Text("Разрешить доступ к фото")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(24)
    }
}

struct AccessDeniedView: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        ContentUnavailableView {
            Label("Нет доступа к фото", systemImage: "photo.badge.exclamationmark")
        } description: {
            Text("Разрешите доступ в настройках, чтобы приложение могло разложить фото по категориям.")
        } actions: {
            Button("Открыть настройки") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
