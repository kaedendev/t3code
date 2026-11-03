import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  appSignInSettingsFields,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  type CommitLink,
  type ParsedChangeRequestUrl,
} from "@t3tools/source-control-core/shared/definition";

import { icon } from "./icon.ts";

const KIND = SourceControlProviderKind.make("tangled");

/** Tangled's web host. Every repository's pages, pull requests included, are served here. */
export const TANGLED_WEB_HOST = "tangled.org";

/** `tangled.sh` is the old name of the web host; `*.tangled.sh` are Tangled-run knots. */
function isTangledHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === TANGLED_WEB_HOST || host === "tangled.sh" || host.endsWith(".tangled.sh");
}

const isWebHost = (hostname: string) => {
  const host = hostname.toLowerCase();
  return host === TANGLED_WEB_HOST || host === "tangled.sh";
};

const DID = /^did:(?:plc:[a-z2-7]+|web:[a-z0-9.%-]+)$/iu;

export const isDid = (value: string): boolean => DID.test(value);

/**
 * A repository as a remote or a reference names it: by its own DID, which survives renames and
 * handle changes, or by its owner (a handle or the owner's DID) and name.
 */
export type TangledRepositoryRef =
  | { readonly kind: "repo-did"; readonly repoDid: string }
  | { readonly kind: "named"; readonly owner: string; readonly name: string };

export interface TangledRemote {
  readonly repository: TangledRepositoryRef;
  /** The knot the remote talks to directly, or null for the web host's git proxy. */
  readonly knot: string | null;
}

/** `did:…`, `owner/name`, `@owner/name`, with `.git` allowed only on the named form. */
function parseTangledRepositoryPath(path: string): TangledRepositoryRef | null {
  const segments = path
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .split("/");
  if (segments.length === 1) {
    const [repoDid = ""] = segments;
    return isDid(repoDid) ? { kind: "repo-did", repoDid: repoDid.toLowerCase() } : null;
  }
  if (segments.length !== 2) return null;
  const owner = (segments[0] ?? "").replace(/^@/u, "");
  const name = (segments[1] ?? "").replace(/\.git$/iu, "");
  return owner.length > 0 && name.length > 0 && !/[\s:]/u.test(name)
    ? { kind: "named", owner, name }
    : null;
}

const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/u;

/** Hosted (`tangled.org`, `tangled.sh`) and knot remotes, over SSH or HTTP. */
export function parseTangledRemote(remoteUrl: string): TangledRemote | null {
  const trimmed = remoteUrl.trim();
  let host: string;
  let path: string;
  if (/^(?:ssh|git|https?):\/\//iu.test(trimmed)) {
    const url = URL.parse(trimmed);
    if (url === null || url.search !== "" || url.hash !== "") return null;
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else {
    const scp = SCP_REMOTE.exec(trimmed);
    if (scp === null) return null;
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  }
  const repository = parseTangledRepositoryPath(path);
  if (repository === null) return null;
  // Only a knot names a repository by its DID, so that path claims any host, as a self-hosted
  // knot's; `owner/name` on an unknown host could be any forge's.
  if (!isTangledHost(host) && repository.kind !== "repo-did") return null;
  return { repository, knot: isWebHost(host) ? null : host.toLowerCase() };
}

/** A repository named as T3 hands it to the server: a DID, `owner/name`, or a remote. */
export function parseTangledRepository(value: string): TangledRepositoryRef | null {
  return parseTangledRemote(value)?.repository ?? parseTangledRepositoryPath(value);
}

/** The key T3 stores for a repository: its DID once known, which renames do not change. */
export function tangledRepositoryKey(repository: TangledRepositoryRef): string {
  return repository.kind === "repo-did"
    ? `${TANGLED_WEB_HOST}/${repository.repoDid}`
    : `${TANGLED_WEB_HOST}/${repository.owner}/${repository.name}`.toLowerCase();
}

/** The repo DID a stored key names, or null for a key in owner/name form or another host's. */
export function repoDidFromKey(key: string): string | null {
  const [host, did, ...rest] = key.split("/");
  return host === TANGLED_WEB_HOST && did !== undefined && rest.length === 0 && isDid(did)
    ? did
    : null;
}

/**
 * The registry hands over `host/path`, or the lower-cased remote itself when its path is a single
 * segment, as a repo DID's is. Either way every Tangled spelling comes out on the web host.
 */
function repositoryKeyFromRemote(key: string): string | null {
  const remote =
    parseTangledRemote(key) ??
    (() => {
      const [host = "", ...path] = key.split("/");
      const repository = parseTangledRepositoryPath(path.join("/"));
      if (repository === null) return null;
      return isTangledHost(host) || repository.kind === "repo-did" ? { repository } : null;
    })();
  return remote === null ? null : tangledRepositoryKey(remote.repository);
}

const CHANGE_REQUEST_PATH = /^\/@?([^/@]+)\/([^/]+)\/pulls\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/@?([^/@]+)\/([^/]+)\/commit\/([0-9a-f]+)\/?$/iu;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function webPath(url: URL, route: RegExp): RegExpExecArray | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return isWebHost(url.hostname) ? route.exec(url.pathname) : null;
}

