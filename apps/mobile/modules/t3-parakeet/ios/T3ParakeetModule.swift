import ExpoModulesCore

public final class T3ParakeetModule: Module {
  private let engine = ParakeetEngine()

  public func definition() -> ModuleDefinition {
    Name("T3Parakeet")

    Events("onDownloadProgress")

    AsyncFunction("getModelState") { [engine] () async -> String in
      await engine.modelsReady ? "ready" : "missing"
    }

    AsyncFunction("downloadModel") { [weak self, engine] () async throws in
      try await mapErrors {
        try await engine.download { [weak self] fraction in
          self?.sendEvent("onDownloadProgress", ["fraction": fraction])
        }
      }
    }

    AsyncFunction("deleteModel") { [engine] () async throws in
      try await engine.delete()
    }

    AsyncFunction("prepare") { [engine] () async throws in
      try await mapErrors { try await engine.prepare() }
    }

    AsyncFunction("transcribe") { [engine] (uri: String) async throws -> String in
      try await mapErrors { try await engine.transcribe(fileURL(uri)) }
    }
  }
}

private func fileURL(_ uri: String) -> URL {
  if let url = URL(string: uri), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: uri)
}

private func mapErrors<T>(_ body: () async throws -> T) async throws -> T {
  do {
    return try await body()
  } catch let error as ParakeetError {
    switch error {
    case .modelMissing:
      throw parakeetException("ParakeetModelMissing", "The Parakeet model has not been downloaded.")
    case .downloadFailed(let cause):
      throw parakeetException("ParakeetDownloadFailed", "Could not download the Parakeet model.").causedBy(cause)
    case .loadFailed(let cause):
      throw parakeetException("ParakeetLoadFailed", "Could not load the Parakeet model.").causedBy(cause)
    case .transcriptionFailed(let cause):
      throw parakeetException("ParakeetTranscriptionFailed", "Could not transcribe the recording.").causedBy(cause)
    }
  }
}

private func parakeetException(_ code: String, _ description: String) -> Exception {
  Exception(name: code, description: description, code: code)
}
