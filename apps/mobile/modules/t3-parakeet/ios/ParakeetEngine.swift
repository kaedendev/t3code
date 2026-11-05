import FluidAudio
import Foundation
import os

enum ParakeetError: Error {
  case modelMissing
  case downloadFailed(Error)
  case loadFailed(Error)
  case transcriptionFailed(Error)
}

actor ParakeetEngine {
  // The default 6-bit encoder flips tokens on some windows (FluidAudio #760); Encoder_v2 is int8.
  private static let encoderPrecision = ParakeetEncoderPrecision.int8V2
  private static var modelDirectory: URL { AsrModels.defaultCacheDirectory(for: .v3) }

  private var downloading: Task<Void, Error>?
  private var loading: Task<AsrManager, Error>?
  private var lastTranscription: Task<String, Error>?

  // The files land before the download finishes compiling the models.
  var modelsReady: Bool {
    downloading == nil
      && AsrModels.modelsExist(at: Self.modelDirectory, version: .v3, encoderPrecision: Self.encoderPrecision)
  }

  /// `onProgress` receives the downloaded byte fraction in whole percents, ending at 1.
  func download(onProgress: @escaping @Sendable (Double) -> Void) async throws {
    let task =
      downloading
      ?? Task {
        let progress = WholePercentProgress(onProgress)
        try await AsrModels.download(version: .v3, encoderPrecision: Self.encoderPrecision) { update in
          // Repo downloads report bytes as 0-0.5 and spend 0.5-1 compiling.
          if case .downloading(_, let totalFiles) = update.phase, totalFiles > 0 {
            progress.report(update.fractionCompleted / 0.5)
          }
        }
        progress.report(1)
      }
    downloading = task
    defer { if downloading == task { downloading = nil } }
    do {
      try await task.value
    } catch {
      throw ParakeetError.downloadFailed(error)
    }
  }

  func prepare() async throws {
    _ = try await loadedManager()
  }

  func transcribe(_ url: URL) async throws -> String {
    let manager = try await loadedManager()
    let previous = lastTranscription
    let task = Task {
      _ = await previous?.result
      do {
        var decoderState = TdtDecoderState.make()
        return try await manager.transcribe(url, decoderState: &decoderState).text
      } catch {
        throw ParakeetError.transcriptionFailed(error)
      }
    }
    lastTranscription = task
    return try await task.value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func delete() async throws {
    downloading?.cancel()
    _ = await downloading?.result
    _ = await lastTranscription?.result
    if let manager = try? await loading?.value {
      await manager.cleanup()
    }
    downloading = nil
    loading = nil
    lastTranscription = nil
    if FileManager.default.fileExists(atPath: Self.modelDirectory.path) {
      try FileManager.default.removeItem(at: Self.modelDirectory)
    }
  }

  private func loadedManager() async throws -> AsrManager {
    if let loading {
      return try await loading.value
    }
    guard modelsReady else { throw ParakeetError.modelMissing }
    let task = Task {
      do {
        let models = try await AsrModels.load(
          from: Self.modelDirectory, version: .v3, encoderPrecision: Self.encoderPrecision)
        return AsrManager(config: .default, models: models)
      } catch {
        throw ParakeetError.loadFailed(error)
      }
    }
    loading = task
    do {
      return try await task.value
    } catch {
      if loading == task { loading = nil }
      throw error
    }
  }
}

private final class WholePercentProgress: Sendable {
  private let lastPercent = OSAllocatedUnfairLock(initialState: -1)
  private let emit: @Sendable (Double) -> Void

  init(_ emit: @escaping @Sendable (Double) -> Void) {
    self.emit = emit
  }

  func report(_ fraction: Double) {
    let percent = Int(min(max(fraction, 0), 1) * 100)
    lastPercent.withLock { lastPercent in
      guard percent > lastPercent else { return }
      lastPercent = percent
      emit(Double(percent) / 100)
    }
  }
}
