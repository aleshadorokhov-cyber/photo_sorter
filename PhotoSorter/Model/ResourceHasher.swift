import CryptoKit
import Photos

/// Hashes the original in chunks, with bounded memory. Edited photos, bursts and
/// Live Photos are excluded: equality of their still image is not enough.
enum ResourceHasher {
    static func resource(for asset: PHAsset) -> PHAssetResource? {
        guard asset.mediaType == .image,
              !asset.mediaSubtypes.contains(.photoLive), asset.burstIdentifier == nil else { return nil }
        let resources = PHAssetResource.assetResources(for: asset)
        guard resources.count == 1, resources[0].type == .photo else { return nil }
        return resources[0]
    }

    static func hash(_ resource: PHAssetResource, network: Bool) async throws -> (String, Int64) {
        let operation = HashOperation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                operation.start(resource: resource, network: network, continuation: continuation)
            }
        } onCancel: { operation.cancel() }
    }
}

/// PhotoKit and Swift cancellation can finish concurrently. A lock protects both
/// the incremental digest and the exactly-once continuation.
private final class HashOperation: @unchecked Sendable {
    private let lock = NSLock()
    private var hasher = SHA256()
    private var size: Int64 = 0
    private var request: PHAssetResourceDataRequestID?
    private var continuation: CheckedContinuation<(String, Int64), Error>?
    private var cancelled = false
    private var completed = false

    func start(resource: PHAssetResource, network: Bool, continuation: CheckedContinuation<(String, Int64), Error>) {
        lock.lock()
        if cancelled {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = network
        let id = PHAssetResourceManager.default().requestData(for: resource, options: options) { [self] data in
            lock.lock()
            if !completed && !cancelled { hasher.update(data: data); size += Int64(data.count) }
            lock.unlock()
        } completionHandler: { [self] error in
            lock.lock()
            guard !completed else { lock.unlock(); return }
            completed = true
            let callback = self.continuation
            self.continuation = nil
            let result: Result<(String, Int64), Error>
            if cancelled { result = .failure(CancellationError()) }
            else if let error { result = .failure(error) }
            else if size == 0 { result = .failure(CocoaError(.fileReadUnknown)) }
            else { result = .success((hasher.finalize().map { String(format: "%02x", $0) }.joined(), size)) }
            lock.unlock()
            callback?.resume(with: result)
        }
        lock.lock()
        request = id
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { PHAssetResourceManager.default().cancelDataRequest(id) }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let id = request
        let callback = continuation
        continuation = nil
        completed = true
        lock.unlock()
        if let id { PHAssetResourceManager.default().cancelDataRequest(id) }
        callback?.resume(throwing: CancellationError())
    }
}
