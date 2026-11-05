import {
  cleanTranscript,
  isNumbersOnly,
  type VoiceCleanupOptions,
  type VoiceReplacement,
} from "./cleanup.ts";
import { rewriteTranscript } from "./rewrite.ts";
import { throwIfVoiceTranscriptionAborted, type VoiceTranscriber } from "./transcription.ts";

export type VoiceEngineChoice = "apple" | "parakeet";

/** Hex's `VocabularyEntry`: a term plus spellings a transcript may show instead. */
export type VoiceVocabularyEntry = {
  readonly term: string;
  readonly soundsLike: ReadonlyArray<string>;
};

/** Everything the user configures for dictation, stored whole. */
export type DictationSettings = {
  /** What the user asked for; the engine a dictation uses also depends on the model and language. */
  readonly engine: VoiceEngineChoice;
  readonly cleanup: VoiceCleanupOptions;
  readonly vocabulary: ReadonlyArray<VoiceVocabularyEntry>;
  readonly rewrite: {
    readonly enabled: boolean;
    /** An OpenAI-compatible API root, such as https://api.openai.com/v1. */
    readonly baseUrl: string;
    readonly model: string;
    /** Hex's per-mode profile instructions; blank uses Hex's default. */
    readonly instructions: string;
  };
};

/** Hex's default dictation mode instructions. */
export const DEFAULT_REWRITE_INSTRUCTIONS =
  "Rewrite the transcript into clear, natural text while preserving the speaker's intended meaning.";

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  engine: "apple",
  cleanup: { spokenFormatting: false, spokenSymbols: false, fillerWords: false, replacements: [] },
  vocabulary: [],
  rewrite: { enabled: false, baseUrl: "https://api.openai.com/v1", model: "", instructions: "" },
};

const field = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null && key in raw
    ? (raw as Record<string, unknown>)[key]
    : undefined;
const bool = (raw: unknown, fallback: boolean) => (typeof raw === "boolean" ? raw : fallback);
const text = (raw: unknown, fallback: string) => (typeof raw === "string" ? raw : fallback);
const list = (raw: unknown): ReadonlyArray<unknown> => (Array.isArray(raw) ? raw : []);

/** Keeps each valid field of stored settings, defaults the rest, and drops malformed list rows. */
export function parseDictationSettings(raw: unknown): DictationSettings {
  const defaults = DEFAULT_DICTATION_SETTINGS;
  const engine = field(raw, "engine");
  const cleanup = field(raw, "cleanup");
  const rewrite = field(raw, "rewrite");
  return {
    engine: engine === "apple" || engine === "parakeet" ? engine : defaults.engine,
    cleanup: {
      spokenFormatting: bool(field(cleanup, "spokenFormatting"), defaults.cleanup.spokenFormatting),
      spokenSymbols: bool(field(cleanup, "spokenSymbols"), defaults.cleanup.spokenSymbols),
      fillerWords: bool(field(cleanup, "fillerWords"), defaults.cleanup.fillerWords),
      replacements: list(field(cleanup, "replacements")).flatMap((row): VoiceReplacement[] => {
        const find = field(row, "find");
        const replace = field(row, "replace");
        return typeof find === "string" && find.trim() !== "" && typeof replace === "string"
          ? [{ find, replace }]
          : [];
      }),
    },
    vocabulary: list(field(raw, "vocabulary")).flatMap((row): VoiceVocabularyEntry[] => {
      const term = field(row, "term");
      if (typeof term !== "string" || term.trim() === "") return [];
      const soundsLike = list(field(row, "soundsLike")).filter(
        (spelling): spelling is string => typeof spelling === "string" && spelling.trim() !== "",
      );
      return [{ term, soundsLike }];
    }),
    rewrite: {
      enabled: bool(field(rewrite, "enabled"), defaults.rewrite.enabled),
      baseUrl: text(field(rewrite, "baseUrl"), defaults.rewrite.baseUrl),
      model: text(field(rewrite, "model"), defaults.rewrite.model),
      instructions: text(field(rewrite, "instructions"), defaults.rewrite.instructions),
    },
  };
}

export type RewriteRequest = {
  /** `${baseUrl}/chat/completions` */
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly instructions: string;
  readonly vocabulary: ReadonlyArray<VoiceVocabularyEntry>;
};

/** What one dictation runs with, read when it starts; edits made meanwhile apply to the next one. */
export type DictationPipeline = {
  readonly cleanup: VoiceCleanupOptions;
  /** Null unless rewrite is on and its base URL, model, and key are all set. */
  readonly rewrite: RewriteRequest | null;
};

export function resolveDictationPipeline(
  settings: DictationSettings,
  apiKey: string | null,
): DictationPipeline {
  const baseUrl = settings.rewrite.baseUrl.trim().replace(/\/+$/, "");
  const model = settings.rewrite.model.trim();
  const key = apiKey?.trim() ?? "";
  return {
    cleanup: settings.cleanup,
    rewrite:
      settings.rewrite.enabled && baseUrl && model && key
        ? {
            endpoint: `${baseUrl}/chat/completions`,
            model,
            apiKey: key,
            instructions: settings.rewrite.instructions.trim() || DEFAULT_REWRITE_INSTRUCTIONS,
            vocabulary: settings.vocabulary,
          }
        : null,
  };
}

/** Hex's `process_cancellable`: cleanup, then the rewrite unless there is nothing to rewrite. */
export async function finishTranscript(
  raw: string,
  pipeline: DictationPipeline,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  const corrected = cleanTranscript(raw, pipeline.cleanup);
  if (!pipeline.rewrite || corrected.trim() === "" || isNumbersOnly(corrected)) return corrected;
  try {
    return await rewriteTranscript(corrected, pipeline.rewrite, signal, fetchImpl);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    // @effect-diagnostics-next-line globalConsole:off - the voice-input pipeline is plain promises, outside an Effect runtime.
    console.warn("[voice-input] AI rewrite failed; inserting the corrected transcript.", error);
    return corrected;
  }
}

/** The same transcriber, with each transcript run through the pipeline `loadPipeline` resolves. */
export function withDictationPipeline(
  engine: VoiceTranscriber,
  loadPipeline: () => Promise<DictationPipeline>,
  fetchImpl: typeof fetch = fetch,
): VoiceTranscriber {
  return {
    prepare: async (options) => {
      const [prepared, pipeline] = await Promise.all([engine.prepare(options), loadPipeline()]);
      return {
        locale: prepared.locale,
        transcribe: async (uri, transcribeOptions) =>
          finishTranscript(
            await prepared.transcribe(uri, transcribeOptions),
            pipeline,
            transcribeOptions.signal,
            fetchImpl,
          ),
      };
    },
  };
}
