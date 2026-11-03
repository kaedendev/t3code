import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fakeTangled, type FakeRoute, type RecordedRequest } from "./fakeTangled.ts";
import * as TangledPullRequestProvider from "./TangledPullRequestProvider.ts";

const REPO = "did:plc:mergerepoaaaaaaaaaaaaaaa";
const OWNER = "did:plc:ownerownerownerownerowne";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const TIP = "d".repeat(40);
const TICKET = `at://${REPO}/org.tangled.track.ticket/7`;

const commit = (oid: string, message: string) => ({
  oid,
  parents: [BASE],
  author: { name: "Alice", email: "alice@example.com", when: "2026-11-01T10:00:00Z" },
  committer: { name: "Alice", email: "alice@example.com", when: "2026-11-01T10:00:00Z" },
  message,
});

const round = (cid: string) => ({
  uri: `at://${REPO}/org.tangled.review.patch/${cid}`,
  cid,
  value: {
    base: { oid: BASE },
    head: { oid: HEAD },
    source: { branch: "feature", repo: REPO },
    createdAt: "2026-11-02T10:00:00Z",
  },
});

/** An open pull request #7 on `main`, whose tip is TIP, with one round from BASE to HEAD. */
const routes = (
  overrides: { readonly state?: string } & Record<string, FakeRoute> = {},
): Record<string, FakeRoute> => {
  const { state = "open", ...rest } = overrides;
  return {
    "blue.microcosm.identity.resolveMiniDoc": { did: OWNER, handle: "alice.tngl.sh" },
    "org.tangled.repo.getRepoByName": {
      uri: `at://${REPO}/org.tangled.repo.manifest/self`,
      knot: "knot1.tangled.sh",
      defaultBranch: "main",
      value: { declaration: { name: "project", owner: OWNER } },
    },
    "org.tangled.track.getTicketView": {
      uri: TICKET,
      cid: "bafyview",
      author: { did: OWNER, handle: "alice.tngl.sh" },
      title: { text: "Add the thing" },
      state,
      targetBranch: "main",
      createdAt: "2026-11-01T10:00:00Z",
    },
    "org.tangled.temp.review.listPatches": { items: [round("bafyround")] },
    "org.tangled.temp.git.getRef": { oid: TIP },
    "com.atproto.repo.getRecord": {
      uri: TICKET,
      cid: "bafyknot",
      value: {
        $type: "org.tangled.track.ticket",
        title: { $type: "org.tangled.markup.markdown#inline", text: "Add the thing" },
        state,
        targetBranch: "main",
        createdAt: "2026-11-01T10:00:00Z",
        "x-tngl-editor": OWNER,
      },
    },
    "com.atproto.repo.putRecord": { uri: TICKET, cid: "bafynext" },
    "sh.tangled.git.mergeCommit": "",
    ...rest,
  };
};

const merge = Effect.gen(function* () {
  const provider = yield* TangledPullRequestProvider.make;
  yield* provider.runAction({
    cwd: "/repo",
    host: "tangled.org",
    repository: "alice.tngl.sh/project",
    number: 7,
    action: "merge",
    mergeMethod: "rebase",
  });
});

const completedRecord = {
  repo: REPO,
  collection: "org.tangled.track.ticket",
  rkey: "7",
  swapRecord: "bafyknot",
  record: {
    $type: "org.tangled.track.ticket",
    title: { $type: "org.tangled.markup.markdown#inline", text: "Add the thing" },
    state: "completed",
    targetBranch: "main",
    createdAt: "2026-11-01T10:00:00Z",
  },
};

describe("TangledPullRequestProvider merge", () => {
  it.effect("only completes the ticket when the target already contains the head", () => {
    const fake = fakeTangled(routes({ "org.tangled.temp.git.getMergeBase": { commit: HEAD } }));
    return Effect.gen(function* () {
      yield* merge;
      assert.deepStrictEqual(
        fake.writes().map((write) => write.nsid),
        ["com.atproto.repo.putRecord"],
      );
      assert.deepStrictEqual(fake.writes()[0]?.body, completedRecord);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("recognizes a round already rebased onto the target and only completes it", () => {
    const merged = "e".repeat(40);
    const fake = fakeTangled(
      routes({
        "org.tangled.temp.git.getMergeBase": { commit: merged },
        "org.tangled.temp.git.listCommits": (request: RecordedRequest) => ({
          body: {
            commits:
              request.params.get("ranges") === `${BASE}..${HEAD}`
                ? [commit(HEAD, "Add the thing\n")]
                : [commit("f".repeat(40), "Add the thing\n")],
          },
        }),
      }),
    );
    return Effect.gen(function* () {
      yield* merge;
      assert.deepStrictEqual(
        fake.writes().map((write) => write.nsid),
        ["com.atproto.repo.putRecord"],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("rebases through the knot's mirror, then completes the ticket", () => {
    const fake = fakeTangled(
      routes({
        "org.tangled.temp.git.getMergeBase": { commit: BASE },
        "org.tangled.temp.git.listCommits": (request: RecordedRequest) => ({
          body: {
            commits:
              request.params.get("ranges") === `${BASE}..${HEAD}`
                ? [commit(HEAD, "Add the thing\n")]
                : [commit(TIP, "Something else\n")],
          },
        }),
      }),
    );
    return Effect.gen(function* () {
      yield* merge;
      const [mergeCall, complete] = fake.writes();
      assert.strictEqual(mergeCall?.host, "api.tangled.org");
      assert.deepStrictEqual(mergeCall?.body, {
        target: {
          $type: "sh.tangled.git.mergeCommit#target",
          repo: REPO,
          branch: "main",
          commit: TIP,
        },
        source: { $type: "sh.tangled.git.mergeCommit#source", repo: REPO, commit: HEAD },
        style: "rebase",
      });
      assert.deepStrictEqual(complete?.body, completedRecord);
      assert.deepStrictEqual(fake.minted, [
        { aud: "did:web:knot1.tangled.sh", lxm: "org.tangled.git.receivePack" },
        { aud: REPO, lxm: "com.atproto.repo.putRecord" },
      ]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("leaves the ticket open when a newer round arrives during the merge", () => {
    let reads = 0;
    const fake = fakeTangled(
      routes({
        "org.tangled.temp.git.getMergeBase": { commit: BASE },
        "org.tangled.temp.git.listCommits": { commits: [] },
        "org.tangled.temp.review.listPatches": () => ({
          body: {
            items: reads++ === 0 ? [round("bafyround")] : [round("bafyround"), round("bafynewer")],
          },
        }),
      }),
    );
    return Effect.gen(function* () {
      const error = yield* merge.pipe(Effect.flip);
      assert.include(error.detail, "newer round");
      assert.deepStrictEqual(
        fake.writes().map((write) => write.nsid),
        ["sh.tangled.git.mergeCommit"],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("does nothing for a pull request that is already merged", () => {
    const fake = fakeTangled(routes({ state: "completed" }));
    return Effect.gen(function* () {
      yield* merge;
      assert.deepStrictEqual(fake.writes(), []);
    }).pipe(Effect.provide(fake.layer));
  });
});
