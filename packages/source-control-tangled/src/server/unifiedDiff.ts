/**
 * Tangled's diff API answers with structural hunks and no file text, so T3 builds git's unified
 * form itself from the two blobs.
 */

const CONTEXT = 3;
/** Past this many edits a line diff costs more than it tells; the file reads as rewritten. */
const MAX_EDITS = 1_000;

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

/** Lines with their terminators, so a missing final newline is a difference like any other. */
const linesOf = (content: string | null) =>
  content ? (content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) : [];

/** Myers' shortest edit script, keeping only the `[-d, d]` window of each round. */
function editScript(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<Op> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Array<Int32Array> = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace);
    }
  }
  return null;
}

function backtrack(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  trace: ReadonlyArray<Int32Array>,
): Array<Op> {
  const ops: Array<Op> = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d] ?? new Int32Array();
    const at = (k: number) => snapshot[k + d + 1] ?? 0;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ kind: " ", line: a[--x] ?? "" });
      y--;
    }
    if (d === 0) break;
    if (x === previousX) ops.push({ kind: "+", line: b[--y] ?? "" });
    else ops.push({ kind: "-", line: a[--x] ?? "" });
  }
  return ops.reverse();
}

function hunks(ops: ReadonlyArray<Op>): Array<string> {
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  const out: Array<string> = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor] ?? 0;
    let last = first;
    while (cursor < changed.length && (changed[cursor] ?? 0) - last <= 2 * CONTEXT) {
      last = changed[cursor] ?? last;
      cursor++;
    }
    const start = Math.max(0, first - CONTEXT);
    const end = Math.min(ops.length, last + CONTEXT + 1);
    let oldBefore = 0;
    let newBefore = 0;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") oldBefore++;
      if (op.kind !== "-") newBefore++;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const range = (before: number, count: number) =>
      `${count === 0 ? before : before + 1},${count}`;
    out.push(`@@ -${range(oldBefore, oldCount)} +${range(newBefore, newCount)} @@`);
    for (const op of slice) {
      out.push(`${op.kind}${op.line.replace(/\n$/u, "")}`);
      if (!op.line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
  }
  return out;
}

export interface UnifiedFileInput {
  readonly oldPath: string;
  readonly newPath: string;
  readonly change: "added" | "deleted" | "modified";
  /** Contents are not read for a binary file. */
  readonly binary: boolean;
  readonly oldContent: string | null;
  readonly newContent: string | null;
}

/** One file's `diff --git` section, ending in a newline; empty when nothing changed. */
export function unifiedFilePatch(input: UnifiedFileInput): string {
  const added = input.change === "added";
  const deleted = input.change === "deleted";
  const header = [
    `diff --git a/${input.oldPath} b/${input.newPath}`,
    ...(added ? ["new file mode 100644"] : deleted ? ["deleted file mode 100644"] : []),
  ];
  const oldName = added ? "/dev/null" : `a/${input.oldPath}`;
  const newName = deleted ? "/dev/null" : `b/${input.newPath}`;
  if (input.binary)
    return [...header, `Binary files ${oldName} and ${newName} differ`, ""].join("\n");
  const a = linesOf(added ? null : input.oldContent);
  const b = linesOf(deleted ? null : input.newContent);
  const ops = editScript(a, b) ?? [
    ...a.map((line) => ({ kind: "-" as const, line })),
    ...b.map((line) => ({ kind: "+" as const, line })),
  ];
  const body = hunks(ops);
  if (body.length === 0 && !added && !deleted) return "";
  return [...header, `--- ${oldName}`, `+++ ${newName}`, ...body, ""].join("\n");
}
