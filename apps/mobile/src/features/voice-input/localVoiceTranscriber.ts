import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { Atom } from "effect/reactivity";

import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);
