import { assert, describe, it } from "@effect/vitest";
import { SourceControlProviderKind, type RepositoryIdentity } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";
import {
  FAKE_PDS,
  fakeTangled,
  KAEDEN,
  type FakeRoute,
  type RecordedRequest,
} from "./fakeTangled.ts";
import * as TangledSourceControlProvider from "./TangledSourceControlProvider.ts";

const REPO = "did:plc:renamedrepoaaaaaaaaaaaaa";
const OWNER = "did:plc:ownerownerownerownerowne";
const KIND = SourceControlProviderKind.make("tangled");

const manifest = (name: string) => ({
  uri: `at://${REPO}/org.tangled.repo.manifest/self`,
  cid: "bafymanifest",
  knot: "knot1.tangled.sh",
  defaultBranch: "main",
  value: { $type: "org.tangled.repo.manifest", declaration: { name, owner: OWNER } },
});

/** The repository as Tangled serves it while its owner's handle is `handle` and its name `name`. */
const world = (handle: string, name: string): Record<string, FakeRoute> => ({
  "blue.microcosm.identity.resolveMiniDoc": (request: RecordedRequest) =>
    [OWNER, handle].includes(request.params.get("identifier") ?? "")
      ? { body: { did: OWNER, handle } }
      : undefined,
  "org.tangled.repo.getRepoByName": (request: RecordedRequest) =>
    request.params.get("owner") === OWNER && request.params.get("name") === name
      ? { body: manifest(name) }
      : undefined,
  "org.tangled.repo.getRepoByRepoDid": manifest(name),
});

const identityFor = (remoteUrl: string, path: string): RepositoryIdentity => ({
  canonicalKey: `tangled.org/${path}`,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  rootPath: "/repo",
  provider: KIND,
  displayName: path,
});

const contextFor = (remoteUrl: string) => ({
  provider: { kind: KIND, name: "Tangled", baseUrl: "https://tangled.org" },
  remoteName: "origin",
  remoteUrl,
});

const layerFor = (fake: ReturnType<typeof fakeTangled>, body = "") =>
  Layer.mergeAll(
    fake.layer,
    TestSourceControlHost.layer(),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed(body) }),
  );

const patch = (branch: string) => ({
  items: [
    {
      uri: `at://${REPO}/org.tangled.review.patch/bafyround`,
      cid: "bafyround",
      value: {
        base: { oid: "b".repeat(40) },
        head: { oid: "c".repeat(40) },
        source: { branch, repo: REPO },
        createdAt: "2026-11-02T10:00:00Z",
      },
    },
  ],
});

const ticket = (rkey: string, author: string) => ({
  uri: `at://${REPO}/org.tangled.track.ticket/${rkey}`,
  cid: `bafy${rkey}`,
  author,
  state: "open",
  commentCount: 0,
  value: {
    $type: "org.tangled.track.ticket",
    title: { text: `Ticket ${rkey}` },
    state: "open",
    targetBranch: "main",
    createdAt: "2026-11-01T10:00:00Z",
  },
});

