import { CodedError, requireOptionalNativeModule, type EventSubscription } from "expo";

export type ParakeetModelState = "unsupported" | "missing" | "ready";

export type ParakeetErrorCode =
  | "ParakeetUnsupported"
  | "ParakeetModelMissing"
  | "ParakeetDownloadFailed"
  | "ParakeetLoadFailed"
  | "ParakeetTranscriptionFailed";

/**
 * The downloaded byte fraction, in whole percents. It reaches 1 when the files land; the download
 * promise resolves after Core ML compiles them, which can take several more seconds.
 */
export interface ParakeetDownloadProgressEvent {
  readonly fraction: number;
}

interface T3ParakeetNativeModule {
  addListener(
    eventName: "onDownloadProgress",
    listener: (event: ParakeetDownloadProgressEvent) => void,
  ): EventSubscription;
  getModelState(): Promise<"missing" | "ready">;
  downloadModel(): Promise<void>;
  deleteModel(): Promise<void>;
  prepare(): Promise<void>;
  transcribe(uri: string): Promise<string>;
}

const nativeParakeet = requireOptionalNativeModule<T3ParakeetNativeModule>("T3Parakeet");

function requireParakeet(): T3ParakeetNativeModule {
  if (!nativeParakeet) {
    throw new CodedError("ParakeetUnsupported", "Parakeet transcription is only available on iOS.");
  }
  return nativeParakeet;
}

export function isParakeetSupported(): boolean {
  return nativeParakeet !== null;
}

export async function getParakeetModelState(): Promise<ParakeetModelState> {
  return nativeParakeet ? nativeParakeet.getModelState() : "unsupported";
}

/** Idempotent; concurrent calls share one download. */
export async function downloadParakeetModel(): Promise<void> {
  return requireParakeet().downloadModel();
}

export function addParakeetDownloadListener(
  listener: (event: ParakeetDownloadProgressEvent) => void,
): { remove(): void } {
  return nativeParakeet?.addListener("onDownloadProgress", listener) ?? { remove() {} };
}

export async function deleteParakeetModel(): Promise<void> {
  return requireParakeet().deleteModel();
}

/** Loads the models once; rejects with `ParakeetModelMissing` before they are downloaded. */
export async function prepareParakeet(): Promise<void> {
  return requireParakeet().prepare();
}

/** Accepts a file:// URI or a path to any AVAudioFile-readable recording, such as AAC in .m4a. */
export async function transcribeParakeetFile(uri: string): Promise<string> {
  return requireParakeet().transcribe(uri);
}
