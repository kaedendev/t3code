import {
  resolveDictationPipeline,
  withDictationPipeline,
  type DictationPipeline,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { AtomRegistry } from "effect/reactivity";

import { parakeetTranscriber } from "../../native/parakeetTranscription";
import { dictationSettingsAtom } from "./dictationSettings";
import { localVoiceTranscriberAtom } from "./localVoiceTranscriber";
import { voiceEngineAtom } from "./parakeetModel";
import { readRewriteKey } from "./rewriteKey";

async function loadDictationPipeline(
  registry: AtomRegistry.AtomRegistry,
): Promise<DictationPipeline> {
  const settings = registry.get(dictationSettingsAtom);
  const key = settings.rewrite.enabled
    ? await readRewriteKey().catch((error: unknown) => {
        console.warn("[dictation] could not read the rewrite key; skipping the rewrite", error);
        return null;
      })
    : null;
  return resolveDictationPipeline(settings, key);
}

/** The engine for the next dictation, wrapped in the user's cleanup and rewrite. */
export function resolveDictationTranscriber(
  registry: AtomRegistry.AtomRegistry,
): VoiceTranscriber | null {
  const engine = registry.get(voiceEngineAtom);
  const builtIn = registry.get(localVoiceTranscriberAtom);
  const base =
    engine === "parakeet"
      ? parakeetTranscriber
      : engine === "apple" && builtIn !== "checking"
        ? builtIn
        : null;
  return base && withDictationPipeline(base, () => loadDictationPipeline(registry));
}
