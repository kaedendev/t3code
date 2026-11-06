import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  disk: "missing" as "missing" | "ready",
  progress: null as ((event: { fraction: number }) => void) | null,
  download: vi.fn<() => Promise<void>>(),
  delete: vi.fn(async () => {
    native.disk = "missing";
  }),
}));

vi.mock("@t3tools/mobile-parakeet", () => ({
  isParakeetSupported: () => true,
  getParakeetModelState: async () => native.disk,
  downloadParakeetModel: () => native.download(),
  deleteParakeetModel: () => native.delete(),
  addParakeetDownloadListener: (listener: (event: { fraction: number }) => void) => {
    native.progress = listener;
    return { remove: () => (native.progress = null) };
  },
}));
vi.mock("../../state/preferences", async () => {
  const { Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(null) };
});
vi.mock("./dictationSettings", async () => {
  const { Atom } = await import("effect/reactivity");
  return { dictationSettingsAtom: Atom.make(null) };
});
vi.mock("./localVoiceTranscriber", async () => {
  const { Atom } = await import("effect/reactivity");
  return { localVoiceTranscriberAtom: Atom.make(null) };
});

import { ParakeetModel, selectVoiceEngine, type ParakeetModelStatus } from "./parakeetModel";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup(disk: "missing" | "ready") {
  native.disk = disk;
  native.progress = null;
  native.download.mockReset();
  native.delete.mockClear();
  return new ParakeetModel();
}

describe("selectVoiceEngine", () => {
  const ready: ParakeetModelStatus = { kind: "ready" };
  it.each([
    { choice: "apple", parakeet: ready, apple: true, locale: "en-US", engine: "apple" },
    { choice: "parakeet", parakeet: ready, apple: true, locale: "en-US", engine: "parakeet" },
    { choice: "parakeet", parakeet: ready, apple: false, locale: "de_DE", engine: "parakeet" },
    { choice: "parakeet", parakeet: ready, apple: true, locale: "ja-JP", engine: "apple" },
    { choice: "parakeet", parakeet: ready, apple: false, locale: "zh-Hans-CN", engine: null },
    {
      choice: "parakeet",
      parakeet: { kind: "downloading", fraction: 0.4 },
      apple: true,
      locale: "en-US",
      engine: "apple",
    },
    { choice: "parakeet", parakeet: { kind: "missing" }, apple: false, locale: "en", engine: null },
    { choice: "apple", parakeet: ready, apple: false, locale: "en-US", engine: null },
  ] as const)(
    "$choice with Parakeet $parakeet.kind, Apple $apple, $locale -> $engine",
    ({ choice, parakeet, apple, locale, engine }) => {
      expect(selectVoiceEngine(choice, parakeet, apple, locale)).toBe(engine);
    },
  );
});

describe("ParakeetModel", () => {
  it("downloads when wanted, reports progress, and keeps the model when turned off", async () => {
    const model = setup("missing");
    const started = deferred();
    const finish = deferred();
    native.download.mockImplementation(() => {
      started.resolve();
      return finish.promise.then(() => {
        native.disk = "ready";
      });
    });

    const reconciled = model.reconcile(true);
    await started.promise;
    native.progress?.({ fraction: 0.42 });
    expect(model.status).toEqual({ kind: "downloading", fraction: 0.42 });
    // Turning Parakeet off mid-download neither cancels nor deletes.
    void model.reconcile(false);
    finish.resolve();
    await reconciled;
    expect(model.status).toEqual({ kind: "ready" });

    await model.reconcile(false);
    expect(model.status).toEqual({ kind: "ready" });
    expect(native.delete).not.toHaveBeenCalled();
  });

  it("stays failed until retried", async () => {
    const model = setup("missing");
    native.download.mockRejectedValueOnce(new Error("offline"));
    await model.reconcile(true);
    expect(model.status).toEqual({ kind: "failed", message: "offline" });

    await model.reconcile(false);
    expect(model.status).toEqual({ kind: "failed", message: "offline" });
    expect(native.download).toHaveBeenCalledTimes(1);

    native.download.mockImplementationOnce(async () => {
      native.disk = "ready";
    });
    await model.retry();
    expect(model.status).toEqual({ kind: "ready" });
  });

  it("removes the model while Parakeet is still chosen without downloading it again", async () => {
    const model = setup("ready");
    await model.reconcile(true);
    expect(model.status).toEqual({ kind: "ready" });

    await model.remove();
    expect(model.status).toEqual({ kind: "missing" });
    expect(native.delete).toHaveBeenCalledTimes(1);
    expect(native.download).not.toHaveBeenCalled();
  });
});
