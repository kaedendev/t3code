import { describe, expect, it } from "@effect/vitest";

import { unifiedFilePatch } from "./unifiedDiff.ts";

const file = (oldContent: string | null, newContent: string | null) => ({
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  change:
    oldContent === null
      ? ("added" as const)
      : newContent === null
        ? ("deleted" as const)
        : ("modified" as const),
  binary: false,
  oldContent,
  newContent,
});

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("");

describe("unifiedFilePatch", () => {
  it("writes git's hunks with three lines of context and merges nearby changes", () => {
    const before = numbered(20);
    const after = before
      .replace("line 5\n", "line five\n")
      .replace("line 9\n", "")
      .replace("line 20\n", "line 20\nline 21\n");
    expect(unifiedFilePatch(file(before, after))).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -2,11 +2,10 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+line five",
        " line 6",
        " line 7",
        " line 8",
        "-line 9",
        " line 10",
        " line 11",
        " line 12",
        "@@ -18,3 +17,4 @@",
        " line 18",
        " line 19",
        " line 20",
        "+line 21",
        "",
      ].join("\n"),
    );
  });

  it("marks added and deleted files and a missing final newline", () => {
    expect(unifiedFilePatch(file(null, "one\ntwo"))).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/a.ts",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(unifiedFilePatch(file("gone\n", null))).toContain(
      "deleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n",
    );
    expect(unifiedFilePatch(file("same\n", "same"))).toContain(
      "-same\n+same\n\\ No newline at end of file\n",
    );
    expect(unifiedFilePatch(file("same\n", "same\n"))).toBe("");
  });

  it("names a binary change without reading it", () => {
    expect(unifiedFilePatch({ ...file("", ""), binary: true })).toBe(
      "diff --git a/src/a.ts b/src/a.ts\nBinary files a/src/a.ts and b/src/a.ts differ\n",
    );
  });
});
