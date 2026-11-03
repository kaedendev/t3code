import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { fakeTangled, type FakeRoute, type RecordedRequest } from "./fakeTangled.ts";
import containerfile from "./fixtures/getBlob-Containerfile.json" with { type: "json" };
import getInterdiff from "./fixtures/getInterdiff.json" with { type: "json" };
import getRepoByRepoDid from "./fixtures/getRepoByRepoDid.json" with { type: "json" };
import getTicketView from "./fixtures/getTicketView-rounds.json" with { type: "json" };
import listPatches from "./fixtures/listPatches-rounds.json" with { type: "json" };
import resolveMiniDoc from "./fixtures/resolveMiniDoc.json" with { type: "json" };
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

describe("TangledPullRequestProvider detail", () => {
  it.effect("moves with a comment left on Tangled, so activity is read again", () => {
    const comment = (createdAt: string) => ({
      uri: `at://${REPO}/org.tangled.feed.comment/${createdAt}`,
      cid: "bafycomment",
      editor: OWNER,
      createdAt,
      body: { text: "lgtm" },
      subject: { uri: TICKET, cid: "bafyview" },
    });
    let comments: ReadonlyArray<ReturnType<typeof comment>> = [];
    const fake = fakeTangled(
      routes({ "org.tangled.feed.listComments": () => ({ body: { items: comments } }) }),
    );
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      const read = provider.getChangeRequest({
        cwd: "/repo",
        host: "tangled.org",
        repository: "alice.tngl.sh/project",
        number: 7,
      });
      assert.strictEqual((yield* read).updatedAt, "2026-11-02T10:00:00.000Z");
      comments = [comment("2026-11-03T08:00:00Z")];
      assert.strictEqual((yield* read).updatedAt, "2026-11-03T08:00:00.000Z");
    }).pipe(Effect.provide(fake.layer));
  });
});

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

describe("TangledPullRequestProvider resubmit", () => {
  const MOVED = "e".repeat(40);
  const ALICE = { did: OWNER, handle: "alice.tngl.sh" };
  const ref = { cwd: "/repo", host: "tangled.org", repository: "alice.tngl.sh/project", number: 7 };
  /** #7 is Alice's; `feature` is at `tip`, and a submitted round shows up in listPatches. */
  const resubmitRoutes = (tip: string, state = "open") => {
    let submitted = false;
    return routes({
      state,
      "org.tangled.temp.git.getRef": (request: RecordedRequest) => ({
        body: { oid: request.params.get("ref") === "refs/heads/feature" ? tip : TIP },
      }),
      "org.tangled.temp.git.getMergeBase": { commit: BASE },
      "org.tangled.temp.review.listPatches": () => ({
        body: {
          items: submitted
            ? [
                round("bafyround"),
                {
                  ...round("bafynext"),
                  value: { ...round("bafynext").value, head: { oid: MOVED } },
                },
              ]
            : [round("bafyround")],
        },
      }),
      "org.tangled.review.submitPatch": () => {
        submitted = true;
        return { body: { uri: `at://${REPO}/org.tangled.review.patch/bafynext`, cid: "bafynext" } };
      },
    });
  };
  const offered = (fake: ReturnType<typeof fakeTangled>) =>
    Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      const permissions = yield* provider.getViewerPermissions(ref);
      return permissions.actions.includes("resubmit");
    }).pipe(Effect.provide(fake.layer));

  it.effect("is offered to the author of an open pull request whose branch moved on", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* offered(fakeTangled(resubmitRoutes(MOVED), { viewer: ALICE })));
      assert.isFalse(
        yield* offered(fakeTangled(resubmitRoutes(HEAD), { viewer: ALICE })),
        "the latest round has the branch's head",
      );
      assert.isFalse(
        yield* offered(fakeTangled(resubmitRoutes(MOVED, "closed"), { viewer: ALICE })),
        "closed",
      );
      assert.isFalse(yield* offered(fakeTangled(resubmitRoutes(MOVED))), "not the author");
    }),
  );

  it.effect("submits the branch's head as the next round", () => {
    const fake = fakeTangled(resubmitRoutes(MOVED), { viewer: ALICE });
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      yield* provider.runAction({ ...ref, action: "resubmit" });
      assert.deepStrictEqual(
        fake.writes().map((write) => write.body),
        [
          {
            repo: REPO,
            patch: {
              ticket: "7",
              base: { oid: BASE },
              head: { oid: MOVED },
              sourceRepo: REPO,
              sourceBranch: "feature",
            },
          },
        ],
      );
    }).pipe(Effect.provide(fake.layer));
  });
});

