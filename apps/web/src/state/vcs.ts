import { createContext } from "react";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  createVcsStatusRevalidationAtomFamily,
} from "@t3tools/client-runtime/state/vcs";
import {
  resolveVcsTerminology,
  supportsVcsActions,
  type VcsTerminology,
} from "@t3tools/shared/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeDocumentReturn } from "../lib/documentActivity";
import { useEnvironmentQuerySelector } from "./query";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/**
 * Refreshes a checkout's status when the user comes back to the window, where
 * edits made in another app or terminal may be waiting.
 */
export const vcsStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});

export const VcsTerminologyContext = createContext(resolveVcsTerminology(null));

export const selectVcsTerminology = (status: AsyncResult.AsyncResult<VcsStatusResult, unknown>) =>
  resolveVcsTerminology(Option.getOrNull(AsyncResult.value(status)));
export const selectVcsActionsSupported = (
  status: AsyncResult.AsyncResult<VcsStatusResult, unknown>,
) => supportsVcsActions(Option.getOrNull(AsyncResult.value(status)));

/** Reads the shared status atom for (environment, cwd); Git terms until it answers. */
export function useVcsTerminology(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): VcsTerminology {
  return useEnvironmentQuerySelector(
    environmentId === null || cwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
    selectVcsTerminology,
  );
}
