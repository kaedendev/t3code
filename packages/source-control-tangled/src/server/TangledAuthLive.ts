import { Key, type Jwk } from "@atproto/jwk";
import {
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  requestLocalLock,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
} from "@atproto/oauth-client-node";
import {
  SourceControlProviderKind,
  SourceControlSignInError,
  type SourceControlSignInFailure,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import type { SourceControlSignIn } from "@t3tools/source-control-core/server/driver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  appSignInSettingsFields,
  readSourceControlHostSettings,
} from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { TangledAuth, TangledAuthError, type TangledViewer } from "./TangledAuth.ts";

/** The relay in `infra/tangled-oauth`: client metadata, assertion signing and the callback. */
const RELAY_ORIGIN = "https://t3-oauth.kaeden.codes";

const KIND = SourceControlProviderKind.make("tangled");
const HOST = "tangled.org";
// The relay keeps a callback 15 minutes; give up before it does.
const SIGN_IN_LIFETIME = Duration.minutes(10);
const POLL_INTERVAL = Duration.seconds(2);
const REQUEST_TIMEOUT = Duration.seconds(15);
const HANDLE_TTL = Duration.hours(1);

/** What the sign-in needs of `NodeOAuthClient`, so tests can stand in for the PDS. */
export interface TangledOAuthClient {
  /** The PDS authorize URL, and the `state` the relay files the callback under. */
  readonly authorize: (
    account: string,
  ) => Promise<{ readonly url: string; readonly state: string }>;
  /** Exchanges the relay's callback for a session the client saves, and names its DID. */
  readonly callback: (params: URLSearchParams) => Promise<{ readonly did: string }>;
  /** A request to the PDS of the saved session for `did`, refreshing its tokens as needed. */
  readonly fetch: (did: string, path: string, init?: RequestInit) => Promise<Response>;
  /** The handle `did` claims and resolves back to it, or null when it does not. */
  readonly handle: (did: string) => Promise<string | null>;
}

const SignInSettings = Schema.Struct(appSignInSettingsFields);

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(UnknownJson);
const encodeJson = Schema.encodeSync(UnknownJson);
// The library writes the session; `tokenSet.sub` is the one field read without its help.
const isSavedSession = Schema.is(
  Schema.Struct({ tokenSet: Schema.Struct({ sub: Schema.String }) }),
);
const decodeSavedSession = (raw: string) =>
  Option.filter(decodeJson(raw), isSavedSession) as Option.Option<NodeSavedSession>;

const readSavedSession = (
  sourceControlHost: SourceControlHost.SourceControlHost["Service"],
): Effect.Effect<{
  readonly signIns: Readonly<Record<string, string>>;
  readonly session: Option.Option<NodeSavedSession>;
}> =>
  sourceControlHost.settings.get.pipe(
    Effect.map((settings) => {
      const { signIns } = readSourceControlHostSettings(
        SignInSettings,
        settings.sourceControlHosts[KIND],
      );
      return { signIns, session: decodeSavedSession(signIns[HOST] ?? "") };
    }),
    Effect.orElseSucceed(() => ({ signIns: {}, session: Option.none<NodeSavedSession>() })),
  );

/**
 * The library's session store over the `signIns` secret setting. Only a sign-in stores a new
 * account; a refresh rewrites the session only while it is still the stored one, so a sign-out
 * during the refresh holds.
 * @public
 */
export const makeSessionStore = (
  sourceControlHost: SourceControlHost.SourceControlHost["Service"],
  isSigningIn: () => boolean,
) => {
  const write = (session: NodeSavedSession | null, when: (current: string | null) => boolean) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { signIns, session: current } = yield* readSavedSession(sourceControlHost);
        if (!when(Option.getOrNull(current)?.tokenSet.sub ?? null)) return;
        const next = { ...signIns };
        if (session === null) delete next[HOST];
        else next[HOST] = encodeJson(session);
        yield* sourceControlHost.settings.update({
          sourceControlHosts: { [KIND]: { signIns: next } },
        });
      }),
    );
  return {
    get: (did: string) =>
      Effect.runPromise(
        readSavedSession(sourceControlHost).pipe(
          Effect.map(({ session }) =>
            Option.getOrUndefined(Option.filter(session, (saved) => saved.tokenSet.sub === did)),
          ),
        ),
      ),
    set: (did: string, session: NodeSavedSession) =>
      write(session, (current) => current === did || isSigningIn()),
    del: (did: string) => write(null, (current) => current === did),
  } satisfies NodeSavedSessionStore;
};

const RelayJwks = Schema.Struct({
  keys: Schema.NonEmptyArray(Schema.Record(Schema.String, Schema.Unknown)),
});

/**
 * The client's signing key, whose private half only the relay holds. The relay's JWK carries no
 * `use`, which `Key` rejects for a signing key, and `Key` reads `isPrivate` from a `d` it lacks.
 */
