import type { EnvironmentId } from "@t3tools/contracts";
import type { SourceControlDefinition } from "@t3tools/client-runtime/source-control-clients";
import * as Equal from "effect/Equal";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { deriveProviderSettingsFields, ProviderSettingsForm } from "./ProviderSettingsForm";

export function SourceControlHostSettings({
  environmentId,
  definition,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition & {
    readonly settings: NonNullable<SourceControlDefinition["settings"]>;
  };
  readonly onSaved: () => void;
}) {
  const stored = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sourceControlHosts[definition.kind],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} settings`,
  });
  const [saving, setSaving] = useState(false);
  const formDefinition = { settingsSchema: definition.settings };
  // Hidden fields, such as an app sign-in's session, belong to other controls; never clear them here.
  const visibleKeys = new Set(
    deriveProviderSettingsFields(formDefinition, stored).map((field) => field.key),
  );
  const saved =
    stored === undefined
      ? undefined
      : Object.fromEntries(Object.entries(stored).filter(([key]) => visibleKeys.has(key)));
  const hasSaved = Object.values(saved ?? {}).some((value) => value !== "");

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sourceControlHosts: { [definition.kind]: fields } } },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  if (visibleKeys.size === 0) return null;
  return (
    // Locked while saving, so an edit made mid-request is not overwritten by the saved value.
    <fieldset disabled={saving} className="contents">
      <ProviderSettingsForm
        definition={formDefinition}
        value={saved ?? {}}
        idPrefix={`source-control-${definition.kind}-${environmentId}`}
        variant="settings"
        environmentId={environmentId}
        onChange={(next) => {
          const fields = Object.fromEntries(
            Object.entries(next ?? {}).filter(([key]) => visibleKeys.has(key)),
          );
          const changed = Object.fromEntries(
            Object.entries(fields).filter(([key, value]) => !Equal.equals(saved?.[key], value)),
          );
          const cleared = Object.keys(saved ?? {}).filter((key) => !(key in fields));
          void save({ ...changed, ...Object.fromEntries(cleared.map((key) => [key, ""])) });
        }}
      />
      {hasSaved ? (
        <div className="flex justify-end pt-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void save(Object.fromEntries(Object.keys(saved ?? {}).map((key) => [key, ""])))
            }
          >
            Remove
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
