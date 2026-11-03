import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fakeTangled } from "./fakeTangled.ts";
import getDiff from "./fixtures/getDiff.json" with { type: "json" };
import getRef from "./fixtures/getRef.json" with { type: "json" };
import getRepoByRepoDid from "./fixtures/getRepoByRepoDid.json" with { type: "json" };
import getTicketView from "./fixtures/getTicketView.json" with { type: "json" };
import listComments from "./fixtures/listComments.json" with { type: "json" };
import listCommits from "./fixtures/listCommits.json" with { type: "json" };
import listPatches from "./fixtures/listPatches.json" with { type: "json" };
import listPulls from "./fixtures/listPulls.json" with { type: "json" };
import queryPipelines from "./fixtures/queryPipelines.json" with { type: "json" };
import resolveMiniDoc from "./fixtures/resolveMiniDoc.json" with { type: "json" };
import * as TangledApi from "./TangledApi.ts";
import { checksStateOf, pipelineChecks } from "./TangledPullRequestProvider.ts";
import { lineStats } from "./tangledPatch.ts";

const CORE = "did:plc:j5hmlfdrwkvtxm7cjmu7j2is";
const OWNER = "did:plc:wshs7t2adsemcrrd4snkeqli";

const core = {
  "blue.microcosm.identity.resolveMiniDoc": resolveMiniDoc,
  "org.tangled.repo.getRepoByName": getRepoByRepoDid,
  "org.tangled.repo.getRepoByRepoDid": getRepoByRepoDid,
};

