import * as Effect from "effect/Effect";

import type * as TangledApi from "./TangledApi.ts";
import { unifiedFilePatch } from "./unifiedDiff.ts";

/** Files whose blobs one diff page reads, two blobs each. */
const FILES_PER_PAGE = 25;
const MAX_FILE_BYTES = 1024 * 1024;
const ABSENT = /^0+$/u;

/** A commit range across two repositories: a fork's head is only in the fork. */
export interface TangledRange {
  readonly baseRepoDid: string;
  readonly base: string;
  readonly headRepoDid: string;
  readonly head: string;
}

export type FileChange = "added" | "deleted" | "modified";

const changeOf = (file: TangledApi.TangledFileDiff): FileChange =>
  ABSENT.test(file.lhsSrc.oid) ? "added" : ABSENT.test(file.rhsSrc.oid) ? "deleted" : "modified";

/** Changed lines per file as Tangled counts them, without reading any blob. */
export const lineStats = (file: TangledApi.TangledFileDiff) => ({
  additions: file.hunks.reduce((sum, hunk) => sum + hunk.novelRhs.length, 0),
  deletions: file.hunks.reduce((sum, hunk) => sum + hunk.novelLhs.length, 0),
});

const unreadable = (file: TangledApi.TangledFileDiff) =>
  file.lhsSrc.isBinary ||
  file.rhsSrc.isBinary ||
  file.lhsSrc.isSubmodule === true ||
  file.rhsSrc.isSubmodule === true;

export const readFileContents = Effect.fn("TangledPatch.readFileContents")(function* (
  api: TangledApi.TangledApi["Service"],
  range: TangledRange,
  file: { readonly oldPath: string; readonly newPath: string; readonly change: FileChange },
) {
  const [oldContents, newContents] = yield* Effect.all(
    [
      file.change === "added"
        ? Effect.succeed("")
        : api.getBlob({ repoDid: range.baseRepoDid, commit: range.base, path: file.oldPath }),
      file.change === "deleted"
        ? Effect.succeed("")
        : api.getBlob({ repoDid: range.headRepoDid, commit: range.head, path: file.newPath }),
    ],
    { concurrency: 2 },
  );
  return { oldContents, newContents };
});

/**
 * Unified diff text for one page of a range's files. `truncated` is set when a file was too large
 * or binary to show its lines.
 */
export const readPatchSlice = Effect.fn("TangledPatch.readPatchSlice")(function* (
  api: TangledApi.TangledApi["Service"],
  range: TangledRange,
  cursor: string | undefined,
) {
  const files = yield* api.getDiff({
    baseRepoDid: range.baseRepoDid,
    baseCommit: range.base,
    headRepoDid: range.headRepoDid,
    headCommit: range.head,
  });
  const offset = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const page = files.slice(offset, offset + FILES_PER_PAGE);
  let truncated = false;
  const patches = yield* Effect.forEach(
    page,
    Effect.fnUntraced(function* (file) {
      const change = changeOf(file);
      const oversized = Math.max(file.lhsSrc.size, file.rhsSrc.size) > MAX_FILE_BYTES;
      const paths = { oldPath: file.lhsSrc.path, newPath: file.rhsSrc.path, change };
      if (unreadable(file) || oversized) {
        if (oversized) truncated = true;
        return unifiedFilePatch({ ...paths, binary: true, oldContent: null, newContent: null });
      }
      const contents = yield* readFileContents(api, range, paths);
      if (contents.oldContents === null || contents.newContents === null) {
        truncated = true;
        return unifiedFilePatch({ ...paths, binary: true, oldContent: null, newContent: null });
      }
      return unifiedFilePatch({
        ...paths,
        binary: false,
        oldContent: contents.oldContents,
        newContent: contents.newContents,
      });
    }),
    // fnUntraced: one span per file of a page would drown the page's own span.
    { concurrency: 8 },
  );
  const next = offset + FILES_PER_PAGE;
  return {
    patch: patches.join(""),
    truncated,
    nextCursor: next < files.length ? String(next) : null,
  };
});
