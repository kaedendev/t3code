import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition, parseTangledRemote, repoDidFromKey } from "./definition.ts";

const REPO_DID = "did:plc:j5hmlfdrwkvtxm7cjmu7j2is";
const OWNER_DID = "did:plc:wshs7t2adsemcrrd4snkeqli";
const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Tangled remotes", () => {
  it.each([
    ["git@tangled.org:tangled.org/core", { owner: "tangled.org", name: "core" }, null],
    ["git@tangled.org:tangled.org/core.git", { owner: "tangled.org", name: "core" }, null],
    ["https://tangled.org/tangled.org/core", { owner: "tangled.org", name: "core" }, null],
    ["https://tangled.org/@tangled.org/core", { owner: "tangled.org", name: "core" }, null],
    ["ssh://git@tangled.sh/kaeden.codes/t3code", { owner: "kaeden.codes", name: "t3code" }, null],
    [`git@tangled.org:${OWNER_DID}/core`, { owner: OWNER_DID, name: "core" }, null],
    [`git@tangled.org:${REPO_DID}`, { repoDid: REPO_DID }, null],
    [`https://tangled.org/${REPO_DID}`, { repoDid: REPO_DID }, null],
    [`https://knot1.tangled.sh/${REPO_DID}`, { repoDid: REPO_DID }, "knot1.tangled.sh"],
    [`ssh://git@knot1.tangled.sh:2222/${REPO_DID}`, { repoDid: REPO_DID }, "knot1.tangled.sh"],
    [`git@knot.kaeden.codes:${REPO_DID}`, { repoDid: REPO_DID }, "knot.kaeden.codes"],
    [`https://knot.kaeden.codes/${REPO_DID}`, { repoDid: REPO_DID }, "knot.kaeden.codes"],
    [
      "git@knot.kaeden.codes:kaeden.codes/repo",
      { owner: "kaeden.codes", name: "repo" },
      "knot.kaeden.codes",
    ],
    [
      `https://knot2.example.com/${OWNER_DID}/repo.git`,
      { owner: OWNER_DID, name: "repo" },
      "knot2.example.com",
    ],
    [
      "git@knot1.tangled.sh:kaeden.codes/repo",
      { owner: "kaeden.codes", name: "repo" },
      "knot1.tangled.sh",
    ],
  ])("reads %s", (remote, repository, knot) => {
    expect(parseTangledRemote(remote)).toEqual({
      repository:
        "repoDid" in repository
          ? { kind: "repo-did", ...repository }
          : { kind: "named", ...repository },
      knot,
    });
    expect(recognizeRemoteWith(definition, remote)).toEqual({
      kind: "tangled",
      name: "Tangled",
      baseUrl: "https://tangled.org",
    });
  });

  it.each([
    "git@github.com:tangled.org/core",
    "git@git.example.com:kaeden.codes/repo",
    "git@knot.example.com:alice/repo",
    "https://knotty.example.com/kaeden.codes/repo",
    "https://tangled.org.evil.test/a/b",
    "https://nottangled.sh/a/b",
    "git@tangled.org:core",
    `git@tangled.org:${REPO_DID}.git`,
    "https://tangled.org/a/b/c",
    "https://tangled.org/a/b?x=1",
    "/local/path",
  ])("leaves %s alone", (remote) => {
    expect(parseTangledRemote(remote)).toBeNull();
  });

  it("keys every spelling on the web host, by repo DID where the remote names one", () => {
    const key = definition.repositoryKeyFromRemote;
    expect(key?.("tangled.org/@Tangled.org/Core")).toBe("tangled.org/tangled.org/core");
    expect(key?.("knot1.tangled.sh/kaeden.codes/repo")).toBe("tangled.org/kaeden.codes/repo");
    expect(key?.(`git@tangled.org:${REPO_DID}`)).toBe(`tangled.org/${REPO_DID}`);
    expect(key?.(`https://knot1.tangled.sh/${REPO_DID}`)).toBe(`tangled.org/${REPO_DID}`);
    expect(key?.(`git@knot.kaeden.codes:${REPO_DID}`)).toBe(`tangled.org/${REPO_DID}`);
    expect(key?.(`knot.kaeden.codes/${REPO_DID}`)).toBe(`tangled.org/${REPO_DID}`);
    expect(key?.("github.com/tangled.org/core")).toBeNull();
    expect(key?.("knot.kaeden.codes/kaeden.codes/repo")).toBe("tangled.org/kaeden.codes/repo");
    expect(key?.("git.example.com/kaeden.codes/repo")).toBeNull();
    expect(repoDidFromKey(`tangled.org/${REPO_DID}`)).toBe(REPO_DID);
    expect(repoDidFromKey("tangled.org/tangled.org/core")).toBeNull();
  });
});

