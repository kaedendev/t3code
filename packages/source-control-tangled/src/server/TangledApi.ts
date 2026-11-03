import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  isDid,
  TANGLED_WEB_HOST,
  tangledRepositoryKey,
  type TangledRepositoryRef,
} from "../shared/definition.ts";
import { TangledAuth, type TangledAuthError } from "./TangledAuth.ts";

/**
 * Every XRPC method T3 calls, in one place: Tangled's API is young and renames methods, so a
 * rename is a one-line change here.
 */
export const NSID = {
  resolveIdentity: "blue.microcosm.identity.resolveMiniDoc",
  getRepoByName: "org.tangled.repo.getRepoByName",
  getRepoByRepoDid: "org.tangled.repo.getRepoByRepoDid",
  listPulls: "org.tangled.repo.listPulls",
  listCollaborators: "org.tangled.repo.listCollaborators",
  getTicketView: "org.tangled.track.getTicketView",
  listPatches: "org.tangled.temp.review.listPatches",
  listComments: "org.tangled.feed.listComments",
  getRef: "org.tangled.temp.git.getRef",
  getMergeBase: "org.tangled.temp.git.getMergeBase",
  listCommits: "org.tangled.temp.git.listCommits",
  getBlob: "org.tangled.temp.git.getBlob",
  getDiff: "sh.tangled.git.temp2.getDiff",
  getInterdiff: "sh.tangled.git.temp2.getInterdiff",
  mergeCheck: "sh.tangled.git.temp2.mergeCheck",
  queryPipelines: "org.tangled.ci.queryPipelines",
  getRecord: "com.atproto.repo.getRecord",
  createRecord: "com.atproto.repo.createRecord",
  putRecord: "com.atproto.repo.putRecord",
  deleteRecord: "com.atproto.repo.deleteRecord",
  submitPatch: "org.tangled.review.submitPatch",
  mergeCommit: "sh.tangled.git.mergeCommit",
  receivePack: "org.tangled.git.receivePack",
  createRepo: "org.tangled.repo.createRepo",
  deleteRepo: "org.tangled.repo.deleteRepo",
} as const;

export const COLLECTION = {
  ticket: "org.tangled.track.ticket",
  comment: "org.tangled.feed.comment",
  /** On the owner's PDS, keyed by the repository's lowercased name, claiming its repo DID. */
  declaration: "org.tangled.repo.declaration",
} as const;

const BOBBIN = "https://api.tangled.org";
const TIMEOUT = Duration.seconds(30);
const NO_REDIRECT: RequestInit = { redirect: "manual" };
const IDENTITY_TTL = Duration.minutes(30);
const REPOSITORY_TTL = Duration.minutes(10);
const ROUNDS_TTL = Duration.minutes(1);
const CACHE_CAPACITY = 2_000;
const MAX_BLOB_BYTES = 1024 * 1024;

