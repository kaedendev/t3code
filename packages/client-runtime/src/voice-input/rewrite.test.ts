import { describe, expect, it, vi } from "vite-plus/test";

import { buildRewriteMessages, rewriteTranscript } from "./rewrite.ts";

const PROTOCOL =
  'You transform dictated speech into replacement text. Return only the text that should be pasted. Do not add an explanation, label, alternative, or Markdown fence.\n\nNumbers: keep every number the speaker said. Never drop, merge, reorder, round, or reinterpret a number, and never add thousands separators or other formatting to a number that the transcript already writes in digits.\n\nLists: unless the profile instructions say otherwise, when the speaker enumerates items (for example "point one ... point two ...", "first ... second ...", or "number one ... number two ..."), keep every item and write them as a numbered list, one item per line ("1. ...", "2. ..."), without the spoken cue words.';

describe("buildRewriteMessages", () => {
  it.each([
    {
      name: "without vocabulary",
      vocabulary: [],
      system: `${PROTOCOL}\n\nProfile instructions:\nBe terse.`,
    },
    {
      name: "with vocabulary",
      vocabulary: [
        { term: "T3 Code", soundsLike: ["tee three code", "T three"] },
        { term: "Parakeet", soundsLike: [] },
      ],
      system: `${PROTOCOL}\n\nProfile instructions:\nBe terse.\n\nVocabulary (spell these exactly when the speaker means them): T3 Code (may be transcribed as tee three code, T three); Parakeet`,
    },
  ])("matches Hex's prompt text $name", ({ vocabulary, system }) => {
    expect(buildRewriteMessages("ship it", "Be terse.", vocabulary)).toEqual([
      { role: "system", content: system },
      { role: "user", content: "Raw transcript:\n<transcript>\nship it\n</transcript>" },
    ]);
  });
});

describe("rewriteTranscript", () => {
  it("posts one chat completion and returns the trimmed reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ message: { role: "assistant", content: "\nShip it.\n" } }] }),
    );
    const text = await rewriteTranscript(
      "ship it",
      {
        endpoint: "https://llm.test/v1/chat/completions",
        model: "small",
        apiKey: "sk-test",
        instructions: "Be terse.",
        vocabulary: [],
      },
      new AbortController().signal,
      fetchImpl,
    );

    expect(text).toBe("Ship it.");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://llm.test/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      model: "small",
      messages: buildRewriteMessages("ship it", "Be terse.", []),
    });
  });
});