class RelayKey extends Key {
  readonly #sign: (claims: unknown) => Promise<string>;

  constructor(jwk: Readonly<Record<string, unknown>>, sign: (claims: unknown) => Promise<string>) {
    const { use: _use, ...rest } = jwk;
    super(rest as Jwk);
    Object.defineProperty(this, "isPrivate", { value: true });
    this.#sign = sign;
  }

  override createJwt(_header: unknown, payload: unknown) {
    return this.#sign(payload) as ReturnType<Key["createJwt"]>;
  }

  override verifyJwt(): never {
    throw new Error("The relay key only signs client assertions.");
  }
}

const relayFailure = (cause: unknown) =>
  new TangledAuthError({
    reason: "failed",
    detail: "The server could not reach the Tangled sign-in relay.",
    cause,
  });

/** `NodeOAuthClient` configured from the relay, its sessions in the `signIns` setting. */
const makeNodeClient = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const relayJson = <S extends Schema.Top>(
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ) =>
    httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout(REQUEST_TIMEOUT),
      );
  const [metadata, jwks] = yield* Effect.all(
    [
      relayJson(
        HttpClientRequest.get(`${RELAY_ORIGIN}/tangled/client-metadata.json`),
        Schema.Record(Schema.String, Schema.Unknown),
      ),
      relayJson(HttpClientRequest.get(`${RELAY_ORIGIN}/tangled/jwks.json`), RelayJwks),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(relayFailure));
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const sign = (claims: unknown) =>
    runPromise(
      relayJson(
        HttpClientRequest.post(`${RELAY_ORIGIN}/tangled/assertion`).pipe(
          HttpClientRequest.bodyJsonUnsafe(claims),
        ),
        Schema.Struct({ assertion: Schema.String }),
      ).pipe(Effect.map(({ assertion }) => assertion)),
    );

  // A sign-in lives minutes, so pending state is kept in memory.
  const states = new Map<string, NodeSavedState>();
  // The library files each sign-in under a `state` it makes up; its `appState` finds it again.
  const stateByAttempt = new Map<string, string>();
  let signingIn = 0;
  let attempts = 0;

  const client = new NodeOAuthClient({
    clientMetadata: metadata as unknown as ConstructorParameters<
      typeof NodeOAuthClient
    >[0]["clientMetadata"],
    keyset: [new RelayKey(jwks.keys[0], sign)],
    requestLock: requestLocalLock,
    stateStore: {
      set: async (state, data) => {
        states.set(state, data);
        if (data.appState !== undefined) stateByAttempt.set(data.appState, state);
      },
      get: async (state) => states.get(state),
      del: async (state) => {
        states.delete(state);
      },
    },
    sessionStore: makeSessionStore(sourceControlHost, () => signingIn > 0),
  });
  const scope = typeof metadata.scope === "string" ? metadata.scope : undefined;

  return {
    authorize: async (account) => {
      const attempt = String((attempts += 1));
      const url = await client.authorize(account, { state: attempt, ...(scope && { scope }) });
      const state = stateByAttempt.get(attempt);
      stateByAttempt.delete(attempt);
      if (state === undefined) throw new Error("The OAuth client did not record its state.");
      return { url: url.toString(), state };
    },
    callback: async (params) => {
      signingIn += 1;
      try {
        const { session } = await client.callback(params);
        return { did: session.did };
      } finally {
        signingIn -= 1;
      }
    },
    fetch: async (did, path, init) => (await client.restore(did)).fetchHandler(path, init),
    handle: async (did) => {
      const { handle } = await client.identityResolver.resolve(did);
      return handle === "handle.invalid" ? null : handle;
    },
  } satisfies TangledOAuthClient;
});

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<{ readonly account: string }, SourceControlSignInError>;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
}

