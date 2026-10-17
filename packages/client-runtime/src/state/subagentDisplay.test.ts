import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { resolveSubagentMetadata } from "./subagentDisplay.js";

describe("resolveSubagentMetadata", () => {
  const parentThread = { projectId: ProjectId.make("parent"), worktreePath: null };
  const parentProject = { workspaceRoot: "/repo" };

  it("uses jj terminology without changing the workspace metadata kinds", () => {
    const input = {
      model: null,
      parentThread,
      parentProject,
      terminology: JJ_VCS_TERMINOLOGY,
    };
    expect(
      resolveSubagentMetadata({
        ...input,
        childThread: { branch: "fix/agents", worktreePath: "/workspaces/agents" },
      }).workspace,
    ).toEqual([{ kind: "ref", label: "Bookmark", value: "fix/agents" }]);
    expect(
      resolveSubagentMetadata({
        ...input,
        childThread: { branch: null, worktreePath: "/workspaces/agents" },
      }).workspace,
    ).toEqual([{ kind: "workspace", label: "Workspace", value: "agents" }]);
  });
});
