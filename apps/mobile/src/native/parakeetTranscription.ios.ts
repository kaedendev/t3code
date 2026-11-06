import { prepareParakeet, transcribeParakeetFile } from "@t3tools/mobile-parakeet";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function transcribe(uri: string, { signal }: VoiceTranscriptionOptions): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  try {
    const text = await transcribeParakeetFile(uri);
    throwIfVoiceTranscriptionAborted(signal);
    return text.trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (error instanceof VoiceTranscriptionError) throw error;
    throw new VoiceTranscriptionError("transcription-failed", "Voice transcription failed.", {
      cause: error,
    });
  }
}

export const parakeetTranscriber: VoiceTranscriber | null = {
  prepare: async ({ signal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    try {
      await prepareParakeet();
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      if (nativeErrorCode(error) === "ParakeetModelMissing") {
        throw new VoiceTranscriptionError("unavailable", "The Parakeet model is not downloaded.", {
          cause: error,
        });
      }
      throw new VoiceTranscriptionError("preparation-failed", "Parakeet could not load.", {
        cause: error,
      });
    }
    throwIfVoiceTranscriptionAborted(signal);
    // Parakeet detects the spoken language itself; the locale only shapes how text is inserted.
    return { locale: Intl.DateTimeFormat().resolvedOptions().locale, transcribe };
  },
};
