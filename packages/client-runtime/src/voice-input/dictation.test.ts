import { describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_DICTATION_SETTINGS,
  DEFAULT_REWRITE_INSTRUCTIONS,
  finishTranscript,
  parseDictationSettings,
  resolveDictationPipeline,
  type DictationPipeline,
  type DictationSettings,
} from "./dictation.ts";
import { REWRITE_TIMEOUT_MS } from "./rewrite.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const REWRITE = {
  endpoint: "https://llm.test/v1/chat/completions",
  model: "small",
  apiKey: "sk-test",
  instructions: DEFAULT_REWRITE_INSTRUCTIONS,
  vocabulary: [],
} satisfies DictationPipeline["rewrite"];

const pipeline = (cleanup: Partial<DictationPipeline["cleanup"]> = {}): DictationPipeline => ({
  cleanup: { ...DEFAULT_DICTATION_SETTINGS.cleanup, ...cleanup },
  rewrite: REWRITE,
});

const reply = (content: unknown) => Response.json({ choices: [{ message: { content } }] });

/** Settles only when its request is aborted, like a provider that never answers. */
const unansweredFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

function sentTranscript(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as {
    messages: Array<{ content: string }>;
  };
  return body.messages[1]!.content;
}

describe("finishTranscript", () => {
  it("rewrites the cleaned transcript, not the raw one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => reply("  Ship it.  "));
    const text = await finishTranscript(
      "um, ship it",
      pipeline({ fillerWords: true, replacements: [{ find: "ship", replace: "Ship" }] }),
      new AbortController().signal,
      fetchImpl,
    );
    expect(text).toBe("Ship it.");
    expect(sentTranscript(fetchImpl)).toBe("Raw transcript:\n<transcript>\nShip it\n</transcript>");
  });

  it.each([
    { name: "numbers only", raw: "one two, three point five" },
    { name: "empty", raw: "  " },
  ])("skips the rewrite for a $name transcript", async ({ raw }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => reply("rewritten"));
    await expect(
      finishTranscript(raw, pipeline(), new AbortController().signal, fetchImpl),
    ).resolves.toBe(raw);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an HTTP error", fetchImpl: async () => new Response("nope", { status: 500 }) },
    { name: "a body without choices", fetchImpl: async () => Response.json({ error: "x" }) },
    { name: "a non-JSON body", fetchImpl: async () => new Response("<html>") },
    { name: "empty text", fetchImpl: async () => reply("   ") },
    { name: "non-string content", fetchImpl: async () => reply(null) },
    {
      name: "a network failure",
      fetchImpl: async (): Promise<Response> => {
        throw new TypeError("Network request failed");
      },
    },
  ])("falls back to the cleaned transcript on $name", async ({ fetchImpl }) => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      finishTranscript(
        "um, hello there",
        pipeline({ fillerWords: true }),
        new AbortController().signal,
        fetchImpl,
      ),
    ).resolves.toBe("hello there");
  });

  it("falls back once the rewrite times out", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const result = finishTranscript(
        "hello there",
        pipeline(),
        new AbortController().signal,
        unansweredFetch,
      );
      await vi.advanceTimersByTimeAsync(REWRITE_TIMEOUT_MS);
      await expect(result).resolves.toBe("hello there");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects as cancelled, without a fallback, when the caller aborts the rewrite", async () => {
    const controller = new AbortController();
    const result = finishTranscript("hello there", pipeline(), controller.signal, unansweredFetch);
    controller.abort();
    const error = await result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
  });
});

describe("parseDictationSettings", () => {
  it.each([
    { name: "nothing stored", raw: undefined, expected: DEFAULT_DICTATION_SETTINGS },
    { name: "a non-object", raw: "parakeet", expected: DEFAULT_DICTATION_SETTINGS },
    {
      name: "malformed rows among valid ones",
      raw: {
        engine: "parakeet",
        cleanup: {
          fillerWords: true,
          spokenSymbols: "yes",
          replacements: [
            { find: "tee three", replace: "T3" },
            { find: "", replace: "blank" },
            { find: "missing replace" },
            null,
          ],
        },
        vocabulary: [
          { term: "Parakeet", soundsLike: ["para keet", 4] },
          { term: "Hex" },
          { soundsLike: ["orphan"] },
        ],
        rewrite: { enabled: true, model: "gpt-mini", baseUrl: 7 },
      },
      expected: {
        engine: "parakeet",
        cleanup: {
          spokenFormatting: false,
          spokenSymbols: false,
          fillerWords: true,
          replacements: [{ find: "tee three", replace: "T3" }],
        },
        vocabulary: [
          { term: "Parakeet", soundsLike: ["para keet"] },
          { term: "Hex", soundsLike: [] },
        ],
        rewrite: {
          enabled: true,
          baseUrl: DEFAULT_DICTATION_SETTINGS.rewrite.baseUrl,
          model: "gpt-mini",
          instructions: "",
        },
      },
    },
    { name: "an unknown engine", raw: { engine: "whisper" }, expected: DEFAULT_DICTATION_SETTINGS },
  ])("keeps what is valid in $name", ({ raw, expected }) => {
    expect(parseDictationSettings(raw)).toEqual(expected);
  });
});

describe("resolveDictationPipeline", () => {
  const settings = (rewrite: Partial<DictationSettings["rewrite"]>): DictationSettings => ({
    ...DEFAULT_DICTATION_SETTINGS,
    vocabulary: [{ term: "T3", soundsLike: [] }],
    rewrite: {
      enabled: true,
      baseUrl: "https://openrouter.ai/api/v1/",
      model: " gpt-mini ",
      instructions: "",
      ...rewrite,
    },
  });

  it.each([
    { name: "rewrite is off", settings: settings({ enabled: false }), key: "sk" },
    { name: "there is no key", settings: settings({}), key: null },
    { name: "the key is blank", settings: settings({}), key: "  " },
    { name: "the model is blank", settings: settings({ model: " " }), key: "sk" },
    { name: "the base URL is blank", settings: settings({ baseUrl: "" }), key: "sk" },
  ])("has no rewrite when $name", ({ settings, key }) => {
    expect(resolveDictationPipeline(settings, key).rewrite).toBeNull();
  });

  it("builds the request once everything is set", () => {
    expect(resolveDictationPipeline(settings({}), " sk-live ").rewrite).toEqual({
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "gpt-mini",
      apiKey: "sk-live",
      instructions: DEFAULT_REWRITE_INSTRUCTIONS,
      vocabulary: [{ term: "T3", soundsLike: [] }],
    });
  });
});