/** `/<owner>/<repo>/pulls/<n>`, with `@`, `/latest` or `/round/…` suffixes, on the web host. */
function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  const match = webPath(url, CHANGE_REQUEST_PATH);
  const [, owner, name, digits] = match ?? [];
  const number = Number(digits);
  if (!owner || !name || !Number.isSafeInteger(number) || number < 1) return null;
  return {
    host: TANGLED_WEB_HOST,
    repository: `${owner}/${name}`.toLowerCase(),
    number,
    repositoryUrl: `https://${TANGLED_WEB_HOST}/${owner}/${name}`,
  };
}

function parseCommitUrl(url: URL): CommitLink | null {
  const [, owner, name, sha] = webPath(url, COMMIT_PATH) ?? [];
  return owner && name && sha && FULL_COMMIT_SHA.test(sha)
    ? {
        host: TANGLED_WEB_HOST,
        repository: `${owner}/${name}`.toLowerCase(),
        sha: sha.toLowerCase(),
      }
    : null;
}

export const settings = makeProviderSettingsSchema(appSignInSettingsFields);
export type TangledSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Tangled",
  pickerLabel: "Tangled",
  icon,
  searchKeywords: ["atproto", "knot", "tangled.sh"],
  appSignIn: {
    appName: "T3 Code",
    hosts: [TANGLED_WEB_HOST],
    summary:
      "Lets the server open pull requests, submit rounds, merge and comment as you. Reading needs no sign-in.",
    account: { label: "Your handle", placeholder: "alice.bsky.social" },
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "handle/repo",
  publicHost: TANGLED_WEB_HOST,
  publishDescription: TANGLED_WEB_HOST,
  publishHost: () => TANGLED_WEB_HOST,
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  publicRepositoriesOnly: true,
  // Pushing over HTTPS needs a credential helper minting tokens; SSH needs only a key.
  defaultCloneTransport: "ssh",
  sshKeysUrl: "https://tangled.org/settings/keys",
  changeRequestUrl: ({ repository, number, webUrl }) => {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    if (webUrl) return changeRequestUrlBelow(webUrl, `pulls/${number}`);
    // A repo DID has no web route of its own below it.
    return repository.includes("/")
      ? `https://${TANGLED_WEB_HOST}/${repository}/pulls/${number}`
      : null;
  },
  parseChangeRequestUrl,
  commitUrl: (input) => buildCommitUrl({ ...input, host: TANGLED_WEB_HOST }, "commit"),
  parseCommitUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["close", "reopen", "merge", "resubmit"] as const),
  checkoutCommand: ({ number }) => `tg pr checkout ${number}`,
  changeRequestCloseCommand: /\btg\s+pr\s+(?:merge|close)\b/u,
  changeRequestCreateCommand: /\btg\s+pr\s+create\b/u,
  authorProfileUrl: (login) =>
    login.length > 0 ? `https://${TANGLED_WEB_HOST}/${encodeURIComponent(login)}` : null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => {
    const parsed = URL.parse(url);
    return parsed !== null && parseChangeRequestUrl(parsed) !== null;
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ hostname, remoteUrl }) =>
    isTangledHost(hostname) || parseTangledRemote(remoteUrl) !== null
      ? { kind: KIND, name: "Tangled", baseUrl: `https://${TANGLED_WEB_HOST}` }
      : null,
  changeRequestHost: () => TANGLED_WEB_HOST,
  repositoryKeyFromRemote,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(TANGLED_WEB_HOST, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(TANGLED_WEB_HOST, identity, link),
  settings,
});
