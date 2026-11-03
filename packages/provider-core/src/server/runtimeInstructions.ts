// @effect-diagnostics nodeBuiltinImport:off -- A few synchronous stats while building turn text; adapters build it outside any FileSystem service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

const JJ_INSTRUCTIONS = `<version_control>
This is a colocated Jujutsu (jj) repository, despite the .git directory. Use jj, not git, for anything that writes: commit, describe, new, bookmarks, push, and restoring files. git restore, git clean, git commit and git checkout bypass jj's working copy. Read with jj too: git's HEAD is not the working-copy change @, so use jj status, jj diff and jj log.
</version_control>`;

/**
 * Mirrors the server's jj detection (apps/server/src/vcs/JjRepo.ts): the nearest `.jj` or `.git`
 * above cwd wins, and the nearest `.t3code/vcs.json` Git pin opts out. jj availability is not checked.
 */
function isJjWorkspace(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  let current: string;
  try {
    current = NodeFS.realpathSync(cwd);
  } catch {
    return false;
  }
  let marker: "jj" | "git" | null = null;
  let pinned: string | null = null;
  for (;;) {
    pinned ??= readVcsPin(current);
    if (marker === null) {
      if (isDirectory(NodePath.join(current, ".jj"))) marker = "jj";
      else if (NodeFS.existsSync(NodePath.join(current, ".git"))) marker = "git";
    }
    if (marker !== null && pinned !== null) break;
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return marker === "jj" && pinned !== "git";
}

function isDirectory(path: string): boolean {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest pin file decides even when it says "auto"; unreadable files count as auto. */
function readVcsPin(dir: string): string | null {
  const file = NodePath.join(dir, ".t3code", "vcs.json");
  if (!NodeFS.existsSync(file)) return null;
  try {
    const config = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
      vcs?: { kind?: unknown };
      vcsKind?: unknown;
    };
    const kind = config.vcs?.kind ?? config.vcsKind;
    return typeof kind === "string" ? kind : "auto";
  } catch {
    return "auto";
  }
}

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** The agent's working directory; a jj workspace there adds jj guidance. */
  readonly cwd?: string | null | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
  const linking =
    runtime.pullRequestLinking === false ? "" : `\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
  const jj = isJjWorkspace(runtime.cwd) ? `\n\n${JJ_INSTRUCTIONS}` : "";
  return `${runtimeInfo}${linking}${jj}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
