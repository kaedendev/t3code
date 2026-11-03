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

type Round = Pick<TangledApi.TangledRound, "baseOid" | "headOid" | "sourceRepoDid">;

/** What a diff read compares: a commit range, or Tangled's interdiff of two rounds. */
export type TangledComparison =
  | { readonly kind: "range"; readonly range: TangledRange }
  | { readonly kind: "interdiff"; readonly from: Round; readonly to: Round };

export type FileChange = "added" | "deleted" | "modified";

interface FilePaths {
  readonly oldPath: string;
  readonly newPath: string;
  readonly change: FileChange;
}

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

export const listFiles = (api: TangledApi.TangledApi["Service"], comparison: TangledComparison) =>
  comparison.kind === "interdiff"
    ? api.getInterdiff({ from: comparison.from, to: comparison.to })
    : api.getDiff({
        baseRepoDid: comparison.range.baseRepoDid,
        baseCommit: comparison.range.base,
        headRepoDid: comparison.range.headRepoDid,
        headCommit: comparison.range.head,
      });

const headBlob = (api: TangledApi.TangledApi["Service"], to: Round, path: string) =>
  api.getBlob({ repoDid: to.sourceRepoDid, commit: to.headOid, path });

const rangeContents = (
  api: TangledApi.TangledApi["Service"],
  range: TangledRange,
  file: FilePaths,
) =>
  Effect.all(
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

/** The interdiff's left side is a tree no ref names, so its text exists only inline. */
const interdiffContents = (
  api: TangledApi.TangledApi["Service"],
  to: Round,
  file: TangledApi.TangledFileDiff,
) => {
  const change = changeOf(file);
  return Effect.all([
    Effect.succeed(change === "added" ? "" : (file.lhsSrc.content ?? null)),
    change === "deleted" ? Effect.succeed("") : headBlob(api, to, file.rhsSrc.path),
  ]);
};

const contentsOf = (
  api: TangledApi.TangledApi["Service"],
  comparison: TangledComparison,
  file: TangledApi.TangledFileDiff,
) =>
  comparison.kind === "interdiff"
    ? interdiffContents(api, comparison.to, file)
    : rangeContents(api, comparison.range, {
        oldPath: file.lhsSrc.path,
        newPath: file.rhsSrc.path,
        change: changeOf(file),
      });

/** Null contents mean a side too large or binary to show. */
export const readFileContents = Effect.fn("TangledPatch.readFileContents")(function* (
  api: TangledApi.TangledApi["Service"],
  comparison: TangledComparison,
  file: FilePaths,
) {
  if (comparison.kind === "range") {
    const [oldContents, newContents] = yield* rangeContents(api, comparison.range, file);
    return { oldContents, newContents };
  }
  const files = yield* listFiles(api, comparison);
  const found = files.find(
    (candidate) => candidate.lhsSrc.path === file.oldPath && candidate.rhsSrc.path === file.newPath,
  );
  if (found === undefined) {
    // A file the interdiff leaves out is unchanged since the earlier round.
    const unchanged = yield* headBlob(api, comparison.to, file.newPath);
    return { oldContents: unchanged, newContents: unchanged };
  }
  const [oldContents, newContents] = yield* interdiffContents(api, comparison.to, found);
  return { oldContents, newContents };
});

/**
 * Unified diff text for one page of a comparison's files. `truncated` is set when a file was too
 * large or binary to show its lines.
 */
export const readPatchSlice = Effect.fn("TangledPatch.readPatchSlice")(function* (
  api: TangledApi.TangledApi["Service"],
  comparison: TangledComparison,
  cursor: string | undefined,
) {
  const files = yield* listFiles(api, comparison);
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
      const [oldContent, newContent] = yield* contentsOf(api, comparison, file);
      if (oldContent === null || newContent === null) {
        truncated = true;
        return unifiedFilePatch({ ...paths, binary: true, oldContent: null, newContent: null });
      }
      return unifiedFilePatch({ ...paths, binary: false, oldContent, newContent });
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
