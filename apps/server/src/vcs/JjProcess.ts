import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitCommandFailureReason, type VcsError, VcsProcessExitError } from "@t3tools/contracts";
import { classifyGitFailure, STATUS_UPSTREAM_REFRESH_ENV } from "./GitVcsDriverCore.ts";
import * as VcsProcess from "./VcsProcess.ts";

export class JjProcessExitError extends VcsProcessExitError.extend<JjProcessExitError>(
  "JjProcessExitError",
)({
  reason: Schema.optional(GitCommandFailureReason),
  staleWorkspace: Schema.optional(Schema.Literal(true)),
}) {}

// `update-stale` checks the new commit out over files edited since the last snapshot, so only the
// user may run it.
export const JJ_STALE_WORKSPACE_DETAIL =
  "This Jujutsu workspace is stale because its change was rewritten from another workspace. T3 Code left the files as they are. Run `jj workspace update-stale` in this workspace, then retry. jj moves edits made since its last snapshot into a separate commit.";

function processExitError(
  operation: string,
  command: string,
  cwd: string,
  argumentCount: number,
  result: VcsProcess.VcsProcessOutput,
  readingChange = false,
) {
  let failureKind = VcsProcess.classifyNonZeroExit(result.stderr, undefined);
  const staleWorkspace = command === "jj" && isStaleWorkspace(result.stderr);
  if (command === "jj") {
    const missingRevision = /^Error: Revision `[^`]+` doesn't exist/m.test(result.stderr);
    if (missingRevision) {
      failureKind = "not-found";
    } else if (
      failureKind === "command-failed" &&
      !readingChange &&
      /there is no jj repo in|no such bookmark/i.test(result.stderr)
    ) {
      failureKind = "not-found";
    }
  }
  return new JjProcessExitError({
    ...VcsProcessExitError.fromProcessExit(
      { operation, command, cwd, argumentCount },
      result,
      failureKind,
    ),
    ...(staleWorkspace ? { detail: JJ_STALE_WORKSPACE_DETAIL, staleWorkspace: true as const } : {}),
    // jj capitalizes its diagnostic prefix; leave hook and remote output untrusted.
    reason:
      classifyGitFailure(
        command === "jj" ? result.stderr.replace(/^Error:/gm, "error:") : result.stderr,
      ) ?? undefined,
  });
}

export interface JjCommandOptions {
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
  readonly appendTruncationMarker?: boolean;
  /** Pure reads that must not snapshot the working copy. Adds `--ignore-working-copy`. */
  readonly ignoreWorkingCopy?: boolean;
  /** Missing repositories are failures during revision reads, not absent revision results. */
  readonly readingChange?: boolean;
  /** Let VcsProcess retry transient checkpoint failures before mapping their diagnostics. */
  readonly retryTransientFailures?: boolean;
  /** Extra `--config KEY=VALUE` pairs, applied to this invocation only. */
  readonly config?: ReadonlyArray<readonly [key: string, value: string]>;
}

const LARGE_FILE_BANNER = "refused to snapshot some files";
const LOGGED_STDERR_MAX_CHARS = 2_000;

/**
 * A colocated repository imports git refs on every jj command that touches the working copy, so
 * `git.abandon-unreachable-commits` (default true) lets an ordinary status poll abandon commits the
 * user's own `git fetch` or `git branch -f` moved a ref away from, rewriting files on disk. The
 * guard belongs to everything T3 runs on the user's behalf, never to their own jj invocations.
 */
const JJ_GLOBAL_ARGS = [
  "--no-pager",
  "--color=never",
  "--quiet",
  "--config",
  "git.abandon-unreachable-commits=false",
] as const;

function configFlags(config: JjCommandOptions["config"]): string[] {
  return config?.flatMap(([key, value]) => ["--config", `${key}=${value}`]) ?? [];
}

function passthroughOptions(options: JjCommandOptions | undefined) {
  return {
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
  };
}

function jjArgs(args: ReadonlyArray<string>, options: JjCommandOptions | undefined): string[] {
  return [
    ...JJ_GLOBAL_ARGS,
    ...configFlags(options?.config),
    ...(options?.ignoreWorkingCopy === true ? ["--ignore-working-copy"] : []),
    ...args,
  ];
}

function isStaleWorkspace(stderr: string): boolean {
  return /^Error: The working copy is stale/m.test(stderr);
}

/**
 * Runs `jj` inside `cwd` (no `-R`: jj's `-R` demands an exact workspace root, and callers pass
 * project subdirectories). Warnings, hints and the large-file banner land on stderr, so only stdout
 * may be parsed.
 */
export const jjCommand = Effect.fn("JjProcess.jjCommand")(function* (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: JjCommandOptions,
): Effect.fn.Return<VcsProcess.VcsProcessOutput, VcsError> {
  const input = {
    operation,
    command: "jj",
    args: jjArgs(args, options),
    cwd,
    ...passthroughOptions(options),
    ...(args[0] === "git" && args[1] === "fetch"
      ? { env: { ...options?.env, ...STATUS_UPSTREAM_REFRESH_ENV } }
      : {}),
    allowNonZeroExit: true,
  } satisfies VcsProcess.VcsProcessInput;

  const result = yield* process.run(input);

  if (result.stderr.toLowerCase().includes(LARGE_FILE_BANNER)) {
    yield* Effect.logWarning("jj refused to snapshot some files", {
      cwd,
      stderr: result.stderr.slice(0, LOGGED_STDERR_MAX_CHARS),
    });
  }

  if (result.exitCode !== 0 && options?.allowNonZeroExit !== true) {
    return yield* processExitError(
      operation,
      "jj",
      cwd,
      input.args.length,
      result,
      options?.readingChange,
    );
  }

  return result;
});

/** The `run(operation, cwd, args, options)` shim every jj module binds once against its process. */
export const jjRunner =
  (process: VcsProcess.VcsProcess["Service"]) =>
  (operation: string, cwd: string, args: ReadonlyArray<string>, options?: JjCommandOptions) =>
    jjCommand(process, operation, cwd, args, options);

export interface ColocatedGitInput {
  readonly gitDir: string;
  readonly workTree?: string;
  readonly cwd: string;
}

/**
 * Runs `git` against the colocated object store. The `--git-dir` is always explicit: a non-colocated
 * secondary jj workspace has no `.git` for git to discover from its cwd. The process is spawned in
 * `cwd` so the relative paths `check-ignore --stdin` reads resolve against the directory being classified.
 */
export const colocatedGitCommand = Effect.fn("JjProcess.colocatedGitCommand")(function* (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  input: ColocatedGitInput,
  args: ReadonlyArray<string>,
  options?: Omit<JjCommandOptions, "ignoreWorkingCopy" | "config">,
): Effect.fn.Return<VcsProcess.VcsProcessOutput, VcsError> {
  const commandInput = {
    operation,
    command: "git",
    args: [
      "--git-dir",
      input.gitDir,
      ...(input.workTree !== undefined ? ["--work-tree", input.workTree] : []),
      ...args,
    ],
    cwd: input.cwd,
    ...passthroughOptions(options),
    ...(args[0] === "fetch" ? { env: { ...options?.env, ...STATUS_UPSTREAM_REFRESH_ENV } } : {}),
    allowNonZeroExit:
      options?.retryTransientFailures === true ? options?.allowNonZeroExit === true : true,
  } satisfies VcsProcess.VcsProcessInput;
  const result = yield* process.run(commandInput);
  if (result.exitCode !== 0 && options?.allowNonZeroExit !== true) {
    return yield* processExitError(operation, "git", input.cwd, commandInput.args.length, result);
  }
  return result;
});
