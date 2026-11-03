import type { EnvironmentId, SourceControlSignInPrompt } from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  sourceControlClients,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import * as Cause from "effect/Cause";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Linking } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const openUrl = (url: string) => void Linking.openURL(url).catch(() => undefined);

const appSignInHosts = sourceControlClients.definitions.flatMap((definition) =>
  definition.appSignIn === undefined ? [] : [{ definition, appSignIn: definition.appSignIn }],
);

/**
 * Signing an environment in through a forge's own app, such as T3 Code for GitHub, on servers
 * configured for it.
 */
export function SourceControlSignInSection(props: {
  readonly environments: readonly SettingsTarget[];
  readonly canWrite: (environmentId: EnvironmentId) => boolean;
}) {
  return (
    <>
      {appSignInHosts.flatMap(({ definition, appSignIn }) =>
        props.environments.map((environment) => (
          <OfferedAppSignIn
            key={`${definition.kind}:${environment.environmentId}`}
            environment={environment}
            title={
              props.environments.length > 1
                ? `${definition.label} · ${environment.label}`
                : definition.label
            }
            definition={definition}
            appSignIn={appSignIn}
            disabled={!props.canWrite(environment.environmentId)}
          />
        )),
      )}
    </>
  );
}

function OfferedAppSignIn(props: {
  readonly environment: SettingsTarget;
  readonly title: string;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly disabled: boolean;
}) {
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({
      environmentId: props.environment.environmentId,
      input: {},
    }),
  );
  const offered = discovery.data?.sourceControlProviders.some(
    (item) => item.kind === props.definition.kind && item.appSignIn === true,
  );
  if (offered !== true) return null;
  return (
    <SettingsSection title={props.title}>
      <AppSignInRow
        environment={props.environment}
        label={props.appSignIn.appName}
        definition={props.definition}
        appSignIn={props.appSignIn}
        disabled={props.disabled}
      />
    </SettingsSection>
  );
}

function AppSignInRow(props: {
  readonly environment: SettingsTarget;
  readonly label: string;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly disabled: boolean;
}) {
  const { environment, definition, appSignIn } = props;
  const environmentId = environment.environmentId;
  const host = appSignIn.hosts[0] ?? "";
  const { signIns } = readHostCredentialSettings(
    environment.serverConfig.settings,
    definition.kind,
  );
  const signedIn = (signIns[host] ?? "").length > 0;
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  // The attempt a pending `wait` belongs to; a cancel or a newer attempt makes its outcome stale.
  const attempt = useRef<SourceControlSignInPrompt | null>(null);
  const input = { provider: definition.kind, host };
  const { label } = definition;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `sign out of ${appSignIn.appName}`,
  });
  const [pending, setPending] = useState<SourceControlSignInPrompt | "starting" | null>(null);

  const cancelButton = {
    text: "Cancel",
    style: "cancel" as const,
    onPress: () => {
      attempt.current = null;
      setPending(null);
      void cancel({ environmentId, input });
    },
  };

  const showPrompt = (prompt: SourceControlSignInPrompt) => {
    const { userCode } = prompt;
    if (userCode === undefined) {
      Dialog.alert(
        "Waiting for approval",
        `Approve ${appSignIn.appName} in your browser. The server finishes signing in even if you leave the app.`,
        [cancelButton, { text: "Open again", onPress: () => openUrl(prompt.verificationUri) }],
      );
      return;
    }
    void Clipboard.setStringAsync(userCode).catch(() => undefined);
    Dialog.alert(
      userCode,
      `Enter this code on ${label}, then approve ${appSignIn.appName}. It is copied. The server finishes signing in even if you leave the app.`,
      [cancelButton, { text: `Open ${label}`, onPress: () => openUrl(prompt.verificationUri) }],
    );
  };

  const signIn = async (account?: string) => {
    setPending("starting");
    const started = await start({
      environmentId,
      input: { ...input, ...(account !== undefined && { account }) },
    });
    if (started._tag !== "Success") {
      setPending(null);
      Dialog.alert("Could not start the sign-in", failureMessage(started.cause));
      return;
    }
    const prompt = started.value;
    attempt.current = prompt;
    setPending(prompt);
    if (prompt.userCode === undefined) openUrl(prompt.verificationUri);
    else showPrompt(prompt);
    const finished = await wait({ environmentId, input });
    if (attempt.current !== prompt) return;
    attempt.current = null;
    setPending(null);
    if (finished._tag !== "Success") {
      Dialog.alert("Sign-in did not finish", failureMessage(finished.cause));
    }
  };

  const signOut = () =>
    void updateSettings({
      environmentId,
      // Send the whole map; other hosts' redaction markers preserve their sessions.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { signIns: { ...signIns, [host]: "" } } },
        },
      },
    });

  const askForAccount = (account: NonNullable<SourceControlAppSignIn["account"]>) =>
    Dialog.prompt({
      title: `Sign in to ${label}`,
      message: account.label,
      placeholder: account.placeholder,
      initialValue: "",
      confirmText: "Continue",
      onConfirm: (value) => {
        if (value.trim() !== "") void signIn(value.trim());
      },
    });

  const onPress = () => {
    if (signedIn) {
      const { installUrl } = appSignIn;
      Dialog.alert(
        appSignIn.appName,
        installUrl === undefined
          ? "Signed in."
          : `Signed in. ${label} requests use the app's higher rate limit, in repositories where the app is installed.`,
        [
          ...(installUrl === undefined
            ? []
            : [{ text: "Install on an organization", onPress: () => openUrl(installUrl) }]),
          { text: "Sign out", style: "destructive", onPress: signOut },
          { text: "Cancel", style: "cancel" },
        ],
      );
    } else if (pending !== null && pending !== "starting") {
      showPrompt(pending);
    } else if (pending === null && appSignIn.account !== undefined) {
      askForAccount(appSignIn.account);
    } else if (pending === null) {
      void signIn();
    }
  };

  return (
    <SettingsRow
      icon="person.crop.circle"
      label={props.label}
      value={
        signedIn
          ? "Signed in"
          : pending === "starting"
            ? "Starting…"
            : pending === null
              ? "Sign in"
              : pending.userCode === undefined
                ? "Waiting for approval"
                : `Enter ${pending.userCode}`
      }
      disabled={props.disabled}
      onPress={onPress}
    />
  );
}