describe("Tangled pull request URLs", () => {
  it.each([
    "https://tangled.org/tangled.org/core/pulls/4669",
    "https://tangled.org/tangled.org/core/pulls/4669/latest",
    "https://tangled.org/tangled.org/core/pulls/4669/round/2",
    "https://tangled.org/@tangled.org/core/pulls/4669",
    "https://tangled.sh/Tangled.org/Core/pulls/4669?diff=split#x",
  ])("reads %s", (url) => {
    expect(parse(url)).toMatchObject({
      host: "tangled.org",
      repository: "tangled.org/core",
      number: 4669,
    });
    expect(definition.isChangeRequestReference(url)).toBe(true);
  });

  it("reads an owner DID and keeps the repository URL as written", () => {
    expect(parse(`https://tangled.org/${OWNER_DID}/Core/pulls/3`)).toEqual({
      host: "tangled.org",
      repository: `${OWNER_DID}/core`,
      number: 3,
      repositoryUrl: `https://tangled.org/${OWNER_DID}/Core`,
    });
  });

  it.each([
    "https://tangled.org/tangled.org/core/issues/4669",
    "https://tangled.org/tangled.org/core/pulls/0",
    "https://tangled.org/tangled.org/core/pulls/abc",
    "https://tangled.org/tangled.org/core/pull/4669",
    "https://knot1.tangled.sh/tangled.org/core/pulls/4669",
    "https://github.com/tangled.org/core/pulls/4669",
    "ftp://tangled.org/tangled.org/core/pulls/4669",
  ])("leaves %s alone", (url) => {
    expect(parse(url)).toBeNull();
  });

  it("builds pull request and commit URLs on the web host", () => {
    expect(
      definition.changeRequestUrl({
        host: "tangled.org",
        repository: "tangled.org/core",
        number: 8,
      }),
    ).toBe("https://tangled.org/tangled.org/core/pulls/8");
    expect(
      definition.changeRequestUrl({ host: "tangled.org", repository: REPO_DID, number: 8 }),
    ).toBeNull();
    const sha = "8548a4aab2507879e7ef0f04c5a27775c18d942f";
    const commit = definition.commitUrl?.({
      host: "tangled.org",
      repository: "tangled.org/core",
      sha,
    });
    expect(commit).toBe(`https://tangled.org/tangled.org/core/commit/${sha}`);
    expect(definition.parseCommitUrl(new URL(commit ?? ""))).toEqual({
      host: "tangled.org",
      repository: "tangled.org/core",
      sha,
    });
  });

  it("recognizes tg commands that change a pull request", () => {
    expect(definition.checkoutCommand({ number: 12, headBranch: "x" })).toBe("tg pr checkout 12");
    for (const command of ["tg pr merge 12", "tg pr close 12 --comment x"]) {
      expect(definition.changeRequestCloseCommand?.test(command), command).toBe(true);
    }
    expect(definition.changeRequestCloseCommand?.test("tg pr view 12")).toBe(false);
    expect(definition.changeRequestCreateCommand?.test("tg pr create --title x")).toBe(true);
  });
});
