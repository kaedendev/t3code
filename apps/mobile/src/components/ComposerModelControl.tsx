import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  getPromptControlledTraits,
  isReasoningControl,
} from "@t3tools/client-runtime/model-traits";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import { Pressable, View } from "react-native";

import type { ModelOption } from "../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { AppText as Text } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";
import { ProviderIcon, ProviderInstanceIcon, providerInstanceNameLabel } from "./ProviderIcon";

/** Mirrors desktop's model trigger: icon, model name, then effort, a Fast bolt and context window. */
export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly provider: ProviderDriverKind | undefined;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly surfaceColor: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly onPress: () => void;
}) {
  const { smallIconSize } = useAndroidControlSizing();
  const iconSize = props.size === "large" ? 20 : smallIconSize;
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const display = props.provider
    ? buildTraitsTriggerDisplay({
        descriptors,
        primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
        ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
        modelSelection: props.selection,
        reportedModelSelection: props.reportedSelection,
      })
    : null;
  const reasoning = descriptors.find(isReasoningControl) ?? null;
  const effort = !reasoning
    ? null
    : promptTraits.ultrathinkPromptControlled && reasoning === promptTraits.primarySelectDescriptor
      ? "Ultrathink"
      : reasoning.type === "boolean"
        ? `${reasoning.label} ${reasoning.currentValue === true ? "On" : "Off"}`
        : getProviderOptionCurrentLabel(reasoning, props.selection, props.reportedSelection);
  const contextWindowDescriptor =
    descriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const contextWindow = contextWindowDescriptor
    ? getProviderOptionCurrentLabel(
        contextWindowDescriptor,
        props.selection,
        props.reportedSelection,
      )
    : null;
  const fast = display?.speedLabel === "Fast" || display?.speedLabel === "Ultrafast";
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const providerNameLabel = badge
    ? providerInstanceNameLabel({
        provider: props.modelOption?.providerDriver,
        iconUrl: props.modelOption?.providerIconUrl,
        displayName: badge.displayName,
        showBadge: badge.showBadge,
      })
    : null;
  const shortLabel = props.modelOption?.shortName ?? label;
  const textSize = props.size === "large" ? "text-base" : "text-sm";
  return (
    <Pressable
      accessibilityLabel={[
        "Model and reasoning settings",
        label,
        badge?.showBadge ? badge.displayName : null,
        display?.label,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="h-[44px] max-w-full flex-row items-center gap-1.5 rounded-xl px-2 active:bg-subtle"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      <View className="shrink-0 items-center justify-center" style={{ width: iconSize }}>
        {badge?.showBadge ? (
          <ProviderInstanceIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            displayName={badge.displayName}
            accentColor={badge.accentColor}
            showBadge
            surfaceColor={props.surfaceColor}
            size={iconSize}
          />
        ) : (
          <ProviderIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            size={iconSize}
          />
        )}
      </View>
      <Text
        className={`shrink ${textSize} font-t3-semibold text-foreground/80`}
        numberOfLines={1}
        ellipsizeMode={providerNameLabel ? "middle" : undefined}
      >
        {providerNameLabel ?? shortLabel}
      </Text>
      {providerNameLabel ? (
        <Text className={`shrink-0 ${textSize} text-foreground-muted`} numberOfLines={1}>
          {shortLabel}
        </Text>
      ) : null}
      {effort ? (
        <Text className={`shrink-0 ${textSize} text-foreground-muted`} numberOfLines={1}>
          {effort}
        </Text>
      ) : null}
      {fast ? (
        <SymbolView
          name="bolt.fill"
          size={props.size === "large" ? 13 : 11}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : null}
      {contextWindow ? (
        <Text className="shrink-0 text-xs text-foreground-muted" numberOfLines={1}>
          {contextWindow}
        </Text>
      ) : null}
    </Pressable>
  );
}