describe("TangledSourceControlProvider", () => {
  it.effect("keys a renamed repository by its DID, before and after the rename", () => {
    const refine = (fake: ReturnType<typeof fakeTangled>, identity: RepositoryIdentity) =>
      Effect.gen(function* () {
        const provider = yield* TangledSourceControlProvider.make;
        return yield* provider.refineRepositoryIdentity!({
          identity,
          resolveContext: () => Effect.succeed(null),
        });
      }).pipe(Effect.provide(layerFor(fake)));
    return Effect.gen(function* () {
      const before = yield* refine(
        fakeTangled(world("alice.example", "old-name")),
        identityFor("git@tangled.org:alice.example/old-name", "alice.example/old-name"),
      );
      const after = yield* refine(
        fakeTangled(world("alice.tngl.sh", "new-name")),
        identityFor("https://tangled.org/@alice.tngl.sh/new-name.git", "alice.tngl.sh/new-name"),
      );
      assert.strictEqual(before.canonicalKey, `tangled.org/${REPO}`);
      assert.strictEqual(after.canonicalKey, before.canonicalKey);
      assert.strictEqual(
        definition.repositoryKeyFromRemote(`git@tangled.org:${REPO}`),
        before.canonicalKey,
      );
      assert.deepStrictEqual(
        [before.displayName, before.owner, before.name],
        ["alice.example/old-name", "alice.example", "old-name"],
      );
      assert.deepStrictEqual(
        [after.displayName, after.webUrl],
        ["alice.tngl.sh/new-name", "https://tangled.org/alice.tngl.sh/new-name"],
      );
      const github = {
        ...identityFor("git@github.com:a/b", "a/b"),
        provider: SourceControlProviderKind.make("github"),
      };
      assert.strictEqual(
        yield* refine(fakeTangled({}), github),
        github,
        "another host's identity is left alone",
      );
    });
  });

  it.effect("finds the viewer's pull request for a branch among the open ones", () => {
    const branches: Record<string, string> = {
      "7": "feature",
      "8": "feature",
      "9": "other",
      "3mzx": "feature",
    };
    const fake = fakeTangled({
      ...world("alice.tngl.sh", "new-name"),
      "org.tangled.repo.listPulls": {
        items: [
          ticket("7", KAEDEN.did),
          ticket("8", "did:plc:someoneelseaaaaaaaaaaaaa"),
          ticket("9", KAEDEN.did),
          ticket("3mzx", KAEDEN.did),
        ],
      },
      "org.tangled.temp.review.listPatches": (request: RecordedRequest) => {
        const rkey = request.params.get("ticket")?.split("/").at(-1) ?? "";
        return { body: patch(branches[rkey] ?? "none") };
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        context: contextFor("git@tangled.org:alice.tngl.sh/new-name"),
        headSelector: "feature",
        state: "open",
      });
      assert.deepStrictEqual(
        found.map((pull) => [pull.number, pull.headRefName, pull.url, pull.repositoryKey]),
        [
          [
            7,
            "feature",
            "https://tangled.org/alice.tngl.sh/new-name/pulls/7",
            `tangled.org/${REPO}`,
          ],
        ],
      );
      assert.deepStrictEqual(
        fake.calls("org.tangled.temp.review.listPatches").map((call) => call.params.get("ticket")),
        [`at://${REPO}/org.tangled.track.ticket/7`, `at://${REPO}/org.tangled.track.ticket/9`],
        "only the viewer's tickets with integer numbers are read",
      );
    }).pipe(Effect.provide(layerFor(fake)));
  });

  const HEAD = "c".repeat(40);
  const TIP = "d".repeat(40);
  const BASE = "b".repeat(40);
  const createRoutes = (submitPatch: FakeRoute): Record<string, FakeRoute> => ({
    ...world("alice.tngl.sh", "new-name"),
    "org.tangled.temp.git.getRef": (request: RecordedRequest) => ({
      body: { oid: request.params.get("ref") === "refs/heads/feature" ? HEAD : TIP },
    }),
    "org.tangled.temp.git.getMergeBase": { commit: BASE },
    "com.atproto.repo.createRecord": {
      uri: `at://${REPO}/org.tangled.track.ticket/42`,
      cid: "bafyticket",
    },
    "org.tangled.review.submitPatch": submitPatch,
    "com.atproto.repo.deleteRecord": "",
  });
  const create = Effect.gen(function* () {
    const provider = yield* TangledSourceControlProvider.make;
    return yield* provider.createChangeRequest({
      cwd: "/repo",
      context: contextFor("git@tangled.org:alice.tngl.sh/new-name"),
      baseRefName: "main",
      headSelector: "feature",
      title: "Add the thing",
      bodyFile: "/tmp/body.md",
    });
  });

  it.effect(
    "opens a ticket with a knot-minted key, then submits the pushed range as round one",
    () => {
      const fake = fakeTangled(
        createRoutes({ uri: `at://${REPO}/org.tangled.review.patch/bafyp`, cid: "bafyp" }),
      );
      return Effect.gen(function* () {
        yield* create;
        const [base] = fake.calls("org.tangled.temp.git.getMergeBase");
        assert.deepStrictEqual(
          [base?.params.getAll("repos"), base?.params.get("base"), base?.params.get("head")],
          [[REPO], TIP, HEAD],
        );
        const [record, submit] = fake.writes();
        assert.strictEqual(record?.host, "knot1.tangled.sh");
        assert.strictEqual(record?.nsid, "com.atproto.repo.createRecord");
        assert.deepStrictEqual(record?.body, {
          repo: REPO,
          collection: "org.tangled.track.ticket",
          record: {
            $type: "org.tangled.track.ticket",
            title: { $type: "org.tangled.markup.markdown#inline", text: "Add the thing" },
            body: { $type: "org.tangled.markup.markdown", text: "Why it matters" },
            state: "open",
            targetBranch: "main",
            createdAt: "1970-01-01T00:00:00.000Z",
          },
        });
        assert.strictEqual(submit?.nsid, "org.tangled.review.submitPatch");
        assert.deepStrictEqual(submit?.body, {
          repo: REPO,
          patch: {
            ticket: "42",
            base: { oid: BASE },
            head: { oid: HEAD },
            sourceRepo: REPO,
            sourceBranch: "feature",
          },
        });
        assert.deepStrictEqual(fake.minted, [
          { aud: REPO, lxm: "com.atproto.repo.createRecord" },
          { aud: REPO, lxm: "org.tangled.review.submitPatch" },
        ]);
      }).pipe(Effect.provide(layerFor(fake, "Why it matters")));
    },
  );

  it.effect("removes the ticket when the knot refuses its round", () => {
    const fake = fakeTangled(
      createRoutes(() => ({
        status: 400,
        body: { error: "InvalidRequest", message: "head is not on feature" },
      })),
    );
    return Effect.gen(function* () {
      const error = yield* create.pipe(Effect.flip);
      assert.strictEqual(error.detail, "head is not on feature");
      assert.deepStrictEqual(
        fake.writes().map((write) => write.nsid),
        [
          "com.atproto.repo.createRecord",
          "org.tangled.review.submitPatch",
          "com.atproto.repo.deleteRecord",
        ],
      );
      assert.deepStrictEqual(fake.writes()[2]?.body, {
        repo: REPO,
        collection: "org.tangled.track.ticket",
        rkey: "42",
        swapRecord: "bafyticket",
      });
    }).pipe(Effect.provide(layerFor(fake)));
  });

  describe("after T3 pushes a branch", () => {
    const PUSHED = "e".repeat(40);
    const SOMEONE = "did:plc:someoneelseaaaaaaaaaaaaa";
    const round = (cid: string, head: string) => ({
      uri: `at://${REPO}/org.tangled.review.patch/${cid}`,
      cid,
      value: {
        base: { oid: BASE },
        head: { oid: head },
        source: { branch: "feature", repo: REPO },
        createdAt: "2026-11-02T10:00:00Z",
      },
    });
    /** #7 is the viewer's and #8 someone else's, both proposing `feature` at `latest`. */
    const pushRoutes = (latest: string): Record<string, FakeRoute> => {
      let submitted = false;
      return {
        ...world("alice.tngl.sh", "new-name"),
        "org.tangled.repo.listPulls": { items: [ticket("7", KAEDEN.did), ticket("8", SOMEONE)] },
        "org.tangled.temp.review.listPatches": () => ({
          body: {
            items: submitted
              ? [round("bafyround", latest), round("bafynext", PUSHED)]
              : [round("bafyround", latest)],
          },
        }),
        "org.tangled.temp.git.getRef": (request: RecordedRequest) => ({
          body: { oid: request.params.get("ref") === "refs/heads/feature" ? PUSHED : TIP },
        }),
        "org.tangled.temp.git.getMergeBase": { commit: BASE },
        "org.tangled.review.submitPatch": () => {
          submitted = true;
          return {
            body: { uri: `at://${REPO}/org.tangled.review.patch/bafynext`, cid: "bafynext" },
          };
        },
      };
    };
    const remote = TestSourceControlHost.layer({
      git: {
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        readConfigValue: () => Effect.succeed("git@tangled.org:alice.tngl.sh/new-name"),
      },
    });
    const pushedLayer = (fake: ReturnType<typeof fakeTangled>) =>
      Layer.mergeAll(fake.layer, remote, FileSystem.layerNoop({}));
    const push = Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      yield* provider.branchPushed!({ cwd: "/repo", branch: "feature", headSha: PUSHED });
    });

    it.effect("submits the pushed head as the next round of the viewer's pull request", () => {
      const fake = fakeTangled(pushRoutes(HEAD));
      return Effect.gen(function* () {
        yield* push;
        assert.deepStrictEqual(
          fake.writes().map((write) => write.body),
          [
            {
              repo: REPO,
              patch: {
                ticket: "7",
                base: { oid: BASE },
                head: { oid: PUSHED },
                sourceRepo: REPO,
                sourceBranch: "feature",
              },
            },
          ],
        );
        assert.deepStrictEqual(fake.minted, [{ aud: REPO, lxm: "org.tangled.review.submitPatch" }]);
      }).pipe(Effect.provide(pushedLayer(fake)));
    });

    it.effect("names the pull request it could not resubmit", () => {
      const fake = fakeTangled({
        ...pushRoutes(HEAD),
        "org.tangled.review.submitPatch": () => ({
          status: 400,
          body: { error: "InvalidRequest", message: "head is not on feature" },
        }),
      });
      return Effect.gen(function* () {
        const error = yield* push.pipe(Effect.flip);
        assert.strictEqual(
          error.detail,
          "Pull request #7 was not resubmitted. head is not on feature",
        );
      }).pipe(Effect.provide(pushedLayer(fake)));
    });

    it.effect("submits nothing when the latest round already has the pushed head", () => {
      const fake = fakeTangled(pushRoutes(PUSHED));
      return Effect.gen(function* () {
        yield* push;
        assert.deepStrictEqual(fake.writes(), []);
      }).pipe(Effect.provide(pushedLayer(fake)));
    });

    it.effect("leaves someone else's pull request for the branch alone", () => {
      const fake = fakeTangled(pushRoutes(HEAD), {
        viewer: { did: SOMEONE.replace("someone", "stranger"), handle: "stranger.example" },
      });
      return Effect.gen(function* () {
        yield* push;
        assert.deepStrictEqual(fake.writes(), []);
      }).pipe(Effect.provide(pushedLayer(fake)));
    });
  });

  describe("creating a repository", () => {
    const NEW = "did:plc:newrepoaaaaaaaaaaaaaaaaa";
    const DECLARATION = `at://${KAEDEN.did}/org.tangled.repo.declaration/demo`;
    const createRoutes = (
      overrides: {
        readonly declared?: boolean;
        readonly claim?: FakeRoute;
        /** The claim's write landed even though its reply was an error. */
        readonly claimLanded?: boolean;
      } = {},
    ): Record<string, FakeRoute> => {
      let claimed = false;
      const claim = overrides.claim ?? { uri: DECLARATION, cid: "bafydecl" };
      return {
        "com.atproto.repo.getRecord": (request: RecordedRequest) =>
          request.host === FAKE_PDS && (overrides.declared || (claimed && overrides.claimLanded))
            ? { body: { uri: DECLARATION, cid: "bafyold" } }
            : undefined,
        "com.atproto.repo.createRecord": (request: RecordedRequest) => {
          claimed = true;
          return typeof claim === "function" ? claim(request) : { body: claim };
        },
        "org.tangled.repo.createRepo": { did: NEW },
        "org.tangled.repo.deleteRepo": {},
        "org.tangled.repo.getRepoByRepoDid": manifest("Demo"),
      };
    };
    const createRepository = (visibility: "public" | "private" = "public") =>
      Effect.gen(function* () {
        const provider = yield* TangledSourceControlProvider.make;
        return yield* provider.createRepository({
          cwd: "/repo",
          repository: "kaeden.codes/Demo",
          visibility,
        });
      });

    it.effect("has the knot mint it, then claims it on the owner's PDS", () => {
      const fake = fakeTangled(createRoutes());
      return Effect.gen(function* () {
        const urls = yield* createRepository();
        assert.deepStrictEqual(
          fake.requests.map((request) => [request.method, request.host, request.nsid]),
          [
            ["GET", FAKE_PDS, "com.atproto.repo.getRecord"],
            ["POST", "knot1.tangled.sh", "org.tangled.repo.createRepo"],
            ["POST", FAKE_PDS, "com.atproto.repo.createRecord"],
            ["GET", "api.tangled.org", "org.tangled.repo.getRepoByRepoDid"],
            ["GET", "api.tangled.org", "blue.microcosm.identity.resolveMiniDoc"],
          ],
        );
        const [lookup, mint, claim] = fake.requests;
        assert.deepStrictEqual(
          [lookup?.params.get("collection"), lookup?.params.get("rkey")],
          ["org.tangled.repo.declaration", "demo"],
        );
        assert.deepStrictEqual(mint?.body, { name: "Demo", createdAt: "1970-01-01T00:00:00.000Z" });
        assert.deepStrictEqual(fake.minted, [
          { aud: "did:web:knot1.tangled.sh", lxm: "org.tangled.repo.createRepo" },
        ]);
        assert.deepStrictEqual(claim?.body, {
          repo: KAEDEN.did,
          collection: "org.tangled.repo.declaration",
          rkey: "demo",
          record: {
            $type: "org.tangled.repo.declaration",
            repo: NEW,
            createdAt: "1970-01-01T00:00:00.000Z",
          },
        });
        assert.deepStrictEqual(urls, {
          nameWithOwner: "kaeden.codes/Demo",
          url: `https://tangled.org/${NEW}`,
          sshUrl: `git@tangled.org:${NEW}`,
        });
      }).pipe(Effect.provide(layerFor(fake)));
    });

    it.effect("asks no knot for a repository the owner already declared", () => {
      const fake = fakeTangled(createRoutes({ declared: true }));
      return Effect.gen(function* () {
        const failure = yield* createRepository().pipe(Effect.flip);
        assert.include(failure.detail, "already have a Tangled repository named Demo");
        assert.deepStrictEqual(fake.writes(), []);
      }).pipe(Effect.provide(layerFor(fake)));
    });

    it.effect("refuses a private repository before asking anyone", () => {
      const fake = fakeTangled(createRoutes());
      return Effect.gen(function* () {
        const failure = yield* createRepository("private").pipe(Effect.flip);
        assert.include(failure.detail, "public");
        assert.deepStrictEqual(fake.requests, []);
      }).pipe(Effect.provide(layerFor(fake)));
    });

    const refusedClaim = () => ({
      status: 400,
      body: { error: "InvalidRequest", message: "no scope" },
    });

    it.effect("removes the minted repository when its claim is refused", () => {
      const fake = fakeTangled(createRoutes({ claim: refusedClaim }));
      return Effect.gen(function* () {
        const failure = yield* createRepository().pipe(Effect.flip);
        assert.include(failure.detail, "no scope");
        const removal = fake.requests.find((r) => r.nsid === "org.tangled.repo.deleteRepo");
        assert.deepStrictEqual(removal?.body, { repo: NEW });
        assert.deepStrictEqual(fake.minted.at(-1), {
          aud: "did:web:knot1.tangled.sh",
          lxm: "org.tangled.repo.deleteRepo",
        });
      }).pipe(Effect.provide(layerFor(fake)));
    });

    it.effect("keeps the repository when a claim that reported failure landed", () => {
      const fake = fakeTangled(createRoutes({ claim: refusedClaim, claimLanded: true }));
      return Effect.gen(function* () {
        const urls = yield* createRepository();
        assert.strictEqual(urls.url, `https://tangled.org/${NEW}`);
        assert.isUndefined(fake.requests.find((r) => r.nsid === "org.tangled.repo.deleteRepo"));
      }).pipe(Effect.provide(layerFor(fake)));
    });
  });
});
