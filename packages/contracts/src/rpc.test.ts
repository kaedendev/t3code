import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { SourceControlSignInInput, SourceControlSignInPrompt } from "./sourceControl.ts";

describe("WebSocket RPC contracts", () => {
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });

  it("decodes sign-ins with and without an account or device code", () => {
    const decodeInput = Schema.decodeUnknownSync(SourceControlSignInInput);
    const decodePrompt = Schema.decodeUnknownSync(SourceControlSignInPrompt);

    expect(decodeInput({ provider: "github", host: "github.com" })).toEqual({
      provider: "github",
      host: "github.com",
    });
    expect(
      decodeInput({ provider: "tangled", host: "tangled.org", account: " kaeden.codes " }),
    ).toEqual({ provider: "tangled", host: "tangled.org", account: "kaeden.codes" });
    expect(
      decodePrompt({
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: 900_000,
      }).userCode,
    ).toBe("ABCD-1234");
    expect(
      decodePrompt({ verificationUri: "https://pds.example/oauth/authorize", expiresAt: 600_000 }),
    ).toEqual({ verificationUri: "https://pds.example/oauth/authorize", expiresAt: 600_000 });
  });
});
