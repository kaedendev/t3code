import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  HostCredentialSettings,
  readSourceControlHostSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/source-control-core/shared/definition";
import type { ServerSettings, SourceControlAppAccessInput } from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";

export {
  isMonochromeSourceControlIcon,
  newRepositoryVisibility,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type HostAccountChoice,
  type HostCredentialSettings,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
  type SourceControlIcon,
} from "@t3tools/source-control-core/shared/definition";

export const sourceControlClients = builtInSourceControlDefinitions;

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}

/** The repository a remote names, when its host has an app sign-in that installing could reach. */
export function appSignInTargetForRemote(remoteUrl: string): {
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn & { readonly installUrl: string };
  readonly input: SourceControlAppAccessInput;
} | null {
  const parsed = parseGitRemoteRepository(remoteUrl);
  const provider = sourceControlClients.recognizeRemote(remoteUrl);
  const definition = provider ? sourceControlClients.find(provider.kind) : undefined;
  const appSignIn = definition?.appSignIn;
  const installUrl = appSignIn?.installUrl;
  if (parsed === null || definition === undefined || appSignIn === undefined) return null;
  if (installUrl === undefined || !appSignIn.hosts.includes(parsed.host)) return null;
  // The parser lowercases; keep the remote's own casing for display when it names the same path.
  const asWritten = remoteUrl
    .trim()
    .replace(/\.git\/?$/i, "")
    .split(/[/:]/)
    .slice(-2)
    .join("/");
  const repository = asWritten.toLowerCase() === parsed.path ? asWritten : parsed.path;
  return {
    definition,
    appSignIn: { ...appSignIn, installUrl },
    input: { provider: definition.kind, host: parsed.host, repository },
  };
}