// tangled.org/core#4618, from a fork: round 2 amended round 1, round 3 only rebased round 2.
const CORE = "did:plc:j5hmlfdrwkvtxm7cjmu7j2is";
const FORK = "did:plc:ueozxjczm32mgsvmfvnbyhyr";
const [R1, R2, R3] = listPatches.items.map((patch) => patch.value);

const interdiffOf = (from: typeof R1, to: typeof R1) =>
  [from?.base.oid, from?.head.oid, to?.base.oid, to?.head.oid].join(" ");

const fork = (calls: Array<RecordedRequest>) => ({
  "blue.microcosm.identity.resolveMiniDoc": resolveMiniDoc,
  "org.tangled.repo.getRepoByName": getRepoByRepoDid,
  "org.tangled.track.getTicketView": getTicketView,
  "org.tangled.temp.review.listPatches": listPatches,
  "sh.tangled.git.temp2.getDiff": { diffs: [] },
  // Answers only in the order knotmirror reads: the earlier round's range, then the later one's.
  "sh.tangled.git.temp2.getInterdiff": (request: RecordedRequest) => {
    calls.push(request);
    const asked = ["baseCommit1", "baseCommit2", "headCommit1", "headCommit2"]
      .map((key) => request.params.get(key))
      .join(" ");
    return asked === interdiffOf(R1, R3)
      ? { body: getInterdiff }
      : asked === interdiffOf(R2, R3)
        ? { body: { diffs: [] } }
        : undefined;
  },
  "org.tangled.temp.git.getBlob": (request: RecordedRequest) =>
    request.params.get("repo") === FORK && request.params.get("ref") === R3?.head.oid
      ? { body: containerfile.text }
      : undefined,
});

const pull = { cwd: "/repo", host: "tangled.org", repository: "tangled.org/core", number: 4618 };