export class TangledApiError extends Schema.TaggedError<TangledApiError>()("TangledApiError", {
  operation: Schema.String,
  reason: Schema.Literals(["not-found", "unauthenticated", "rate-limited", "conflict", "failed"]),
  status: Schema.NullOr(Schema.Int),
  /** The XRPC error name, as `InvalidSwap` or `MergeConflict`. */
  error: Schema.optional(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Tangled ${this.operation} failed: ${this.detail}`;
  }
}

/** A 4xx other than a timeout or a throttle: the host refused, so nothing was written. */
export const isDefiniteRejection = (error: TangledApiError | TangledAuthError) =>
  error._tag === "TangledApiError" &&
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

const Markdown = Schema.Struct({ text: Schema.String });
const StrongRef = Schema.Struct({ uri: Schema.String, cid: Schema.String });

const Manifest = Schema.Struct({
  uri: Schema.String,
  knot: Schema.optional(Schema.NullOr(Schema.String)),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.Struct({
    declaration: Schema.Struct({ name: Schema.String, owner: Schema.String }),
    spindle: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const Identity = Schema.Struct({ did: Schema.String, handle: Schema.String });

const Ticket = Schema.Struct({
  title: Markdown,
  body: Schema.optional(Schema.NullOr(Markdown)),
  state: Schema.String,
  targetBranch: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
});

const TicketItem = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  author: Schema.String,
  state: Schema.String,
  stateUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  commentCount: Schema.optional(Schema.Number),
  value: Ticket,
});

const TicketPage = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  total: Schema.optional(Schema.Number),
});

const TicketView = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  author: Identity,
  title: Markdown,
  body: Schema.optional(Schema.NullOr(Markdown)),
  state: Schema.String,
  targetBranch: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
});

const Patch = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Struct({
    base: Schema.Struct({ oid: Schema.String }),
    head: Schema.Struct({ oid: Schema.String }),
    source: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          branch: Schema.optional(Schema.String),
          repo: Schema.optional(Schema.String),
        }),
      ),
    ),
    createdAt: Schema.String,
  }),
});
const PatchPage = Schema.Struct({
  items: Schema.Array(Patch),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const Comment = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  editor: Schema.String,
  body: Schema.optional(Schema.NullOr(Markdown)),
  createdAt: Schema.String,
  replyTo: Schema.optional(Schema.NullOr(StrongRef)),
});
const CommentPage = Schema.Struct({
  items: Schema.Array(Comment),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const Collaborators = Schema.Struct({
  items: Schema.Array(Schema.Struct({ subject: Schema.String })),
});
const Ref = Schema.Struct({ oid: Schema.String });
const MergeBase = Schema.Struct({ commit: Schema.String });

const Signature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  when: Schema.String,
});
const Commit = Schema.Struct({
  oid: Schema.String,
  parents: Schema.Array(Schema.String),
  author: Signature,
  committer: Schema.optional(Signature),
  message: Schema.String,
  extraHeaders: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
  ),
});
const Commits = Schema.Struct({ commits: Schema.Array(Commit) });

const DiffSide = Schema.Struct({
  path: Schema.String,
  oid: Schema.String,
  size: Schema.Number,
  isBinary: Schema.Boolean,
  isSubmodule: Schema.optional(Schema.Boolean),
  /** An interdiff's left side is a tree rebased for that one answer, so its text comes inline. */
  content: Schema.optional(Schema.String),
});
const FileDiff = Schema.Struct({
  lhsSrc: DiffSide,
  rhsSrc: DiffSide,
  hunks: Schema.Array(
    Schema.Struct({ novelLhs: Schema.Array(Schema.Number), novelRhs: Schema.Array(Schema.Number) }),
  ),
});
const Diffs = Schema.Struct({ diffs: Schema.Array(FileDiff) });

const MergeCheck = Schema.Struct({
  isConflicted: Schema.Boolean,
  conflicts: Schema.Array(Schema.Struct({ filename: Schema.String })),
});

const Workflow = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.String,
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  finishedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const Pipeline = Schema.Struct({
  id: Schema.String,
  commit: Schema.String,
  createdAt: Schema.String,
  trigger: Schema.optional(Schema.Struct({ $type: Schema.optional(Schema.String) })),
  workflows: Schema.Array(Workflow),
});
const Pipelines = Schema.Struct({ pipelines: Schema.Array(Pipeline) });

const RecordView = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Record(Schema.String, Schema.Unknown),
});
const Receipt = Schema.Struct({ uri: Schema.String, cid: Schema.String });
const CreatedRepo = Schema.Struct({ did: Schema.String });
const XrpcProblem = Schema.Struct({
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export interface TangledRepository {
  readonly repoDid: string;
  readonly ownerDid: string;
  /** Null when the owner's handle does not resolve, so the repository has no web path. */
  readonly ownerHandle: string | null;
  readonly name: string;
  readonly knot: string;
  readonly defaultBranch: string | null;
  /** The repository's spindle as a `did:web`, or null when it runs no CI. */
  readonly spindle: string | null;
}

/** `owner/name` as the web shows it, with the owner's DID when it has no handle. */
export const repositoryPath = (repository: TangledRepository) =>
  `${repository.ownerHandle ?? repository.ownerDid}/${repository.name}`;

export const repositoryKey = (repository: TangledRepository) =>
  tangledRepositoryKey({ kind: "repo-did", repoDid: repository.repoDid });

export const webUrl = (repository: TangledRepository) =>
  `https://${TANGLED_WEB_HOST}/${repositoryPath(repository)}`;

export type TicketState = "open" | "closed" | "completed";

export interface TangledTicket {
  readonly uri: string;
  readonly cid: string;
  /** The ticket's record key; a pull request's number when it is an integer. */
  readonly rkey: string;
  readonly authorDid: string;
  readonly title: string;
  readonly body: string;
  readonly state: TicketState;
  readonly stateUpdatedAt: string | null;
  readonly targetBranch: string;
  readonly createdAt: string;
  readonly commentCount: number;
}

/** One immutable submission of a pull request: the commit range reviewers see. */
export interface TangledRound {
  /** 1 for the first submission. */
  readonly round: number;
  readonly uri: string;
  readonly cid: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly sourceRepoDid: string;
  readonly sourceBranch: string | null;
  readonly createdAt: string;
}

export interface TangledComment {
  readonly uri: string;
  readonly cid: string;
  readonly authorDid: string;
  readonly body: string;
  readonly createdAt: string;
  readonly replyTo: string | null;
}

export type TangledCommit = typeof Commit.Type;
export type TangledFileDiff = typeof FileDiff.Type;
export type TangledPipeline = typeof Pipeline.Type;

export interface TangledPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly cursor: string | null;
}

const ticketState = (state: string): TicketState =>
  state === "closed"
    ? "closed"
    : state === "completed" || state === "merged"
      ? "completed"
      : "open";

const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

/** `did:web:<host>`, with a port written `%3A`, as knots and spindles name themselves. */
const serviceDid = (host: string) => `did:web:${host.replaceAll(":", "%3A")}`;

/** The host a `did:web` names; null for any other DID. */
const hostOfServiceDid = (did: string) =>
  did.startsWith("did:web:") ? decodeURIComponent(did.slice("did:web:".length)) : null;

export const ticketUri = (repoDid: string, rkey: string) =>
  `at://${repoDid}/${COLLECTION.ticket}/${rkey}`;

export interface TangledWrite {
  /** The knot, or bobbin for a merge, that takes the call. */
  readonly service: "knot" | "bobbin";
  readonly repository: TangledRepository;
  readonly nsid: string;
  readonly body: Record<string, unknown>;
}

export class TangledApi extends Context.Service<
  TangledApi,
  {
    /** Handle or DID to both; cached. */
    readonly resolveIdentity: (
      identifier: string,
    ) => Effect.Effect<{ readonly did: string; readonly handle: string | null }, TangledApiError>;
    /** Cached under the reference and under the repo DID it resolves to. */
    readonly resolveRepository: (
      reference: TangledRepositoryRef,
    ) => Effect.Effect<TangledRepository, TangledApiError>;
    /** The repository as last resolved, without asking Tangled; none when it is not held. */
    readonly cachedRepository: (
      reference: TangledRepositoryRef,
    ) => Effect.Effect<Option.Option<TangledRepository>>;
    /** The owner and collaborators, who may merge; cached. */
    readonly listMaintainers: (
      repository: TangledRepository,
    ) => Effect.Effect<ReadonlySet<string>, TangledApiError>;
    readonly listPulls: (input: {
      readonly repoDid: string;
      readonly state?: TicketState;
      readonly limit: number;
      readonly cursor?: string | null;
    }) => Effect.Effect<TangledPage<TangledTicket>, TangledApiError>;
    readonly getTicket: (input: {
      readonly repoDid: string;
      readonly rkey: string;
    }) => Effect.Effect<TangledTicket & { readonly authorHandle: string }, TangledApiError>;
    /** Oldest first; cached briefly, since a new round can arrive at any time. */
    readonly listRounds: (
      ticketUri: string,
    ) => Effect.Effect<ReadonlyArray<TangledRound>, TangledApiError>;
    /** One ticket's rounds, or every ticket's under a repository's `at://<repoDid>`; all without one. */
    readonly forgetRounds: (uri?: string) => Effect.Effect<void>;
    readonly listComments: (
      subjectUri: string,
    ) => Effect.Effect<ReadonlyArray<TangledComment>, TangledApiError>;
    /** Null when the ref does not exist. */
    readonly getRef: (input: {
      readonly repoDid: string;
      readonly ref: string;
    }) => Effect.Effect<string | null, TangledApiError>;
    readonly getMergeBase: (input: {
      readonly repoDids: ReadonlyArray<string>;
      readonly base: string;
      readonly head: string;
    }) => Effect.Effect<string, TangledApiError>;
    readonly listCommits: (input: {
      readonly repoDids: ReadonlyArray<string>;
      readonly range: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<TangledCommit>, TangledApiError>;
    /** Null when the blob is larger than T3 reads. */
    readonly getBlob: (input: {
      readonly repoDid: string;
      readonly commit: string;
      readonly path: string;
    }) => Effect.Effect<string | null, TangledApiError>;
    readonly getDiff: (input: {
      readonly baseRepoDid: string;
      readonly baseCommit: string;
      readonly headRepoDid: string;
      readonly headCommit: string;
    }) => Effect.Effect<ReadonlyArray<TangledFileDiff>, TangledApiError>;
    /**
     * What changed from one round to a later one: `from` rebased onto `to`'s base, against `to`'s
     * head, so commits the target gained in between do not show.
     */
    readonly getInterdiff: (input: {
      readonly from: Pick<TangledRound, "baseOid" | "headOid" | "sourceRepoDid">;
      readonly to: Pick<TangledRound, "baseOid" | "headOid" | "sourceRepoDid">;
    }) => Effect.Effect<ReadonlyArray<TangledFileDiff>, TangledApiError>;
    readonly mergeCheck: (input: {
      readonly targetRepoDid: string;
      readonly targetCommit: string;
      readonly sourceRepoDid: string;
      readonly sourceCommit: string;
    }) => Effect.Effect<
      { readonly isConflicted: boolean; readonly conflicts: ReadonlyArray<string> },
      TangledApiError
    >;
    /** Empty for a repository whose spindle is not a `did:web`. */
    readonly queryPipelines: (input: {
      readonly repository: TangledRepository;
      readonly commits: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<TangledPipeline>, TangledApiError>;
    /** The knot's copy, authoritative where bobbin's index may lag. */
    readonly getRecord: (input: {
      readonly repository: TangledRepository;
      readonly collection: string;
      readonly rkey: string;
    }) => Effect.Effect<
      { readonly uri: string; readonly cid: string; readonly value: Record<string, unknown> },
      TangledApiError
    >;
    /** Asks `knot` to host a new repository and mint its DID; the owner still has to claim it. */
    readonly createRepo: (input: {
      readonly knot: string;
      readonly name: string;
      readonly createdAt: string;
    }) => Effect.Effect<string, TangledApiError | TangledAuthError>;
    readonly deleteRepo: (input: {
      readonly knot: string;
      readonly repoDid: string;
    }) => Effect.Effect<void, TangledApiError | TangledAuthError>;
    /** A procedure authorized by a service-auth token minted for exactly this call. */
    readonly write: (
      input: TangledWrite,
    ) => Effect.Effect<
      { readonly uri: string; readonly cid: string } | null,
      TangledApiError | TangledAuthError
    >;
  }
>()("@t3tools/source-control-tangled/server/TangledApi") {}

const reasonForStatus = (status: number, error: string | undefined): TangledApiError["reason"] =>
  status === 401 || status === 403 || error === "AuthRequired"
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404 || error === "RecordNotFound" || error === "RepoNotFound"
        ? "not-found"
        : status === 409 || error === "InvalidSwap"
          ? "conflict"
          : "failed";

const query = (params: Record<string, string | number | ReadonlyArray<string> | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of typeof value === "object" ? value : [value])
      search.append(key, String(item));
  }
  return search.toString();
};

const decodeProblem = Schema.decodeUnknownOption(Schema.fromJsonString(XrpcProblem));
const decodeReceipt = Schema.decodeOption(Schema.fromJsonString(Receipt));
const decodeCreatedRepo = Schema.decodeOption(Schema.fromJsonString(CreatedRepo));

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const auth = yield* TangledAuth;

  const send = Effect.fn("TangledApi.send")(function* (input: {
    readonly operation: string;
    readonly url: string;
    readonly method?: "GET" | "POST";
    readonly token?: string;
    readonly body?: unknown;
  }) {
    const fail = (fields: {
      status: number | null;
      reason: TangledApiError["reason"];
      detail: string;
      error?: string;
      cause?: unknown;
    }) =>
      new TangledApiError({
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.error === undefined ? {} : { error: fields.error }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    yield* Effect.annotateCurrentSpan({ "tangled.operation": input.operation });
    let request = HttpClientRequest.make(input.method ?? "GET")(input.url).pipe(
      HttpClientRequest.setHeaders({ "user-agent": "t3code" }),
    );
    if (input.token !== undefined) request = HttpClientRequest.bearerToken(request, input.token);
    if (input.body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, input.body);
    const response = yield* httpClient.execute(request).pipe(
      // Query strings carry branch names and DIDs.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      // fetch would carry a bearer token to any redirect target.
      input.token === undefined
        ? (effect) => effect
        : Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
      ),
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) =>
        fail({ status: null, reason: "failed", detail: "Could not reach Tangled.", cause }),
      ),
    );
    if (response.status >= 200 && response.status < 300) return response.text;
    const problem = Option.getOrUndefined(decodeProblem(response.text));
    return yield* fail({
      status: response.status,
      reason: reasonForStatus(response.status, problem?.error),
      detail:
        problem?.message?.trim().slice(0, 300) ||
        problem?.error ||
        `Tangled answered HTTP ${response.status}.`,
      ...(problem?.error === undefined ? {} : { error: problem.error }),
    });
  });

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    nsid: string,
    params: Parameters<typeof query>[0],
    schema: S,
    service = BOBBIN,
  ) =>
    send({ operation: nsid, url: `${service}/xrpc/${nsid}?${query(params)}` }).pipe(
      Effect.flatMap((text) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(
            (cause) =>
              new TangledApiError({
                operation: nsid,
                status: null,
                reason: "failed",
                detail: "Tangled returned an unreadable response.",
                cause,
              }),
          ),
        ),
      ),
    );

  const identities = yield* Cache.makeWith<
    string,
    { readonly did: string; readonly handle: string | null },
    TangledApiError
  >(
    (identifier) =>
      read(NSID.resolveIdentity, { identifier }, Identity).pipe(
        Effect.map((identity) => ({
          did: identity.did,
          // atproto's placeholder for a handle that no longer verifies.
          handle: identity.handle === "handle.invalid" ? null : identity.handle,
        })),
      ),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? IDENTITY_TTL : Duration.zero),
    },
  );
  const resolveIdentity = (identifier: string) => Cache.get(identities, identifier.toLowerCase());

  const toRepository = Effect.fn("TangledApi.toRepository")(function* (
    manifest: typeof Manifest.Type,
  ) {
    const repoDid = manifest.uri.replace(/^at:\/\//u, "").split("/")[0] ?? "";
    const owner = yield* resolveIdentity(manifest.value.declaration.owner).pipe(
      Effect.orElseSucceed(() => ({ did: manifest.value.declaration.owner, handle: null })),
    );
    if (!isDid(repoDid) || !manifest.knot)
      return yield* new TangledApiError({
        operation: NSID.getRepoByRepoDid,
        status: null,
        reason: "failed",
        detail: "Tangled did not name the repository's DID and knot.",
      });
    return {
      repoDid,
      ownerDid: owner.did,
      ownerHandle: owner.handle,
      name: manifest.value.declaration.name,
      knot: manifest.knot,
      defaultBranch: manifest.defaultBranch ?? null,
      spindle: manifest.value.spindle ?? null,
    } satisfies TangledRepository;
  });

  const repositories: Cache.Cache<string, TangledRepository, TangledApiError> =
    yield* Cache.makeWith<string, TangledRepository, TangledApiError>(
      (key) => {
        const [, path = ""] = /^[^/]+\/(.+)$/u.exec(key) ?? [];
        const [first = "", name] = path.split("/");
        const manifest =
          name === undefined
            ? read(NSID.getRepoByRepoDid, { repoDid: first }, Manifest)
            : resolveIdentity(first).pipe(
                Effect.flatMap((owner) =>
                  read(NSID.getRepoByName, { owner: owner.did, name }, Manifest),
                ),
              );
        return manifest.pipe(
          Effect.flatMap(toRepository),
          Effect.tap((repository) =>
            name === undefined
              ? Effect.void
              : Cache.set(repositories, repositoryKey(repository), repository),
          ),
        );
      },
      {
        capacity: CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? REPOSITORY_TTL : Duration.zero),
      },
    );

  const maintainers = yield* Cache.makeWith<string, ReadonlySet<string>, TangledApiError>(
    Effect.fn("TangledApi.readMaintainers")(function* (key: string) {
      const [repoDid = "", ownerDid = ""] = key.split(" ");
      const page = yield* read(
        NSID.listCollaborators,
        { subject: repoDid, limit: 1000 },
        Collaborators,
      );
      return new Set([ownerDid, ...page.items.map((item) => item.subject)]);
    }),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? REPOSITORY_TTL : Duration.zero),
    },
  );

  const toTicket = (item: typeof TicketItem.Type): TangledTicket => ({
    uri: item.uri,
    cid: item.cid,
    rkey: rkeyOf(item.uri),
    authorDid: item.author,
    title: item.value.title.text,
    body: item.value.body?.text ?? "",
    state: ticketState(item.state),
    stateUpdatedAt: item.stateUpdatedAt ?? null,
    targetBranch: item.value.targetBranch ?? "",
    createdAt: item.value.createdAt,
    commentCount: item.commentCount ?? 0,
  });
  const decodeTicketItem = Schema.decodeUnknownOption(TicketItem);

  const rounds = yield* Cache.makeWith<string, ReadonlyArray<TangledRound>, TangledApiError>(
    Effect.fn("TangledApi.readRounds")(function* (uri: string) {
      const repoDid = uri.replace(/^at:\/\//u, "").split("/")[0] ?? "";
      const collected: Array<TangledRound> = [];
      let cursor: string | null = null;
      do {
        const page: typeof PatchPage.Type = yield* read(
          NSID.listPatches,
          { ticket: uri, order: "asc", limit: 100, cursor: cursor ?? undefined },
          PatchPage,
        );
        for (const patch of page.items)
          collected.push({
            round: collected.length + 1,
            uri: patch.uri,
            cid: patch.cid,
            baseOid: patch.value.base.oid,
            headOid: patch.value.head.oid,
            sourceRepoDid: patch.value.source?.repo || repoDid,
            sourceBranch: patch.value.source?.branch ?? null,
            createdAt: patch.value.createdAt,
          });
        cursor = page.items.length === 0 ? null : (page.cursor ?? null);
      } while (cursor !== null && collected.length < 1_000);
      return collected;
    }),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? ROUNDS_TTL : Duration.zero),
    },
  );

  const write = Effect.fn("TangledApi.write")(function* (input: TangledWrite) {
    const { repository, nsid } = input;
    // Record writes and patches are the repository's own; merges push to its knot.
    const aud = input.service === "bobbin" ? serviceDid(repository.knot) : repository.repoDid;
    const lxm = input.service === "bobbin" ? NSID.receivePack : nsid;
    const token = yield* auth.serviceAuth({ aud, lxm });
    const base = input.service === "bobbin" ? BOBBIN : `https://${repository.knot}`;
    const text = yield* send({
      operation: nsid,
      url: `${base}/xrpc/${nsid}`,
      method: "POST",
      token,
      body: input.service === "knot" ? { repo: repository.repoDid, ...input.body } : input.body,
    });
    return text.trim().length === 0 ? null : Option.getOrNull(decodeReceipt(text));
  });

  const createRepo = Effect.fn("TangledApi.createRepo")(function* (input: {
    readonly knot: string;
    readonly name: string;
    readonly createdAt: string;
  }) {
    const token = yield* auth.serviceAuth({ aud: serviceDid(input.knot), lxm: NSID.createRepo });
    const text = yield* send({
      operation: NSID.createRepo,
      url: `https://${input.knot}/xrpc/${NSID.createRepo}`,
      method: "POST",
      token,
      body: { name: input.name, createdAt: input.createdAt },
    });
    const created = Option.filter(decodeCreatedRepo(text), (repo) => isDid(repo.did));
    if (Option.isNone(created))
      return yield* new TangledApiError({
        operation: NSID.createRepo,
        status: null,
        reason: "failed",
        detail: `${input.knot} did not name the new repository's DID.`,
      });
    return created.value.did;
  });

  const deleteRepo = Effect.fn("TangledApi.deleteRepo")(function* (input: {
    readonly knot: string;
    readonly repoDid: string;
  }) {
    const token = yield* auth.serviceAuth({ aud: serviceDid(input.knot), lxm: NSID.deleteRepo });
    yield* send({
      operation: NSID.deleteRepo,
      url: `https://${input.knot}/xrpc/${NSID.deleteRepo}`,
      method: "POST",
      token,
      body: { repo: input.repoDid },
    });
  });

  return TangledApi.of({
    resolveIdentity,
    createRepo,
    deleteRepo,
    listMaintainers: Effect.fn("TangledApi.listMaintainers")((repository) =>
      Cache.get(maintainers, `${repository.repoDid} ${repository.ownerDid}`),
    ),
    resolveRepository: Effect.fn("TangledApi.resolveRepository")((reference) =>
      Cache.get(repositories, tangledRepositoryKey(reference)),
    ),
    cachedRepository: Effect.fn("TangledApi.cachedRepository")((reference) =>
      Cache.getSuccess(repositories, tangledRepositoryKey(reference)),
    ),
    listPulls: Effect.fn("TangledApi.listPulls")(function* (input) {
      const page = yield* read(
        NSID.listPulls,
        {
          subject: input.repoDid,
          status: input.state,
          limit: input.limit,
          cursor: input.cursor ?? undefined,
        },
        TicketPage,
      );
      return {
        items: page.items.flatMap((raw) => Option.toArray(decodeTicketItem(raw)).map(toTicket)),
        cursor: page.items.length === 0 ? null : (page.cursor ?? null),
      };
    }),
    getTicket: Effect.fn("TangledApi.getTicket")(function* (input) {
      const view = yield* read(
        NSID.getTicketView,
        { uri: ticketUri(input.repoDid, input.rkey) },
        TicketView,
      );
      return {
        uri: view.uri,
        cid: view.cid,
        rkey: rkeyOf(view.uri),
        authorDid: view.author.did,
        authorHandle: view.author.handle,
        title: view.title.text,
        body: view.body?.text ?? "",
        state: ticketState(view.state),
        stateUpdatedAt: null,
        targetBranch: view.targetBranch ?? "",
        createdAt: view.createdAt,
        commentCount: 0,
      };
    }),
    listRounds: Effect.fn("TangledApi.listRounds")((uri) => Cache.get(rounds, uri)),
    forgetRounds: Effect.fn("TangledApi.forgetRounds")(function* (uri) {
      if (uri === undefined) return yield* Cache.invalidateAll(rounds);
      for (const key of Array.from(yield* Cache.keys(rounds)))
        if (key === uri || key.startsWith(`${uri}/`)) yield* Cache.invalidate(rounds, key);
    }),
    listComments: Effect.fn("TangledApi.listComments")(function* (subjectUri) {
      const collected: Array<TangledComment> = [];
      let cursor: string | null = null;
      do {
        const page: typeof CommentPage.Type = yield* read(
          NSID.listComments,
          { subject: subjectUri, limit: 100, cursor: cursor ?? undefined },
          CommentPage,
        );
        for (const comment of page.items)
          collected.push({
            uri: comment.uri,
            cid: comment.cid,
            authorDid: comment.editor,
            body: comment.body?.text ?? "",
            createdAt: comment.createdAt,
            replyTo: comment.replyTo?.uri ?? null,
          });
        cursor = page.items.length === 0 ? null : (page.cursor ?? null);
      } while (cursor !== null && collected.length < 1_000);
      return collected;
    }),
    getRef: Effect.fn("TangledApi.getRef")((input) =>
      read(NSID.getRef, { repo: input.repoDid, ref: input.ref }, Ref).pipe(
        Effect.map((ref): string | null => ref.oid),
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(null),
        ),
      ),
    ),
    getMergeBase: Effect.fn("TangledApi.getMergeBase")((input) =>
      read(
        NSID.getMergeBase,
        { repos: input.repoDids, base: input.base, head: input.head },
        MergeBase,
      ).pipe(Effect.map((result) => result.commit)),
    ),
    listCommits: Effect.fn("TangledApi.listCommits")((input) =>
      read(
        NSID.listCommits,
        { repos: input.repoDids, ranges: [input.range], limit: input.limit },
        Commits,
      ).pipe(Effect.map((result) => result.commits)),
    ),
    getBlob: Effect.fn("TangledApi.getBlob")((input) =>
      send({
        operation: NSID.getBlob,
        url: `${BOBBIN}/xrpc/${NSID.getBlob}?${query({ repo: input.repoDid, ref: input.commit, path: input.path })}`,
      }).pipe(Effect.map((text) => (text.length > MAX_BLOB_BYTES ? null : text))),
    ),
    getDiff: Effect.fn("TangledApi.getDiff")((input) =>
      read(
        NSID.getDiff,
        {
          baseRepo: input.baseRepoDid,
          baseCommit: input.baseCommit,
          headRepo: input.headRepoDid,
          headCommit: input.headCommit,
        },
        Diffs,
      ).pipe(Effect.map((result) => result.diffs)),
    ),
    getInterdiff: Effect.fn("TangledApi.getInterdiff")((input) =>
      read(
        NSID.getInterdiff,
        // Named for the two rounds, not two sides: `base*` is the earlier round's range.
        {
          baseRepo: input.from.sourceRepoDid,
          baseCommit1: input.from.baseOid,
          baseCommit2: input.from.headOid,
          headRepo: input.to.sourceRepoDid,
          headCommit1: input.to.baseOid,
          headCommit2: input.to.headOid,
        },
        Diffs,
      ).pipe(Effect.map((result) => result.diffs)),
    ),
    mergeCheck: Effect.fn("TangledApi.mergeCheck")((input) =>
      read(
        NSID.mergeCheck,
        {
          targetRepo: input.targetRepoDid,
          targetCommit: input.targetCommit,
          sourceRepo: input.sourceRepoDid,
          sourceCommit: input.sourceCommit,
        },
        MergeCheck,
      ).pipe(
        Effect.map((result) => ({
          isConflicted: result.isConflicted,
          conflicts: result.conflicts.map((conflict) => conflict.filename),
        })),
      ),
    ),
    queryPipelines: Effect.fn("TangledApi.queryPipelines")((input) => {
      const host = input.repository.spindle ? hostOfServiceDid(input.repository.spindle) : null;
      return host === null || input.commits.length === 0
        ? Effect.succeed([])
        : read(
            NSID.queryPipelines,
            { repo: input.repository.repoDid, commits: input.commits, limit: 50 },
            Pipelines,
            `https://${host}`,
          ).pipe(Effect.map((result) => result.pipelines));
    }),
    getRecord: Effect.fn("TangledApi.getRecord")((input) =>
      read(
        NSID.getRecord,
        { repo: input.repository.repoDid, collection: input.collection, rkey: input.rkey },
        RecordView,
        `https://${input.repository.knot}`,
      ),
    ),
    write,
  });
});

export const layer = Layer.effect(TangledApi, make);
