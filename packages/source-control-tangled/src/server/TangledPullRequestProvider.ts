import {
  SourceControlProviderKind,
  type PullRequestActor,
  type PullRequestCapabilities,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestCheckStatus,
  type PullRequestRoundSelection,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { dedupeChecks, sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { definition, parseTangledRepository, TANGLED_WEB_HOST } from "../shared/definition.ts";
import * as TangledApi from "./TangledApi.ts";
import { TangledAuth, type TangledAuthError } from "./TangledAuth.ts";
import { pullRequestUrl, ticketNumber } from "./TangledSourceControlProvider.ts";
import * as TangledPatch from "./tangledPatch.ts";
import * as TangledRound from "./tangledRound.ts";

const KIND = SourceControlProviderKind.make("tangled");

// Tangled has no drafts, reviewers, verdicts, line anchors, labels in T3's sense, auto-merge or
// branch updates, and merges only by rebase.
const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["rebase"],
  search: false,
  reactions: false,
  labels: false,
  // Comments thread on Tangled, but T3 replies only within line-anchored review threads.
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: false },
  rounds: true,
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Tangled needs a sign-in on the server. Sign in from Settings → Source control → Tangled.",
  unauthenticated:
    "Tangled no longer accepts the server's sign-in. Sign in again from Settings → Source control → Tangled.",
};

const PAGE_SIZE = 100;
const COMMIT_LIMIT = 100;

type ApiError = TangledApi.TangledApiError | TangledAuthError;
type PullRef = ProviderRepositoryRef & { readonly number: number };

function tangledProviderFailure(error: ApiError): PullRequestProviderFailure {
  if (error._tag === "TangledAuthError")
    return { reason: error.reason === "failed" ? "failed" : "unauthenticated" };
  return {
    reason:
      error.reason === "not-found" ||
      error.reason === "unauthenticated" ||
      error.reason === "rate-limited"
        ? error.reason
        : "failed",
  };
}

const iso = (value: string) =>
  Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });

const latestOf = (always: string, ...values: ReadonlyArray<string | null | undefined>) =>
  [always, ...values]
    .flatMap((value) => (value ? [iso(value)] : []))
    .toSorted()
    .at(-1) ?? iso(always);

const pullState = (state: TangledApi.TicketState) => (state === "completed" ? "merged" : state);

const WORKFLOW_STATUS: Record<string, PullRequestCheckStatus> = {
  pending: "pending",
  running: "pending",
  blocked: "action-required",
  failed: "failure",
  timeout: "failure",
  cancelled: "cancelled",
  success: "success",
};

const WORKFLOW_DESCRIPTION: Record<string, string> = {
  blocked: "Waiting for a collaborator to approve this run.",
  timeout: "Timed out.",
};

/** Spindle reports no aggregate, so one comes from the newest run of each workflow. */
export function pipelineChecks(
  repository: TangledApi.TangledRepository,
  pipelines: ReadonlyArray<TangledApi.TangledPipeline>,
): ReadonlyArray<PullRequestCheck> {
  return sortChecks(
    dedupeChecks(
      pipelines.flatMap((pipeline) =>
        pipeline.workflows.map((workflow) => ({
          workflowName: null,
          at: iso(pipeline.createdAt),
          check: {
            name: workflow.name || workflow.id,
            status: WORKFLOW_STATUS[workflow.status] ?? "neutral",
            description: WORKFLOW_DESCRIPTION[workflow.status] ?? null,
            url: `${TangledApi.webUrl(repository)}/pipelines/${pipeline.id}`,
          },
        })),
      ),
    ),
  );
}

export function checksStateOf(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  if (checks.some((check) => check.status === "failure")) return "failing";
  if (checks.some((check) => check.status === "pending" || check.status === "action-required"))
    return "pending";
  return "passing";
}

const NO_PERMISSIONS: PullRequestViewerPermissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
  editChangeRequest: false,
};

const sameCommit = (left: TangledApi.TangledCommit, right: TangledApi.TangledCommit) =>
  left.author.email === right.author.email &&
  left.author.when === right.author.when &&
  left.message === right.message;