const signInError = (
  host: string,
  reason: SourceControlSignInFailure,
  detail: string,
  cause?: unknown,
) =>
  new SourceControlSignInError({
    provider: KIND,
    host,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isExpiredSession = (cause: unknown) =>
  cause instanceof TokenRefreshError ||
  cause instanceof TokenRevokedError ||
  cause instanceof TokenInvalidError;

class CallbackPending extends Schema.TaggedError<CallbackPending>()("CallbackPending", {}) {}

/** @public */
export const make = Effect.fn("TangledAuth.make")(function* (
  client: Effect.Effect<TangledOAuthClient, TangledAuthError>,
) {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());

  const storedDid = readSavedSession(sourceControlHost).pipe(
    Effect.map(({ session }) => Option.map(session, (saved) => saved.tokenSet.sub)),
  );

  const handles = yield* Cache.makeWith(
    (did: string) =>
      client.pipe(
        Effect.flatMap((oauth) =>
          Effect.tryPromise({
            try: () => oauth.handle(did),
            catch: (cause) =>
              new TangledAuthError({ reason: "failed", detail: errorMessage(cause), cause }),
          }),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
      ),
    {
      capacity: 8,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? HANDLE_TTL : Duration.zero),
    },
  );

  // Tangled routes accept a DID where a handle would go, so it stands in for one that fails.
  const handleOf = (did: string) =>
    Cache.get(handles, did).pipe(
      Effect.map((handle) => handle ?? did),
      Effect.catch((cause) =>
        Effect.logWarning("Could not resolve the Tangled account's handle.", {
          did,
          cause,
        }).pipe(Effect.as(did)),
      ),
    );

  const viewer: TangledAuth["Service"]["viewer"] = Effect.gen(function* () {
    const did = yield* storedDid;
    if (Option.isNone(did)) return Option.none<TangledViewer>();
    return Option.some({ did: did.value, handle: yield* handleOf(did.value) });
  }).pipe(Effect.withSpan("TangledAuth.viewer"));

  /** An XRPC call to the viewer's PDS as the viewer; a refused session fails as expired. */
  const pdsCall = Effect.fn("TangledAuth.pdsCall")(function* (
    nsid: string,
    request: { readonly query?: Record<string, string>; readonly body?: unknown },
  ) {
    const did = yield* storedDid;
    if (Option.isNone(did)) {
      return yield* new TangledAuthError({
        reason: "not-signed-in",
        detail: "Sign in to Tangled in Settings → Source Control.",
      });
    }
    const oauth = yield* client;
    const path = `/xrpc/${nsid}${request.query ? `?${new URLSearchParams(request.query)}` : ""}`;
    const init: RequestInit | undefined =
      request.body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeJson(request.body),
          };
    const response = yield* Effect.tryPromise({
      try: () => oauth.fetch(did.value, path, init),
      catch: (cause) =>
        isExpiredSession(cause)
          ? new TangledAuthError({
              reason: "expired",
              detail: "The Tangled sign-in expired. Sign in again in Settings → Source Control.",
              cause,
            })
          : new TangledAuthError({
              reason: "failed",
              detail: `Could not reach your PDS: ${errorMessage(cause)}`,
              cause,
            }),
    });
    const body = yield* Effect.promise(() =>
      response.json().then(
        (value: unknown) => value,
        () => null,
      ),
    );
    if (response.status === 401) {
      return yield* new TangledAuthError({
        reason: "expired",
        detail: "Your PDS no longer accepts the Tangled sign-in. Sign in again.",
      });
    }
    const fields =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    return { did: did.value, status: response.status, ok: response.ok, fields };
  });

  const refusal = (
    what: string,
    reply: { readonly status: number; readonly fields: Record<string, unknown> },
  ) => {
    const reason =
      typeof reply.fields.message === "string" ? reply.fields.message : reply.fields.error;
    return new TangledAuthError({
      reason: "failed",
      detail: `Your PDS would not ${what} (${reply.status}${
        typeof reason === "string" ? `: ${reason}` : ""
      }).`,
    });
  };

  const recordRef = (fields: Record<string, unknown>) =>
    typeof fields.uri === "string" && typeof fields.cid === "string"
      ? Option.some({ uri: fields.uri, cid: fields.cid })
      : Option.none();

  const serviceAuth: TangledAuth["Service"]["serviceAuth"] = Effect.fn("TangledAuth.serviceAuth")(
    function* ({ aud, lxm }) {
      const reply = yield* pdsCall("com.atproto.server.getServiceAuth", { query: { aud, lxm } });
      if (!reply.ok || typeof reply.fields.token !== "string")
        return yield* refusal(`authorize ${lxm}`, reply);
      return reply.fields.token;
    },
  );

  const getRecord: TangledAuth["Service"]["getRecord"] = Effect.fn("TangledAuth.getRecord")(
    function* ({ collection, rkey }) {
      const did = Option.getOrNull(yield* storedDid) ?? "";
      const reply = yield* pdsCall("com.atproto.repo.getRecord", {
        query: { repo: did, collection, rkey },
      });
      if (reply.fields.error === "RecordNotFound") return Option.none();
      if (!reply.ok) return yield* refusal(`read ${collection}/${rkey}`, reply);
      return recordRef(reply.fields);
    },
  );

  const createRecord: TangledAuth["Service"]["createRecord"] = Effect.fn(
    "TangledAuth.createRecord",
  )(function* ({ collection, rkey, record }) {
    const did = Option.getOrNull(yield* storedDid) ?? "";
    const reply = yield* pdsCall("com.atproto.repo.createRecord", {
      body: { repo: did, collection, rkey, record },
    });
    const written = reply.ok ? recordRef(reply.fields) : Option.none();
    if (Option.isNone(written)) return yield* refusal(`write ${collection}/${rkey}`, reply);
    return written.value;
  });

  const relayCallback = (state: string) =>
    httpClient.get(`${RELAY_ORIGIN}/tangled/callback/${state}`).pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        () => new CallbackPending(),
      ),
      Effect.flatMap((response) => response.text),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.map((query) => new URLSearchParams(query)),
    );

  const finish = Effect.fn("TangledAuth.finish")(function* (
    oauth: TangledOAuthClient,
    state: string,
    expiresAt: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    // Pending, a dropped poll and a relay hiccup all wait for the next tick.
    const params = yield* relayCallback(state).pipe(
      Effect.retry(
        Schedule.spaced(POLL_INTERVAL).pipe(
          Schedule.upTo({ duration: Duration.millis(Math.max(0, expiresAt - now)) }),
        ),
      ),
      Effect.mapError(() => signInError(HOST, "expired", "The sign-in expired. Start again.")),
    );
    const { did } = yield* Effect.tryPromise({
      try: () => oauth.callback(params),
      catch: (cause) => {
        const error = params.get("error");
        if (error === "access_denied") {
          return signInError(HOST, "denied", "The sign-in was declined.", cause);
        }
        return signInError(
          HOST,
          "failed",
          `Your PDS refused the sign-in: ${params.get("error_description") ?? error ?? errorMessage(cause)}`,
          cause,
        );
      },
    });
    yield* Cache.invalidate(handles, did);
    return { account: yield* handleOf(did) };
  });

  const start: SourceControlSignIn["start"] = Effect.fn("TangledAuth.signIn.start")(
    function* (rawHost, rawAccount) {
      const host = rawHost.trim().toLowerCase();
      if (host !== HOST) {
        return yield* signInError(host, "unsupported", `Tangled signs in only on ${HOST}.`);
      }
      const entered = rawAccount?.trim().replace(/^@/, "") ?? "";
      // Handles are case-insensitive and phone keyboards capitalize; DIDs and PDS URLs are not.
      const account = /^did:|:\/\//u.test(entered) ? entered : entered.toLowerCase();
      if (account === "") {
        return yield* signInError(host, "failed", "Enter your handle to sign in to Tangled.");
      }
      const oauth = yield* client.pipe(
        Effect.mapError((error) => signInError(host, "failed", error.detail, error)),
      );
      const { url, state } = yield* Effect.tryPromise({
        try: () => oauth.authorize(account),
        catch: (cause) =>
          signInError(
            host,
            "failed",
            `Could not start signing in as ${account}: ${errorMessage(cause)}`,
            cause,
          ),
      });
      const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(SIGN_IN_LIFETIME);
      const deferred = yield* Deferred.make<
        { readonly account: string },
        SourceControlSignInError
      >();
      const fiber = yield* finish(oauth, state, expiresAt).pipe(
        Deferred.into(deferred),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(pending, (current) => [
        current.get(host),
        new Map(current).set(host, { deferred, fiber }),
      ]);
      if (previous !== undefined) {
        yield* Deferred.fail(
          previous.deferred,
          signInError(host, "failed", "A newer sign-in replaced this one."),
        );
        yield* Fiber.interrupt(previous.fiber);
      }
      return { verificationUri: url, expiresAt } satisfies SourceControlSignInPrompt;
    },
  );

  const wait: SourceControlSignIn["wait"] = Effect.fn("TangledAuth.signIn.wait")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) {
        return yield* signInError(host, "not-started", "No sign-in is in progress. Start again.");
      }
      return yield* Deferred.await(current.deferred);
    },
  );

  const cancel: SourceControlSignIn["cancel"] = Effect.fn("TangledAuth.signIn.cancel")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) return;
      yield* Deferred.fail(
        current.deferred,
        signInError(host, "cancelled", "The sign-in was cancelled."),
      );
      yield* Fiber.interrupt(current.fiber);
    },
  );

  return TangledAuth.of({
    viewer,
    serviceAuth,
    getRecord,
    createRecord,
    signIn: {
      start,
      wait,
      cancel,
      // Tangled has no app to install per account, so nothing is ever "not covered".
      access: () => Effect.succeed("signed-out"),
    },
  });
});

export const layer: Layer.Layer<
  TangledAuth,
  never,
  SourceControlHost.SourceControlHost | HttpClient.HttpClient
> = Layer.effect(
  TangledAuth,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      SourceControlHost.SourceControlHost | HttpClient.HttpClient
    >();
    // Built on first use and kept, so a server that never signs in never reaches the relay.
    const clients = yield* Cache.makeWith(
      (_: "client") => makeNodeClient.pipe(Effect.provide(context)),
      {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );
    return yield* make(Cache.get(clients, "client"));
  }),
);
