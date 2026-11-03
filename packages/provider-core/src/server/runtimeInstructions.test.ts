// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

function makeTree(paths: ReadonlyArray<string>, files: Readonly<Record<string, string>> = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-vcs-"));
  for (const path of paths) NodeFS.mkdirSync(NodePath.join(root, path), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), text);
  }
  return {
    root,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("buildRuntimeInstructions", () => {
  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
    assert.notInclude(instructions, "<pull_request_linking>");
  });

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });

  it("adds jj guidance only where the nearest marker is an unpinned .jj", () => {
    using tree = makeTree(
      ["repo/.jj", "repo/.git", "repo/src", "repo/vendor/lib/.git", "pinned/.jj", "plain/.git"],
      { "pinned/.t3code/vcs.json": JSON.stringify({ vcs: { kind: "git" } }) },
    );
    const hasJj = (cwd: string | null) =>
      buildRuntimeInstructions({ harness: "Codex", cwd }).includes("<version_control>");

    assert.isTrue(hasJj(NodePath.join(tree.root, "repo")));
    assert.isTrue(hasJj(NodePath.join(tree.root, "repo/src")));
    assert.isFalse(hasJj(NodePath.join(tree.root, "repo/vendor/lib")));
    assert.isFalse(hasJj(NodePath.join(tree.root, "pinned")));
    assert.isFalse(hasJj(NodePath.join(tree.root, "plain")));
    assert.isFalse(hasJj(NodePath.join(tree.root, "missing")));
    assert.isFalse(hasJj(null));
  });
});