describe("TangledApi", () => {
  it.effect("resolves tangled.org/core by name and remembers it under its repo DID", () => {
    const fake = fakeTangled(core);
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      const byName = yield* api.resolveRepository({
        kind: "named",
        owner: "tangled.org",
        name: "core",
      });
      assert.deepStrictEqual(byName, {
        repoDid: CORE,
        ownerDid: OWNER,
        ownerHandle: "tangled.org",
        name: "core",
        knot: "knot1.tangled.sh",
        defaultBranch: "master",
        spindle: "did:web:spindle.tangled.network",
      });
      const byDid = yield* api.resolveRepository({ kind: "repo-did", repoDid: CORE });
      assert.deepStrictEqual(byDid, byName);
      assert.strictEqual(fake.calls("org.tangled.repo.getRepoByRepoDid").length, 0);
      assert.strictEqual(
        fake.calls("org.tangled.repo.getRepoByName")[0]?.params.get("owner"),
        OWNER,
      );
      assert.strictEqual(TangledApi.webUrl(byName), "https://tangled.org/tangled.org/core");
      assert.strictEqual(TangledApi.repositoryKey(byName), `tangled.org/${CORE}`);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reads pull requests, rounds, the ticket, comments and commits from bobbin", () => {
    const fake = fakeTangled({
      "org.tangled.repo.listPulls": {
        ...listPulls,
        // A row that is not a ticket is skipped rather than failing the page.
        items: [...listPulls.items, { uri: "at://x/y/z", value: { nonsense: true } }],
      },
      "org.tangled.temp.review.listPatches": listPatches,
      "org.tangled.track.getTicketView": getTicketView,
      "org.tangled.feed.listComments": listComments,
      "org.tangled.temp.git.listCommits": listCommits,
      "org.tangled.temp.git.getRef": getRef,
    });
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      const page = yield* api.listPulls({ repoDid: CORE, state: "open", limit: 2 });
      assert.deepStrictEqual(
        page.items.map((ticket) => [ticket.rkey, ticket.state, ticket.targetBranch]),
        [
          ["4669", "open", "master"],
          ["4668", "open", "master"],
        ],
      );
      assert.strictEqual(page.items[0]?.title, "sitesd: accept padded base64 in refs records");
      assert.strictEqual(page.cursor, listPulls.cursor);
      assert.strictEqual(fake.calls("org.tangled.repo.listPulls")[0]?.params.get("status"), "open");

      const ticket = TangledApi.ticketUri(CORE, "4669");
      assert.deepStrictEqual(yield* api.listRounds(ticket), [
        {
          round: 1,
          uri: listPatches.items[0]?.uri ?? "",
          cid: listPatches.items[0]?.cid ?? "",
          baseOid: "02d9ff54fcdb96ae5665feb794aa14ba24302a79",
          headOid: "8548a4aab2507879e7ef0f04c5a27775c18d942f",
          sourceRepoDid: CORE,
          sourceBranch: "op/mppvswrwourq",
          createdAt: "2026-11-02T23:53:57Z",
        },
      ]);
      yield* api.listRounds(ticket);
      assert.strictEqual(fake.calls("org.tangled.temp.review.listPatches").length, 1);

      const view = yield* api.getTicket({ repoDid: CORE, rkey: "4665" });
      assert.strictEqual(view.state, "completed");
      assert.strictEqual(view.authorHandle, "ptr.pet");

      const [comment] = yield* api.listComments(TangledApi.ticketUri(CORE, "4665"));
      assert.strictEqual(comment?.body, "lgtm");
      assert.strictEqual(comment?.authorDid, "did:plc:qfpnj4og54vl56wngdriaxug");

      const [commit] = yield* api.listCommits({
        repoDids: [CORE],
        range: "02d9ff5..8548a4a",
        limit: 5,
      });
      assert.strictEqual(commit?.parents[0], "02d9ff54fcdb96ae5665feb794aa14ba24302a79");
      assert.strictEqual(
        yield* api.getRef({ repoDid: CORE, ref: "refs/heads/master" }),
        "02d9ff54fcdb96ae5665feb794aa14ba24302a79",
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reads a missing ref as null and other failures as typed errors", () => {
    const fake = fakeTangled({
      "org.tangled.temp.git.getRef": () => ({ status: 404, body: { error: "RefNotFound" } }),
      "org.tangled.repo.listPulls": () => ({ status: 429, body: { error: "RateLimitExceeded" } }),
    });
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      assert.isNull(yield* api.getRef({ repoDid: CORE, ref: "refs/heads/gone" }));
      const error = yield* api.listPulls({ repoDid: CORE, limit: 1 }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "rate-limited");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("turns spindle workflows and structural diffs into checks and line counts", () => {
    const fake = fakeTangled({
      ...core,
      "org.tangled.ci.queryPipelines": queryPipelines,
      "sh.tangled.git.temp2.getDiff": getDiff,
    });
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      const repository = yield* api.resolveRepository({ kind: "repo-did", repoDid: CORE });
      const head = "8548a4aab2507879e7ef0f04c5a27775c18d942f";
      const pipelines = yield* api.queryPipelines({ repository, commits: [head] });
      const [query] = fake.calls("org.tangled.ci.queryPipelines");
      assert.strictEqual(query?.host, "spindle.tangled.network");
      assert.deepStrictEqual(query?.params.getAll("commits"), [head]);
      const checks = pipelineChecks(repository, pipelines);
      assert.deepStrictEqual(
        checks.map((check) => [check.name, check.status]),
        [
          ["commit-lint.yml", "success"],
          ["fmt.yml", "success"],
        ],
      );
      assert.strictEqual(
        checks[0]?.url,
        "https://tangled.org/tangled.org/core/pipelines/3mzejhzchn722",
      );
      assert.strictEqual(checksStateOf(checks), "passing");
      const blocked = pipelineChecks(repository, [
        { ...pipelines[0]!, workflows: [{ id: "test.yml", name: "test.yml", status: "blocked" }] },
      ]);
      assert.strictEqual(blocked[0]?.status, "action-required");
      assert.strictEqual(checksStateOf(blocked), "pending");

      const files = yield* api.getDiff({
        baseRepoDid: CORE,
        baseCommit: "02d9ff54fcdb96ae5665feb794aa14ba24302a79",
        headRepoDid: CORE,
        headCommit: head,
      });
      assert.deepStrictEqual(
        files.map((file) => [file.rhsSrc.path, lineStats(file)]),
        [
          ["sitesd/sitefeed/feed.go", { additions: 1, deletions: 0 }],
          ["sitesd/sitefeed/feed_test.go", { additions: 27, deletions: 0 }],
        ],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("authorizes record writes for the repository and merges for its knot", () => {
    const fake = fakeTangled({
      ...core,
      "com.atproto.repo.createRecord": {
        uri: `at://${CORE}/org.tangled.feed.comment/3abc`,
        cid: "bafy",
      },
      "sh.tangled.git.mergeCommit": "",
    });
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      const repository = yield* api.resolveRepository({ kind: "repo-did", repoDid: CORE });
      const receipt = yield* api.write({
        service: "knot",
        repository,
        nsid: TangledApi.NSID.createRecord,
        body: { collection: "org.tangled.feed.comment", record: {} },
      });
      assert.deepStrictEqual(receipt, {
        uri: `at://${CORE}/org.tangled.feed.comment/3abc`,
        cid: "bafy",
      });
      yield* api.write({
        service: "bobbin",
        repository,
        nsid: TangledApi.NSID.mergeCommit,
        body: { style: "rebase" },
      });
      assert.deepStrictEqual(fake.minted, [
        { aud: CORE, lxm: "com.atproto.repo.createRecord" },
        { aud: "did:web:knot1.tangled.sh", lxm: "org.tangled.git.receivePack" },
      ]);
      const [record, merge] = fake.writes();
      assert.strictEqual(record?.host, "knot1.tangled.sh");
      assert.strictEqual(record?.token, "token:com.atproto.repo.createRecord");
      assert.strictEqual(record?.body?.repo, CORE);
      assert.strictEqual(merge?.host, "api.tangled.org");
      assert.deepStrictEqual(merge?.body, { style: "rebase" });
    }).pipe(Effect.provide(fake.layer));
  });
});
