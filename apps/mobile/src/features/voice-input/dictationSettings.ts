import { useAtomSet } from "@effect/atom-react";
import {
  DEFAULT_DICTATION_SETTINGS,
  type DictationSettings,
} from "@t3tools/client-runtime/voice-input";
import { AsyncResult, Atom } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Defaults until preferences load. */
export const dictationSettingsAtom = Atom.make((get): DictationSettings => {
  const preferences = get(mobilePreferencesAtom);
  return (
    (AsyncResult.isSuccess(preferences) && preferences.value.dictation) ||
    DEFAULT_DICTATION_SETTINGS
  );
}).pipe(Atom.withLabel("mobile:dictation-settings"));

/** The one write path: transforms apply to the stored settings, so concurrent edits compose. */
export function useUpdateDictationSettings() {
  const save = useAtomSet(updateMobilePreferencesAtom);
  return (transform: (current: DictationSettings) => DictationSettings) =>
    save({
      transform: (preferences) => ({
        dictation: transform(preferences.dictation ?? DEFAULT_DICTATION_SETTINGS),
      }),
    });
}
