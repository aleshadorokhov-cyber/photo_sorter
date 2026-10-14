import BackgroundTasks
import Foundation

/// Разбор галереи продолжается, когда приложение свернули (iOS 26 и новее):
/// система не усыпляет его и показывает ход разбора на экране блокировки.
/// На старых iOS ничего не делает: разбор, как раньше, ждёт, пока приложение откроют снова.
@MainActor
final class BackgroundScan {
    private static let title = "Разбираю фото"

    private let total: Int
    private var done = 0
    private var finished = false
    private var task: BGTask?

    init?(total: Int) {
        guard #available(iOS 26, *), total > 0, let bundleID = Bundle.main.bundleIdentifier else { return nil }
        self.total = total
        // Свой идентификатор на каждый разбор: так его можно зарегистрировать прямо перед запуском.
        // Он начинается с настоящего идентификатора приложения, даже если SideStore его поменял,
        // и подходит под шаблон из Info.plist (BGTaskSchedulerPermittedIdentifiers)
        let identifier = "\(bundleID).scan.\(UUID().uuidString)"
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
            MainActor.assumeIsolated {
                if let self { self.attach(task) } else { task.setTaskCompleted(success: true) }
            }
        }
        guard registered else { return nil }
        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier, title: Self.title, subtitle: Self.subtitle(done: 0, total: total))
        // Если системе сейчас некогда, разбор просто идёт, пока приложение открыто
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            return nil
        }
    }

    /// Сколько фото уже разобрано: система показывает это на экране блокировки
    func advance(to done: Int) {
        self.done = done
        report()
    }

    func finish() {
        finished = true
        complete(success: true)
    }

    private func attach(_ task: BGTask) {
        guard #available(iOS 26, *), let task = task as? BGContinuedProcessingTask, !finished else {
            task.setTaskCompleted(success: true)
            return
        }
        self.task = task
        // Отменили на экране блокировки или системе не хватило ресурсов. Свёрнутое приложение уснёт,
        // а разбор продолжится с того же места, когда его откроют: готовое сохраняется по ходу
        task.expirationHandler = { [weak self] in
            DispatchQueue.main.async { self?.complete(success: false) }
        }
        task.progress.totalUnitCount = Int64(total)
        report()
    }

    private func report() {
        guard #available(iOS 26, *), let task = task as? BGContinuedProcessingTask else { return }
        task.progress.completedUnitCount = Int64(done)
        task.updateTitle(Self.title, subtitle: Self.subtitle(done: done, total: total))
    }

    private func complete(success: Bool) {
        guard let task else { return }
        self.task = nil
        task.setTaskCompleted(success: success)
    }

    private static func subtitle(done: Int, total: Int) -> String {
        "\(done) из \(total) фото"
    }
}
