import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_REWRITE_INSTRUCTIONS,
  resolveDictationPipeline,
  type DictationSettings,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  dictationSettingsAtom,
  useUpdateDictationSettings,
} from "../voice-input/dictationSettings";
import { rewriteKeyPresentAtom, saveRewriteKey } from "../voice-input/rewriteKey";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsDictationRewriteRouteScreen() {
  const insets = useSafeAreaInsets();
  const dictation = useAtomValue(dictationSettingsAtom);
  const hasKey = useAtomValue(rewriteKeyPresentAtom);
  const update = useUpdateDictationSettings();
  // Bumped after each save so the key field clears instead of keeping the typed secret.
  const [keyField, setKeyField] = useState(0);
  const setRewrite = (patch: Partial<DictationSettings["rewrite"]>) =>
    update((current) => ({ ...current, rewrite: { ...current.rewrite, ...patch } }));
  const saveKey = (key: string | null) =>
    void saveRewriteKey(key).then(
      () => setKeyField((count) => count + 1),
      (error: unknown) =>
        Dialog.alert(
          "Could not save the API key",
          error instanceof Error ? error.message : undefined,
        ),
    );
  const incomplete =
    dictation.rewrite.enabled &&
    resolveDictationPipeline(dictation, hasKey ? "saved" : null).rewrite === null;

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
          footer={
            incomplete
              ? "Add a base URL, a model, and an API key to start rewriting."
              : "After cleanup, each transcript is sent to your provider and its rewrite is inserted. If the provider fails or takes over 15 seconds, the cleaned transcript is inserted instead."
          }
        >
          <SettingsSwitchRow
            icon="sparkles"
            label="AI rewrite"
            value={dictation.rewrite.enabled}
            onValueChange={(enabled) => setRewrite({ enabled })}
          />
        </SettingsSection>
        <SettingsSection
          title="Provider"
          footer="Any OpenAI-compatible chat completions API, such as OpenAI, OpenRouter, or Groq."
        >
          <TextFieldRow
            label="Base URL"
            value={dictation.rewrite.baseUrl}
            placeholder="https://api.openai.com/v1"
            keyboardType="url"
            onSave={(baseUrl) => setRewrite({ baseUrl })}
          />
          <TextFieldRow
            label="Model"
            value={dictation.rewrite.model}
            placeholder="Model ID"
            onSave={(model) => setRewrite({ model })}
          />
        </SettingsSection>
        <SettingsSection
          title="API key"
          footer="Saved in this device’s keychain. It is not backed up or synced, and T3 Code sends it only to your provider."
        >
          <TextFieldRow
            key={keyField}
            label={hasKey ? "Replace the saved key" : "Key"}
            value=""
            placeholder={hasKey ? "Saved" : "Paste your API key"}
            secure
            onSave={saveKey}
          />
          {hasKey ? (
            <SettingsActionRow
              icon="trash"
              tone="danger"
              label="Remove key"
              onPress={() => saveKey(null)}
            />
          ) : null}
        </SettingsSection>
        <SettingsSection
          title="Instructions"
          footer="Words from your vocabulary are added so the rewrite spells them exactly."
        >
          <TextFieldRow
            label="How to rewrite"
            value={dictation.rewrite.instructions}
            placeholder={DEFAULT_REWRITE_INSTRUCTIONS}
            multiline
            onSave={(instructions) => setRewrite({ instructions })}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function TextFieldRow(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly multiline?: boolean;
  readonly secure?: boolean;
  readonly keyboardType?: "url";
  readonly onSave: (value: string) => void;
}) {
  const draft = useRef<string | null>(null);
  const commit = () => {
    const text = draft.current?.trim();
    draft.current = null;
    if (text !== undefined && text !== props.value.trim()) props.onSave(text);
  };
  const commitOnClose = useEffectEvent(commit);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves a draft left unsaved when the page closes mid-edit
  useEffect(() => () => commitOnClose(), []);
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <AppTextInput
        key={props.value}
        accessibilityLabel={props.label}
        defaultValue={props.value}
        placeholder={props.placeholder}
        onChangeText={(text) => {
          draft.current = text;
        }}
        onEndEditing={commit}
        autoCapitalize={props.multiline ? "sentences" : "none"}
        autoCorrect={props.multiline}
        multiline={props.multiline}
        secureTextEntry={props.secure}
        keyboardType={props.keyboardType}
        className={
          props.multiline
            ? "min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            : "min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        }
      />
    </View>
  );
}
