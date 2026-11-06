import type { RewriteRequest, VoiceVocabularyEntry } from "./dictation.ts";
import { throwIfVoiceTranscriptionAborted } from "./transcription.ts";

// Hex's PROTOCOL_PROMPT (src/dictation/processor.rs), verbatim.
const PROTOCOL_PROMPT =
  'You transform dictated speech into replacement text. Return only the text that should be pasted. Do not add an explanation, label, alternative, or Markdown fence.\n\nNumbers: keep every number the speaker said. Never drop, merge, reorder, round, or reinterpret a number, and never add thousands separators or other formatting to a number that the transcript already writes in digits.\n\nLists: unless the profile instructions say otherwise, when the speaker enumerates items (for example "point one ... point two ...", "first ... second ...", or "number one ... number two ..."), keep every item and write them as a numbered list, one item per line ("1. ...", "2. ..."), without the spoken cue words.';

export const REWRITE_TIMEOUT_MS = 15_000;

type RewriteMessage = { readonly role: "system" | "user"; readonly content: string };

function vocabularyLines(vocabulary: ReadonlyArray<VoiceVocabularyEntry>): string {
  if (vocabulary.length === 0) return "";
  const terms = vocabulary
    .map((entry) =>
      entry.soundsLike.length === 0
        ? entry.term
        : `${entry.term} (may be transcribed as ${entry.soundsLike.join(", ")})`,
    )
    .join("; ");
  return `Vocabulary (spell these exactly when the speaker means them): ${terms}\n\n`;
}

/** Hex's `prompt()`, split into chat roles and without its foreground-app and browser-host lines. */
export function buildRewriteMessages(
  transcript: string,
  instructions: string,
  vocabulary: ReadonlyArray<VoiceVocabularyEntry>,
): ReadonlyArray<RewriteMessage> {
  const system = `${PROTOCOL_PROMPT}\n\nProfile instructions:\n${instructions}\n\n${vocabularyLines(vocabulary)}`;
  return [
    { role: "system", content: system.trimEnd() },
    { role: "user", content: `Raw transcript:\n<transcript>\n${transcript}\n</transcript>` },
  ];
}

function readCompletionText(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("choices" in body)) return null;
  const { choices } = body;
  if (!Array.isArray(choices)) return null;
  const choice: unknown = choices[0];
  if (typeof choice !== "object" || choice === null || !("message" in choice)) return null;
  const { message } = choice;
  if (typeof message !== "object" || message === null || !("content" in message)) return null;
  return typeof message.content === "string" ? message.content.trim() : null;
}

/**
 * One OpenAI-compatible chat completion. Resolves with the trimmed reply; rejects on an HTTP
 * error, an unreadable or empty reply, or the timeout. The caller's abort rejects as `cancelled`.
 */
export async function rewriteTranscript(
  transcript: string,
  request: RewriteRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  // Linked by hand: Hermes may lack AbortSignal.any and AbortSignal.timeout.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  // @effect-diagnostics-next-line globalTimers:off - the voice-input pipeline is plain promises, outside an Effect runtime.
  const timer = setTimeout(abort, REWRITE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: buildRewriteMessages(transcript, request.instructions, request.vocabulary),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The rewrite provider answered HTTP ${response.status}.`);
    const text = readCompletionText(await response.json());
    throwIfVoiceTranscriptionAborted(signal);
    if (!text) throw new Error("The rewrite provider returned no text.");
    return text;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (controller.signal.aborted) {
      throw new Error(`The rewrite took longer than ${REWRITE_TIMEOUT_MS / 1000} s.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
