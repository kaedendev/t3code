import type { VoiceEngineChoice } from "@t3tools/client-runtime/voice-input";
import {
  addParakeetDownloadListener,
  deleteParakeetModel,
  downloadParakeetModel,
  getParakeetModelState,
  isParakeetSupported,
} from "@t3tools/mobile-parakeet";
import { AsyncResult, Atom } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { dictationSettingsAtom } from "./dictationSettings";
import { localVoiceTranscriberAtom } from "./localVoiceTranscriber";

export type ParakeetModelStatus =
  | { readonly kind: "unsupported" }
  | { readonly kind: "missing" }
  /** `fraction` is 0..1 in whole percents. */
  | { readonly kind: "downloading"; readonly fraction: number }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "deleting" };

/**
 * The only writer of Parakeet's files. Each pass reads the disk and acts on the one pending
 * request, so an app kill mid-download resumes on the next launch's `reconcile(true)`.
 * Nothing here deletes the model except an explicit `remove()`.
 */
export class ParakeetModel {
  status: ParakeetModelStatus = isParakeetSupported()
    ? { kind: "missing" }
    : { kind: "unsupported" };
  private request: "download" | "delete" | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Downloads when wanted and missing; turning it off only drops a download not yet started. */
  reconcile(wanted: boolean): Promise<void> {
    if (wanted) this.request = "download";
    else if (this.request === "download") this.request = null;
    return this.converge();
  }

  /** The way to download again after a failure or a removal. */
  retry(): Promise<void> {
    this.request = "download";
    if (this.status.kind === "failed") this.set({ kind: "missing" });
    return this.converge();
  }

  remove(): Promise<void> {
    this.request = "delete";
    return this.converge();
  }

  private set(status: ParakeetModelStatus) {
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private converge(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } catch (error) {
        console.warn("[parakeet] could not read or change the model files", error);
        // A failed delete would otherwise leave "Removing the model…" with no row to act on.
        await getParakeetModelState().then(
          (disk) => this.set({ kind: disk }),
          () => this.set({ kind: "failed", message: "Could not read the model files." }),
        );
      } finally {
        this.running = null;
      }
    };
    this.running = run();
    return this.running;
  }

  private async pass(): Promise<void> {
    for (;;) {
      const disk = await getParakeetModelState();
      if (disk === "unsupported") return this.set({ kind: "unsupported" });
      const request = this.request;
      this.request = null;
      if (request === "delete" && disk === "ready") {
        this.set({ kind: "deleting" });
        await deleteParakeetModel();
        continue;
      }
      if (request === "download" && disk === "missing") {
        this.set({ kind: "downloading", fraction: 0 });
        const progress = addParakeetDownloadListener(({ fraction }) => {
          if (this.status.kind === "downloading" && this.status.fraction !== fraction) {
            this.set({ kind: "downloading", fraction });
          }
        });
        try {
          await downloadParakeetModel();
        } catch (error) {
          return this.set({
            kind: "failed",
            message: error instanceof Error ? error.message : "The download failed.",
          });
        } finally {
          progress.remove();
        }
        continue;
      }
      if (disk === "missing" && this.status.kind === "failed") return;
      return this.set({ kind: disk });
    }
  }
}

const parakeetModel = new ParakeetModel();

/** Mounting it resumes an interrupted download for a user who chose Parakeet. */
export const parakeetModelAtom = Atom.make((get) => {
  get.addFinalizer(parakeetModel.subscribe(() => get.setSelf(parakeetModel.status)));
  let wanted: boolean | null = null;
  get.subscribe(
    mobilePreferencesAtom,
    (preferences) => {
      if (!AsyncResult.isSuccess(preferences)) return;
      const next = preferences.value.dictation?.engine === "parakeet";
      if (next === wanted) return;
      wanted = next;
      void parakeetModel.reconcile(next);
    },
    { immediate: true },
  );
  return parakeetModel.status;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:parakeet-model"));

export const retryParakeetDownload = () => void parakeetModel.retry();
export const removeParakeetModel = () => void parakeetModel.remove();

/** Parakeet TDT 0.6B v3's languages, from Hex's PARAKEET_V3_LANGUAGES. */
const PARAKEET_LANGUAGES = new Set([
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "es",
  "sv",
  "uk",
]);

export function parakeetSupportsLocale(locale: string): boolean {
  return PARAKEET_LANGUAGES.has(locale.split(/[-_]/)[0]!.toLowerCase());
}

/** Parakeet once its model is ready and it knows the device language; otherwise Apple, if present. */
export function selectVoiceEngine(
  choice: VoiceEngineChoice,
  parakeet: ParakeetModelStatus,
  appleAvailable: boolean,
  locale: string,
): "apple" | "parakeet" | null {
  if (choice === "parakeet" && parakeet.kind === "ready" && parakeetSupportsLocale(locale)) {
    return "parakeet";
  }
  return appleAvailable ? "apple" : null;
}

// "apple" is the platform's own engine: Apple's on iOS, Google's on Android.
export const voiceEngineAtom = Atom.make((get) => {
  const builtIn = get(localVoiceTranscriberAtom);
  return selectVoiceEngine(
    get(dictationSettingsAtom).engine,
    get(parakeetModelAtom),
    builtIn !== null && builtIn !== "checking",
    Intl.DateTimeFormat().resolvedOptions().locale,
  );
}).pipe(Atom.withLabel("mobile:voice-engine"));
