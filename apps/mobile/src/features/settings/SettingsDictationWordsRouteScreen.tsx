import { useAtomValue } from "@effect/atom-react";
import type { DictationSettings } from "@t3tools/client-runtime/voice-input";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  dictationSettingsAtom,
  useUpdateDictationSettings,
} from "../voice-input/dictationSettings";
import { SettingsSection } from "./components/SettingsSection";

const INPUT_CLASS = "min-h-10 rounded-xl px-3 py-2 text-base text-foreground";
const sameWords = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function confirmRemove(name: string, onConfirm: () => void) {
  Dialog.confirm({
    title: `Remove “${name}”?`,
    confirmText: "Remove",
    destructive: true,
    onConfirm,
  });
}

export function SettingsDictationWordsRouteScreen() {
  const insets = useSafeAreaInsets();
  const dictation = useAtomValue(dictationSettingsAtom);
  const update = useUpdateDictationSettings();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [term, setTerm] = useState("");
  const [soundsLike, setSoundsLike] = useState("");

  const setReplacements = (
    next: (
      current: DictationSettings["cleanup"]["replacements"],
    ) => DictationSettings["cleanup"]["replacements"],
  ) =>
    update((current) => ({
      ...current,
      cleanup: { ...current.cleanup, replacements: next(current.cleanup.replacements) },
    }));
  const setVocabulary = (
    next: (current: DictationSettings["vocabulary"]) => DictationSettings["vocabulary"],
  ) => update((current) => ({ ...current, vocabulary: next(current.vocabulary) }));

  const addReplacement = () => {
    const entry = { find: find.trim(), replace: replace.trim() };
    setReplacements((current) => [
      ...current.filter((existing) => !sameWords(existing.find, entry.find)),
      entry,
    ]);
    setFind("");
    setReplace("");
  };
  const addTerm = () => {
    const entry = {
      term: term.trim(),
      soundsLike: soundsLike
        .split(",")
        .map((spelling) => spelling.trim())
        .filter(Boolean),
    };
    setVocabulary((current) => [
      ...current.filter((existing) => !sameWords(existing.term, entry.term)),
      entry,
    ]);
    setTerm("");
    setSoundsLike("");
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title="Replacements"
          footer="Whole words or phrases, matched in any case, after the other cleanup. Leave the replacement empty to delete the phrase. Tap an entry to remove it."
        >
          {dictation.cleanup.replacements.map((entry) => (
            <SettingsActionRow
              key={entry.find}
              label={entry.find}
              description={entry.replace === "" ? "Deleted" : `Becomes “${entry.replace}”`}
              onPress={() =>
                confirmRemove(entry.find, () =>
                  setReplacements((current) =>
                    current.filter((existing) => !sameWords(existing.find, entry.find)),
                  ),
                )
              }
            />
          ))}
          <View className="gap-2 px-4 py-3">
            <AppTextInput
              accessibilityLabel="Heard as"
              value={find}
              onChangeText={setFind}
              placeholder="Heard as, such as “tee three”"
              autoCapitalize="none"
              autoCorrect={false}
              className={INPUT_CLASS}
            />
            <AppTextInput
              accessibilityLabel="Replace with"
              value={replace}
              onChangeText={setReplace}
              placeholder="Replace with, such as “T3”"
              autoCapitalize="none"
              autoCorrect={false}
              className={INPUT_CLASS}
            />
          </View>
          <SettingsActionRow
            icon="plus"
            label="Add replacement"
            disabled={find.trim() === ""}
            onPress={addReplacement}
          />
        </SettingsSection>
        <SettingsSection
          title="Vocabulary"
          footer="Names and terms the AI rewrite should spell exactly, with the spellings a transcript may show instead. Tap an entry to remove it."
        >
          {dictation.vocabulary.map((entry) => (
            <SettingsActionRow
              key={entry.term}
              label={entry.term}
              description={
                entry.soundsLike.length > 0
                  ? `Sounds like ${entry.soundsLike.join(", ")}`
                  : undefined
              }
              onPress={() =>
                confirmRemove(entry.term, () =>
                  setVocabulary((current) =>
                    current.filter((existing) => !sameWords(existing.term, entry.term)),
                  ),
                )
              }
            />
          ))}
          <View className="gap-2 px-4 py-3">
            <AppTextInput
              accessibilityLabel="Term"
              value={term}
              onChangeText={setTerm}
              placeholder="Term, such as “Parakeet”"
              autoCapitalize="none"
              autoCorrect={false}
              className={INPUT_CLASS}
            />
            <AppTextInput
              accessibilityLabel="Sounds like"
              value={soundsLike}
              onChangeText={setSoundsLike}
              placeholder="Sounds like, separated by commas"
              autoCapitalize="none"
              autoCorrect={false}
              className={INPUT_CLASS}
            />
          </View>
          <SettingsActionRow
            icon="plus"
            label="Add term"
            disabled={term.trim() === ""}
            onPress={addTerm}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
