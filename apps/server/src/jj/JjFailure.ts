import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitCommandError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import { JjProcessExitError } from "../vcs/JjProcess.ts";

const isUnsupportedOperationError = Schema.is(VcsUnsupportedOperationError);
const isGitCommandError = Schema.is(GitCommandError);
const isJjProcessExitError = Schema.is(JjProcessExitError);

const causeChainDetail = (
  cause: unknown,
  pick: (cause: object) => string | undefined,
): string | undefined => {
  const seen = new Set<object>();
  while (typeof cause === "object" && cause !== null && !seen.has(cause)) {
    const detail = pick(cause);
    if (detail !== undefined) return detail;
    seen.add(cause);
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return undefined;
};

/** Read the typed refusal before Schema.Defect flattens nested errors on the wire. */
export const jjUnsupportedDetail = (cause: unknown): string | undefined =>
  causeChainDetail(cause, (error) =>
    isUnsupportedOperationError(error) ? error.detail : undefined,
  );

const jjStaleWorkspaceDetail = (cause: unknown): string | undefined =>
  causeChainDetail(cause, (error) =>
    isJjProcessExitError(error) && error.staleWorkspace === true ? error.detail : undefined,
  );

export const jjFailure = (operation: string, cwd: string, detail: string, cause?: unknown) => {
  const unsupportedDetail = jjUnsupportedDetail(cause);
  const reason = isGitCommandError(cause)
    ? cause.reason
    : isJjProcessExitError(cause)
      ? cause.reason
      : undefined;
  return new GitCommandError({
    operation,
    command: "jj",
    cwd,
    detail: unsupportedDetail ?? jjStaleWorkspaceDetail(cause) ?? detail,
    ...(unsupportedDetail !== undefined
      ? { reason: "unsupported_repository" as const }
      : reason !== undefined
        ? { reason }
        : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
};

export const mapJjFailure = (operation: string, cwd: string, detail: string) =>
  Effect.mapError((cause: unknown) => jjFailure(operation, cwd, detail, cause));