describe("TangledPullRequestProvider rounds", () => {
  it.effect("lists every round, oldest first", () => {
    const fake = fakeTangled(fork([]));
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      assert.isTrue(provider.capabilities.rounds);
      const rounds = yield* provider.listRounds!(pull);
      assert.deepStrictEqual(
        rounds.map((round) => [round.number, round.baseSha, round.headSha, round.createdAt]),
        listPatches.items.map((patch, index) => [
          index + 1,
          patch.value.base.oid,
          patch.value.head.oid,
          `${patch.value.createdAt.slice(0, -1)}.000Z`,
        ]),
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reads an earlier round as it was submitted, against the target", () => {
    const fake = fakeTangled(fork([]));
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      yield* provider.getDiffFilePaths!({ ...pull, round: { number: 1 } });
      const [diff] = fake.calls("sh.tangled.git.temp2.getDiff");
      assert.deepStrictEqual(
        ["baseRepo", "baseCommit", "headRepo", "headCommit"].map((key) => diff?.params.get(key)),
        [CORE, R1?.base.oid, FORK, R1?.head.oid],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("shows what changed since a round through Tangled's interdiff", () => {
    const interdiffs: Array<RecordedRequest> = [];
    const fake = fakeTangled(fork(interdiffs));
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      const since = { ...pull, round: { number: 3, since: 1 } };
      const slice = yield* provider.getDiff(since);
      assert.include(slice.patch, '-CMD ["/etc/knot/config.toml"]');
      assert.include(slice.patch, '+CMD ["--config", "/etc/knot/config.toml"]');
      const contents = yield* provider.getDiffFileContents!({
        ...since,
        changeType: "change",
        oldPath: "knot2/Containerfile",
        newPath: "knot2/Containerfile",
      });
      assert.strictEqual(contents.oldContents, getInterdiff.diffs[0]?.lhsSrc.content);
      assert.strictEqual(contents.newContents, containerfile.text);
      // Round 3 only rebased round 2, so nothing the target gained since shows as a change.
      const rebased = yield* provider.getDiffFilePaths!({
        ...pull,
        round: { number: 3, since: 2 },
      });
      assert.deepStrictEqual(rebased.files, []);
      assert.deepStrictEqual(
        interdiffs.map((request) => [
          request.params.get("baseRepo"),
          request.params.get("headRepo"),
        ]),
        [
          [FORK, FORK],
          [FORK, FORK],
          [FORK, FORK],
        ],
      );
      // The rebased left side exists only inline, so no blob is read for it.
      assert.deepStrictEqual(
        fake.calls("org.tangled.temp.git.getBlob").map((request) => request.params.get("ref")),
        [R3?.head.oid ?? null, R3?.head.oid ?? null],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses a round the pull request does not have", () => {
    const fake = fakeTangled(fork([]));
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      const error = yield* provider
        .getDiff({ ...pull, round: { number: 4, since: 1 } })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-found");
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("TangledPullRequestProvider listing", () => {
  const OTHER = "did:plc:otherrepoaaaaaaaaaaaaaaaa";
  const ticket = (repoDid: string, rkey: string) => ({
    uri: `at://${repoDid}/org.tangled.track.ticket/${rkey}`,
    cid: `bafy${rkey}`,
    author: OWNER,
    state: "open",
    value: {
      title: { text: `Pull ${rkey}` },
      state: "open",
      targetBranch: "main",
      createdAt: "2026-11-01T10:00:00Z",
    },
  });
  /** `alice.tngl.sh/project` has #7 and #8 open, and `alice.tngl.sh/other` has #1. */
  const listing = () =>
    routes({
      "org.tangled.repo.getRepoByName": (request: RecordedRequest) => ({
        body: {
          uri: `at://${request.params.get("name") === "other" ? OTHER : REPO}/org.tangled.repo.manifest/self`,
          knot: "knot1.tangled.sh",
          value: { declaration: { name: request.params.get("name"), owner: OWNER } },
        },
      }),
      "org.tangled.repo.listPulls": (request: RecordedRequest) => ({
        body: {
          items:
            request.params.get("subject") === OTHER
              ? [ticket(OTHER, "1")]
              : [ticket(REPO, "7"), ticket(REPO, "8")],
        },
      }),
    });
  const project = { cwd: "/repo", host: "tangled.org", repository: "alice.tngl.sh/project" };
  const other = { ...project, repository: "alice.tngl.sh/other" };

  it.effect("a refresh re-reads the rounds of only the pull requests it names", () => {
    const fake = fakeTangled(listing());
    return Effect.gen(function* () {
      const provider = yield* TangledPullRequestProvider.make;
      const forget = provider.forgetChangeRequestReads!;
      let seen = 0;
      const list = (ref: typeof project) =>
        provider.listChangeRequests({
          ...ref,
          state: "open",
          involvement: "all",
          viewer: "alice.tngl.sh",
          limit: 20,
        });
      /** The tickets whose rounds Tangled was asked for since the last look. */
      const roundsRead = () => {
        const calls = fake.calls("org.tangled.temp.review.listPatches");
        const read = calls
          .slice(seen)
          .map((request) => request.params.get("ticket")?.split("/").pop());
        seen = calls.length;
        return read.toSorted();
      };

      yield* list(project);
      yield* list(other);
      assert.deepStrictEqual(roundsRead(), ["1", "7", "8"]);

      yield* forget({ repository: other.repository, number: 1 });
      yield* list(project);
      yield* list(other);
      assert.deepStrictEqual(roundsRead(), ["1"]);

      yield* forget({ repository: project.repository, number: 7 });
      yield* list(project);
      assert.deepStrictEqual(roundsRead(), ["7"]);

      yield* forget({ repository: project.repository });
      yield* list(project);
      yield* list(other);
      assert.deepStrictEqual(roundsRead(), ["7", "8"]);

      yield* forget();
      yield* list(project);
      yield* list(other);
      assert.deepStrictEqual(roundsRead(), ["1", "7", "8"]);

      // Rounds read just before the repository's entry lapses outlive it.
      yield* TestClock.adjust(Duration.seconds(570));
      yield* list(project);
      assert.deepStrictEqual(roundsRead(), ["7", "8"]);
      yield* TestClock.adjust(Duration.seconds(40));
      yield* forget({ repository: project.repository, number: 7 });
      yield* list(project);
      assert.deepStrictEqual(roundsRead(), ["7", "8"]);
    }).pipe(Effect.provide(fake.layer));
  });
});