export const make = Effect.gen(function* () {
  const api = yield* TangledApi.TangledApi;
  const auth = yield* TangledAuth;

  const failure = (
    operation: string,
    detail: string,
    reason: PullRequestProviderFailure["reason"] = "failed",
  ) => new PullRequestProviderError({ provider: KIND, operation, reason, detail });
  const fail = (operation: string) => (cause: ApiError) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      ...tangledProviderFailure(cause),
      detail: cause.detail,
      cause,
    });
  const unsupported = (operation: string, detail: string) =>
    Effect.fn(`TangledPullRequestProvider.${operation}`)(() =>
      Effect.fail(failure(operation, detail)),
    );

  const repositoryOf = Effect.fn("TangledPullRequestProvider.repositoryOf")(function* (
    operation: string,
    ref: ProviderRepositoryRef,
  ) {
    const reference = parseTangledRepository(ref.repository);
    if (reference === null)
      return yield* failure(
        operation,
        `${ref.repository} is not a Tangled repository.`,
        "not-found",
      );
    return yield* api.resolveRepository(reference).pipe(Effect.mapError(fail(operation)));
  });

  const actor = Effect.fn("TangledPullRequestProvider.actor")(function* (did: string) {
    const identity = yield* api
      .resolveIdentity(did)
      .pipe(Effect.orElseSucceed(() => ({ did, handle: null })));
    return {
      login: identity.handle ?? did,
      name: null,
      avatarUrl: null,
    } satisfies PullRequestActor;
  });

  const loadPull = Effect.fn("TangledPullRequestProvider.loadPull")(function* (
    operation: string,
    ref: PullRef,
  ) {
    const repository = yield* repositoryOf(operation, ref);
    const ticket = yield* api
      .getTicket({ repoDid: repository.repoDid, rkey: String(ref.number) })
      .pipe(Effect.mapError(fail(operation)));
    if (ticket.targetBranch.length === 0)
      return yield* failure(
        operation,
        `#${ref.number} is an issue, not a pull request.`,
        "not-found",
      );
    const rounds = yield* api.listRounds(ticket.uri).pipe(Effect.mapError(fail(operation)));
    const round = rounds.at(-1);
    if (round === undefined)
      return yield* failure(operation, `Pull request #${ref.number} has no submitted round.`);
    return { repository, ticket, rounds, round };
  });

  const toChangeRequest = (
    repository: TangledApi.TangledRepository,
    ticket: TangledApi.TangledTicket,
    round: TangledApi.TangledRound,
    author: PullRequestActor | null,
    number: number,
  ): ProviderChangeRequest => ({
    number,
    title: ticket.title.trim() || `Pull request ${number}`,
    url: pullRequestUrl(repository, number),
    author,
    headBranch: round.sourceBranch ?? round.headOid,
    baseBranch: ticket.targetBranch,
    state: pullState(ticket.state),
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: iso(ticket.createdAt),
    updatedAt: latestOf(ticket.createdAt, ticket.stateUpdatedAt, round.createdAt),
    closedAt: ticket.state === "closed" ? ticket.stateUpdatedAt : null,
    mergedAt: ticket.state === "completed" ? ticket.stateUpdatedAt : null,
    reviewRequestLogins: [],
    labels: [],
  });

  const permissionsFor = Effect.fn("TangledPullRequestProvider.permissionsFor")(function* (
    repository: TangledApi.TangledRepository,
    ticket: TangledApi.TangledTicket,
    round: TangledApi.TangledRound,
  ) {
    const viewer = Option.getOrNull(yield* auth.viewer);
    if (viewer === null) return NO_PERMISSIONS;
    const maintainers = yield* api
      .listMaintainers(repository)
      .pipe(Effect.orElseSucceed((): ReadonlySet<string> => new Set([repository.ownerDid])));
    const maintainer = maintainers.has(viewer.did);
    const author = ticket.authorDid === viewer.did;
    const steward = maintainer || author;
    // Tangled's web offers Resubmit to the author once the branch has moved past the latest round.
    const branchTip =
      author && ticket.state === "open" && round.sourceBranch !== null
        ? yield* api
            .getRef({ repoDid: round.sourceRepoDid, ref: `refs/heads/${round.sourceBranch}` })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
    const resubmittable = branchTip !== null && branchTip !== round.headOid;
    return {
      ...NO_PERMISSIONS,
      actions: CAPABILITIES.actions.filter((action) =>
        action === "merge" ? maintainer : action === "resubmit" ? resubmittable : steward,
      ),
      comment: true,
      editChangeRequest: steward,
    } satisfies PullRequestViewerPermissions;
  });

  const checksFor = (repository: TangledApi.TangledRepository, round: TangledApi.TangledRound) =>
    api
      .queryPipelines({ repository, commits: [round.headOid] })
      .pipe(Effect.map((pipelines) => pipelineChecks(repository, pipelines)));

  const rangeOf = (
    repository: TangledApi.TangledRepository,
    round: TangledApi.TangledRound,
  ): TangledPatch.TangledRange => ({
    baseRepoDid: repository.repoDid,
    base: round.baseOid,
    headRepoDid: round.sourceRepoDid,
    head: round.headOid,
  });

  /** One commit of the round, against its first parent, all in the source repository. */
  const commitRange = Effect.fn("TangledPullRequestProvider.commitRange")(function* (
    operation: string,
    round: TangledApi.TangledRound,
    commit: string,
  ) {
    const [found] = yield* api
      .listCommits({ repoDids: [round.sourceRepoDid], range: commit, limit: 1 })
      .pipe(Effect.mapError(fail(operation)));
    const parent = found?.parents[0];
    if (parent === undefined)
      return yield* failure(operation, `Tangled has no parent of ${commit}.`);
    return {
      baseRepoDid: round.sourceRepoDid,
      base: parent,
      headRepoDid: round.sourceRepoDid,
      head: commit,
    };
  });

  /**
   * What a diff read shows: the latest round, one commit of it, one earlier round, or what changed
   * since an earlier round. Rounds are read through Tangled, which keeps heads a force-push dropped.
   */
  const comparisonFor = Effect.fn("TangledPullRequestProvider.comparisonFor")(function* (
    operation: string,
    input: PullRef & {
      readonly commit?: string | undefined;
      readonly round?: PullRequestRoundSelection | undefined;
    },
  ) {
    const { repository, rounds, round } = yield* loadPull(operation, input);
    const range = (range: TangledPatch.TangledRange): TangledPatch.TangledComparison => ({
      kind: "range",
      range,
    });
    if (input.commit !== undefined)
      return range(yield* commitRange(operation, round, input.commit));
    if (input.round === undefined) return range(rangeOf(repository, round));
    const roundAt = (number: number) =>
      Effect.fromNullishOr(rounds[number - 1]).pipe(
        Effect.mapError(() =>
          failure(operation, `Pull request #${input.number} has no round ${number}.`, "not-found"),
        ),
      );
    const to = yield* roundAt(input.round.number);
    if (input.round.since === undefined) return range(rangeOf(repository, to));
    // Tangled's interdiff, not head..head: a round rebased onto a newer target would otherwise
    // show every commit the target gained in between.
    const from = yield* roundAt(input.round.since);
    return { kind: "interdiff", from, to } satisfies TangledPatch.TangledComparison;
  });

  /** Reads the knot's copy and writes it back over exactly that version. */
  const editTicket = Effect.fn("TangledPullRequestProvider.editTicket")(function* (
    operation: string,
    repository: TangledApi.TangledRepository,
    rkey: string,
    edit: (record: Record<string, unknown>) => void,
  ) {
    const write = Effect.gen(function* () {
      const current = yield* api.getRecord({
        repository,
        collection: TangledApi.COLLECTION.ticket,
        rkey,
      });
      const { "x-tngl-editor": _editor, ...record } = current.value;
      if (typeof record.title === "string")
        record.title = { $type: "org.tangled.markup.markdown#inline", text: record.title };
      edit(record);
      yield* api.write({
        service: "knot",
        repository,
        nsid: TangledApi.NSID.putRecord,
        body: {
          collection: TangledApi.COLLECTION.ticket,
          rkey,
          swapRecord: current.cid,
          record,
        },
      });
    });
    // A stale swap means someone else wrote first; the edit is re-applied to their version once.
    yield* write.pipe(
      Effect.catchIf(
        (error) => error._tag === "TangledApiError" && error.reason === "conflict",
        () => write,
      ),
      Effect.mapError(fail(operation)),
    );
  });

  /** Whether the target already holds the round, as itself or as rebased copies of its commits. */
  const roundLanded = Effect.fn("TangledPullRequestProvider.roundLanded")(function* (
    repository: TangledApi.TangledRepository,
    round: TangledApi.TangledRound,
    targetTip: string,
  ) {
    const repoDids =
      round.sourceRepoDid === repository.repoDid
        ? [repository.repoDid]
        : [repository.repoDid, round.sourceRepoDid];
    const mergeBase = yield* api.getMergeBase({ repoDids, base: targetTip, head: round.headOid });
    if (mergeBase === round.headOid) return true;
    const [proposed, landed] = yield* Effect.all(
      [
        api.listCommits({
          repoDids,
          range: `${round.baseOid}..${round.headOid}`,
          limit: COMMIT_LIMIT,
        }),
        api.listCommits({ repoDids, range: `${mergeBase}..${targetTip}`, limit: COMMIT_LIMIT }),
      ],
      { concurrency: 2 },
    );
    return (
      proposed.length > 0 &&
      proposed.length < COMMIT_LIMIT &&
      proposed.every((commit) => landed.some((candidate) => sameCommit(commit, candidate)))
    );
  });

  const complete = (operation: string, repository: TangledApi.TangledRepository, rkey: string) =>
    editTicket(operation, repository, rkey, (record) => {
      record.state = "completed";
    });

  /** Merging is a push and then a ticket edit, so a retry finishes whichever half is left. */
  const merge = Effect.fn("TangledPullRequestProvider.merge")(function* (ref: PullRef) {
    const operation = "merge";
    const { repository, ticket, round } = yield* loadPull(operation, ref);
    if (ticket.state === "completed") return;
    if (ticket.state !== "open")
      return yield* failure(operation, "Only an open pull request can be merged.");
    const targetTip = yield* api
      .getRef({ repoDid: repository.repoDid, ref: `refs/heads/${ticket.targetBranch}` })
      .pipe(Effect.mapError(fail(operation)));
    if (targetTip === null)
      return yield* failure(operation, `Tangled has no ${ticket.targetBranch} branch.`);
    const landed = yield* roundLanded(repository, round, targetTip).pipe(
      Effect.mapError(fail(operation)),
    );
    if (!landed) {
      const method = TangledApi.NSID.mergeCommit;
      yield* api
        .write({
          service: "bobbin",
          repository,
          nsid: method,
          body: {
            target: {
              $type: `${method}#target`,
              repo: repository.repoDid,
              branch: ticket.targetBranch,
              commit: targetTip,
            },
            source: { $type: `${method}#source`, repo: round.sourceRepoDid, commit: round.headOid },
            style: "rebase",
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "TangledApiError" && cause.error === "MergeConflict"
              ? failure(operation, "The pull request conflicts with its target branch.")
              : cause._tag === "TangledApiError" && cause.error === "PushRejected"
                ? failure(operation, `${ticket.targetBranch} moved during the merge. Try again.`)
                : fail(operation)(cause),
          ),
        );
      yield* api.forgetRounds(ticket.uri);
      const latest = yield* api.listRounds(ticket.uri).pipe(Effect.mapError(fail(operation)));
      if (latest.at(-1)?.cid !== round.cid)
        return yield* failure(
          operation,
          `Tangled merged round ${round.round}, but a newer round arrived meanwhile, so the pull request stays open.`,
        );
    }
    yield* complete(operation, repository, ticket.rkey);
  });

  /** The source branch's tip as the next round; nothing when the latest round already has it. */
  const resubmit = Effect.fn("TangledPullRequestProvider.resubmit")(function* (ref: PullRef) {
    const operation = "resubmit";
    const { repository, ticket, round } = yield* loadPull(operation, ref);
    if (ticket.state !== "open")
      return yield* failure(operation, "Only an open pull request can be resubmitted.");
    if (round.sourceBranch === null)
      return yield* failure(operation, "The pull request names no source branch.");
    const source = {
      target: repository,
      targetBranch: ticket.targetBranch,
      sourceRepoDid: round.sourceRepoDid,
      sourceBranch: round.sourceBranch,
    };
    const next = yield* TangledRound.proposeRound(api, source).pipe(
      Effect.mapError(fail(operation)),
    );
    if (next.head === round.headOid) return;
    yield* TangledRound.submitRound(api, { ...source, ...next, ticketUri: ticket.uri }).pipe(
      Effect.mapError(fail(operation)),
    );
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    readsPublicHostWithoutCheckout: true,
    servesHost: (host) => host === TANGLED_WEB_HOST,

    getViewer: Effect.fn("TangledPullRequestProvider.getViewer")(function* () {
      const viewer = Option.getOrNull(yield* auth.viewer);
      if (viewer === null)
        return yield* failure("getViewer", UNAVAILABLE_REQUIREMENT.missing, "unauthenticated");
      return viewer.handle;
    }),

    listChangeRequests: Effect.fn("TangledPullRequestProvider.listChangeRequests")(
      function* (input) {
        const operation = "listChangeRequests";
        if (input.involvement === "reviewing")
          return { items: [], truncated: false, continues: false };
        const viewer = Option.getOrNull(yield* auth.viewer);
        if (input.involvement === "authored" && viewer === null)
          return { items: [], truncated: false, continues: false };
        const repository = yield* repositoryOf(operation, input);
        const page = yield* api
          .listPulls({
            repoDid: repository.repoDid,
            ...(input.state === "all"
              ? {}
              : { state: input.state === "merged" ? "completed" : input.state }),
            limit: Math.min(Math.max(input.limit, 1), PAGE_SIZE),
            cursor: input.cursor?.resumeAfter ?? null,
          })
          .pipe(Effect.mapError(fail(operation)));
        const rows = page.items.flatMap((ticket) => {
          const number = ticketNumber(ticket.rkey);
          // Bobbin ignores its author filter, so authorship is narrowed here.
          return number === null ||
            ticket.targetBranch.length === 0 ||
            (input.involvement === "authored" && ticket.authorDid !== viewer?.did)
            ? []
            : [{ ticket, number }];
        });
        const items = yield* Effect.forEach(
          rows,
          Effect.fnUntraced(function* ({ ticket, number }) {
            const rounds = yield* api.listRounds(ticket.uri);
            const round = rounds.at(-1);
            if (round === undefined) return [];
            return [
              toChangeRequest(repository, ticket, round, yield* actor(ticket.authorDid), number),
            ];
          }),
          // fnUntraced: a span per row would outnumber the listing's own.
          { concurrency: 8 },
        ).pipe(Effect.mapError(fail(operation)));
        return {
          items: items.flat(),
          truncated: page.cursor !== null,
          continues: true,
          ...(page.cursor === null ? {} : { resumeAfter: page.cursor }),
        };
      },
    ),

    getChangeRequest: Effect.fn("TangledPullRequestProvider.getChangeRequest")(function* (input) {
      const operation = "getChangeRequest";
      const { repository, ticket, round } = yield* loadPull(operation, input);
      const [author, checks, files, permissions, mergeability, comments] = yield* Effect.all(
        [
          actor(ticket.authorDid),
          checksFor(repository, round).pipe(Effect.orElseSucceed(() => [])),
          api
            .getDiff({
              baseRepoDid: repository.repoDid,
              baseCommit: round.baseOid,
              headRepoDid: round.sourceRepoDid,
              headCommit: round.headOid,
            })
            .pipe(Effect.option),
          permissionsFor(repository, ticket, round),
          ticket.state !== "open"
            ? Effect.succeed("unknown" as const)
            : api
                .getRef({ repoDid: repository.repoDid, ref: `refs/heads/${ticket.targetBranch}` })
                .pipe(
                  Effect.flatMap((tip) =>
                    tip === null
                      ? Effect.succeed("unknown" as const)
                      : api
                          .mergeCheck({
                            targetRepoDid: repository.repoDid,
                            targetCommit: tip,
                            sourceRepoDid: round.sourceRepoDid,
                            sourceCommit: round.headOid,
                          })
                          .pipe(
                            Effect.map((result) =>
                              result.isConflicted
                                ? ("conflicting" as const)
                                : ("mergeable" as const),
                            ),
                          ),
                  ),
                  Effect.orElseSucceed(() => "unknown" as const),
                ),
          // A ticket's record never moves for a comment, yet clients reread activity only when
          // `updatedAt` does.
          api.listComments(ticket.uri).pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: "unbounded" },
      );
      const stats = Option.getOrElse(files, () => []).map(TangledPatch.lineStats);
      const summary = toChangeRequest(repository, ticket, round, author, input.number);
      return {
        ...summary,
        updatedAt: latestOf(summary.updatedAt, ...comments.map((comment) => comment.createdAt)),
        mergeability,
        additions: stats.reduce((sum, file) => sum + file.additions, 0),
        deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
        changedFiles: stats.length,
        checksState: checksStateOf(checks),
        headSha: round.headOid,
        body: ticket.body,
        reviewers: [],
        checks,
        mergeCapabilities: { merge: false, squash: false, rebase: true },
        viewerPermissions: permissions,
        mergedAt: ticket.state === "completed" ? ticket.stateUpdatedAt : null,
        closedAt: ticket.state === "closed" ? ticket.stateUpdatedAt : null,
      };
    }),

    getChangeRequestChecks: Effect.fn("TangledPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const operation = "getChangeRequestChecks";
        const { repository, ticket, round } = yield* loadPull(operation, input);
        const checks = yield* checksFor(repository, round).pipe(Effect.mapError(fail(operation)));
        return { state: pullState(ticket.state), checks };
      },
    ),

    forgetChangeRequestReads: Effect.fn("TangledPullRequestProvider.forgetChangeRequestReads")(
      function* (scope) {
        const reference = scope === undefined ? null : parseTangledRepository(scope.repository);
        const repository =
          reference === null ? null : Option.getOrNull(yield* api.cachedRepository(reference));
        // Unheld, the repository's rounds may still be: its entry can expire before theirs.
        if (scope === undefined || repository === null) return yield* api.forgetRounds();
        yield* api.forgetRounds(
          scope.number === undefined
            ? `at://${repository.repoDid}`
            : TangledApi.ticketUri(repository.repoDid, String(scope.number)),
        );
      },
    ),

    getChangeRequestActivity: Effect.fn("TangledPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const operation = "getChangeRequestActivity";
        const { repository, ticket, round } = yield* loadPull(operation, input);
        const repoDids =
          round.sourceRepoDid === repository.repoDid
            ? [repository.repoDid]
            : [repository.repoDid, round.sourceRepoDid];
        const [comments, commits, author] = yield* Effect.all(
          [
            api.listComments(ticket.uri),
            api.listCommits({
              repoDids,
              range: `${round.baseOid}..${round.headOid}`,
              limit: COMMIT_LIMIT,
            }),
            actor(ticket.authorDid),
          ],
          { concurrency: 3 },
        ).pipe(Effect.mapError(fail(operation)));
        const url = pullRequestUrl(repository, input.number);
        const commenters = yield* Effect.forEach(comments, (comment) => actor(comment.authorDid), {
          concurrency: 8,
        });
        return {
          author,
          comments: comments.map((comment, index) => ({
            id: comment.uri,
            kind: "issue-comment" as const,
            author: commenters[index] ?? null,
            body: comment.body,
            createdAt: iso(comment.createdAt),
            url,
            path: null,
            reviewState: null,
          })),
          commentCount: comments.length,
          commentsTruncated: false,
          reviewThreads: [],
          // Oldest first, as git log --reverse lists a branch.
          commits: commits.toReversed().map((commit) => ({
            oid: commit.oid,
            messageHeadline: commit.message.split("\n", 1)[0] ?? "",
            committedDate: iso(commit.committer?.when ?? commit.author.when),
            authors: [
              {
                login: commit.author.name || commit.author.email || "unknown",
                name: commit.author.name || null,
                avatarUrl: null,
              },
            ],
          })),
        };
      },
    ),

    listRounds: Effect.fn("TangledPullRequestProvider.listRounds")(function* (input) {
      const { rounds } = yield* loadPull("listRounds", input);
      return rounds.map((round) => ({
        number: round.round,
        headSha: round.headOid,
        baseSha: round.baseOid,
        createdAt: iso(round.createdAt),
      }));
    }),

    getViewerPermissions: Effect.fn("TangledPullRequestProvider.getViewerPermissions")(
      function* (input) {
        const { repository, ticket, round } = yield* loadPull("getViewerPermissions", input);
        return yield* permissionsFor(repository, ticket, round);
      },
    ),

    getDiff: Effect.fn("TangledPullRequestProvider.getDiff")(function* (input) {
      const operation = "getDiff";
      const comparison = yield* comparisonFor(operation, input);
      return yield* TangledPatch.readPatchSlice(api, comparison, input.cursor).pipe(
        Effect.mapError(fail(operation)),
      );
    }),

    getDiffFilePaths: Effect.fn("TangledPullRequestProvider.getDiffFilePaths")(function* (input) {
      const operation = "getDiffFilePaths";
      const comparison = yield* comparisonFor(operation, input);
      const files = yield* TangledPatch.listFiles(api, comparison).pipe(
        Effect.mapError(fail(operation)),
      );
      return {
        files: files.map((file) => ({ oldPath: file.lhsSrc.path, newPath: file.rhsSrc.path })),
        nextCursor: null,
      };
    }),

    getDiffFileContents: Effect.fn("TangledPullRequestProvider.getDiffFileContents")(
      function* (input) {
        const operation = "getDiffFileContents";
        const comparison = yield* comparisonFor(operation, input);
        const contents = yield* TangledPatch.readFileContents(api, comparison, {
          oldPath: input.oldPath,
          newPath: input.newPath,
          change:
            input.changeType === "new"
              ? "added"
              : input.changeType === "deleted"
                ? "deleted"
                : "modified",
        }).pipe(Effect.mapError(fail(operation)));
        if (contents.oldContents === null || contents.newContents === null)
          return yield* failure(operation, `${input.newPath} is too large to show.`);
        return { oldContents: contents.oldContents, newContents: contents.newContents };
      },
    ),

    getFileStats: Effect.fn("TangledPullRequestProvider.getFileStats")(function* (input) {
      const operation = "getFileStats";
      const { repository, round } = yield* loadPull(operation, input);
      const files = yield* api
        .getDiff({
          baseRepoDid: repository.repoDid,
          baseCommit: round.baseOid,
          headRepoDid: round.sourceRepoDid,
          headCommit: round.headOid,
        })
        .pipe(Effect.mapError(fail(operation)));
      return {
        files: files.map((file) => ({ path: file.rhsSrc.path, ...TangledPatch.lineStats(file) })),
        truncated: false,
      };
    }),

    runAction: Effect.fn("TangledPullRequestProvider.runAction")(function* (input) {
      const operation = "runAction";
      if (input.action === "merge") {
        if (input.mergeMethod !== undefined && input.mergeMethod !== "rebase")
          return yield* failure(operation, "Tangled merges by rebase only.");
        return yield* merge(input);
      }
      if (input.action === "resubmit") return yield* resubmit(input);
      if (input.action !== "close" && input.action !== "reopen")
        return yield* failure(operation, `Tangled pull requests cannot ${input.action}.`);
      const repository = yield* repositoryOf(operation, input);
      yield* editTicket(operation, repository, String(input.number), (record) => {
        record.state = input.action === "close" ? "closed" : "open";
      });
    }),

    updateChangeRequest: Effect.fn("TangledPullRequestProvider.updateChangeRequest")(
      function* (input) {
        const operation = "updateChangeRequest";
        const repository = yield* repositoryOf(operation, input);
        yield* editTicket(operation, repository, String(input.number), (record) => {
          if (input.title !== undefined)
            record.title = { $type: "org.tangled.markup.markdown#inline", text: input.title };
          if (input.body === undefined) return;
          if (input.body.trim().length === 0) delete record.body;
          else record.body = { $type: "org.tangled.markup.markdown", text: input.body };
        });
      },
    ),

    comment: Effect.fn("TangledPullRequestProvider.comment")(function* (input) {
      const operation = "comment";
      const repository = yield* repositoryOf(operation, input);
      const ticket = yield* api
        .getTicket({ repoDid: repository.repoDid, rkey: String(input.number) })
        .pipe(Effect.mapError(fail(operation)));
      yield* api
        .write({
          service: "knot",
          repository,
          nsid: TangledApi.NSID.createRecord,
          body: {
            collection: TangledApi.COLLECTION.comment,
            record: {
              $type: TangledApi.COLLECTION.comment,
              subject: { uri: ticket.uri, cid: ticket.cid },
              body: { $type: "org.tangled.markup.markdown", text: input.body },
              createdAt: DateTime.formatIso(yield* DateTime.now),
            },
          },
        })
        .pipe(Effect.mapError(fail(operation)));
    }),

    submitReview: unsupported("submitReview", "Tangled has no review verdicts."),
    listReviewerCandidates: unsupported("listReviewerCandidates", "Tangled has no reviewers."),
    setReviewerRequest: unsupported("setReviewerRequest", "Tangled has no reviewers."),
    replyToThread: unsupported("replyToThread", "Tangled has no line comments to reply to."),
    setReaction: unsupported("setReaction", "T3 Code does not react on Tangled."),
    setThreadResolution: unsupported("setThreadResolution", "Tangled has no review threads."),
  };

  return provider;
});
