import { TokenRefreshError, type NodeSavedSession } from "@atproto/oauth-client-node";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { TangledAuth } from "./TangledAuth.ts";
import * as TangledAuthLive from "./TangledAuthLive.ts";

const DID = "did:plc:aszazhqi6awopjhatmhcvqsr";
const STATE = "relay-state-0123456789";
const AUTHORIZE_URL = "https://pds.kaeden.codes/oauth/authorize?request_uri=urn%3Ax";

/** Trimmed from a session `NodeOAuthClient` saved on pds.kaeden.codes, keys replaced. */
const savedSession = (sub = DID): NodeSavedSession =>
  ({
    dpopJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "private" },
    authMethod: { method: "private_key_jwt", kid: "relay-1" },
    tokenSet: {
      iss: "https://pds.kaeden.codes",
      sub,
      aud: "https://pds.kaeden.codes",
      scope: "atproto",
      access_token: "access",
      refresh_token: "refresh",
      token_type: "DPoP",
      expires_at: "2026-11-03T03:00:00.000Z",
    },
  }) as NodeSavedSession;

/** The relay's callback endpoint: 204 until `deliver`, then the query once. */
function fakeRelay() {
  const callbacks = new Map<string, string>();
  const polls: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const state = new URL(request.url).pathname.split("/").pop() ?? "";
      polls.push(state);
      const query = callbacks.get(state);
      callbacks.delete(state);
      return HttpClientResponse.fromWeb(
        request,
        query === undefined ? new Response(null, { status: 204 }) : new Response(query),
      );
    }),
  );
  return { http, polls, deliver: (query: string) => callbacks.set(STATE, query) };
}

function harness(
  options: {
    readonly signIns?: Record<string, string>;
    readonly fetch?: TangledAuthLive.TangledOAuthClient["fetch"];
  } = {},
) {
  const relay = fakeRelay();
  const authorized: Array<string> = [];
  const callbacks: Array<URLSearchParams> = [];
  const fetched: Array<string> = [];
  const sent: Array<RequestInit | undefined> = [];
  const client: TangledAuthLive.TangledOAuthClient = {
    authorize: async (account) => {
      authorized.push(account);
      return { url: AUTHORIZE_URL, state: STATE };
    },
    callback: async (params) => {
      callbacks.push(params);
      if (params.has("error")) throw new Error(params.get("error") ?? "");
      return { did: DID };
    },
    fetch: (did, path, init) => {
      fetched.push(path);
      sent.push(init);
      return options.fetch?.(did, path, init) ?? Promise.resolve(Response.json({ token: "jwt" }));
    },
    handle: async () => "kaeden.codes",
  };
  const host = TestSourceControlHost.layer({
    settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: { tangled: { signIns: options.signIns ?? {} } },
    }),
  });
  const layer = Layer.effect(TangledAuth, TangledAuthLive.make(Effect.succeed(client))).pipe(
    Layer.provideMerge(host),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, relay.http)),
  );
  return { layer, relay, authorized, callbacks, fetched, sent };
}

const signedIn = { "tangled.org": JSON.stringify(savedSession()) };

describe("TangledAuthLive sign-in", () => {
  it.effect("finishes once the relay hands over the callback", () => {
    const { layer, relay, authorized, callbacks } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      expect(yield* signIn.start("Tangled.org", "@Kaeden.codes")).toEqual({
        verificationUri: AUTHORIZE_URL,
        expiresAt: 600_000,
      });
      expect(authorized).toEqual(["kaeden.codes"]);
      const waiting = yield* Effect.forkChild(signIn.wait("tangled.org"));
      yield* TestClock.adjust("4 seconds");
      relay.deliver(`code=abc&state=${STATE}&iss=https%3A%2F%2Fpds.kaeden.codes`);
      yield* TestClock.adjust("2 seconds");

      expect(yield* Fiber.join(waiting)).toEqual({ account: "kaeden.codes" });
      expect(relay.polls).toEqual([STATE, STATE, STATE, STATE]);
      expect(callbacks.map((params) => params.get("code"))).toEqual(["abc"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a sign-in the user declined", () => {
    const { layer, relay } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      relay.deliver(`error=access_denied&state=${STATE}`);
      const failure = yield* Effect.flip(signIn.wait("tangled.org"));
      expect(failure.reason).toBe("denied");
    }).pipe(Effect.provide(layer));
  });

  it.effect("expires a sign-in nobody approved", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("tangled.org")));
      yield* TestClock.adjust("11 minutes");
      expect((yield* Fiber.join(waiting)).reason).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops polling the relay once cancelled", () => {
    const { layer, relay } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("tangled.org")));
      yield* TestClock.adjust("2 seconds");
      yield* signIn.cancel("tangled.org");
      expect((yield* Fiber.join(waiting)).reason).toBe("cancelled");
      const polled = relay.polls.length;
      yield* TestClock.adjust("1 minute");
      expect(relay.polls).toHaveLength(polled);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to start without a handle or off tangled.org", () => {
    const { layer, authorized } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      expect((yield* Effect.flip(signIn.start("tangled.org", undefined))).reason).toBe("failed");
      expect((yield* Effect.flip(signIn.start("knot.example", "kaeden.codes"))).reason).toBe(
        "unsupported",
      );
      expect(authorized).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("TangledAuthLive session", () => {
  it.effect("names the stored session's account", () =>
    Effect.gen(function* () {
      const auth = yield* TangledAuth;
      expect(yield* auth.viewer).toEqual(Option.some({ did: DID, handle: "kaeden.codes" }));
    }).pipe(Effect.provide(harness({ signIns: signedIn }).layer)),
  );

  it.effect("mints a service-auth token for the audience and method asked for", () => {
    const { layer, fetched } = harness({ signIns: signedIn });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      const token = yield* auth.serviceAuth({
        aud: "did:web:knot1.tangled.sh",
        lxm: "org.tangled.git.receivePack",
      });
      expect(token).toBe("jwt");
      expect(fetched).toEqual([
        "/xrpc/com.atproto.server.getServiceAuth?aud=did%3Aweb%3Aknot1.tangled.sh&lxm=org.tangled.git.receivePack",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      name: "no session",
      signIns: {},
      fetch: undefined,
      reason: "not-signed-in",
    },
    {
      name: "a refresh the PDS refuses",
      signIns: signedIn,
      fetch: () => Promise.reject(new TokenRefreshError(DID, "invalid_grant")),
      reason: "expired",
    },
    {
      name: "a token the PDS rejects",
      signIns: signedIn,
      fetch: () => Promise.resolve(Response.json({ error: "InvalidToken" }, { status: 401 })),
      reason: "expired",
    },
    {
      name: "any other refusal",
      signIns: signedIn,
      fetch: () => Promise.resolve(Response.json({ error: "BadExpiration" }, { status: 400 })),
      reason: "failed",
    },
  ])("reads $name as $reason", ({ signIns, fetch, reason }) =>
    Effect.gen(function* () {
      const auth = yield* TangledAuth;
      const failure = yield* Effect.flip(
        auth.serviceAuth({ aud: DID, lxm: "com.atproto.repo.createRecord" }),
      );
      expect(failure.reason).toBe(reason);
    }).pipe(Effect.provide(harness({ signIns, ...(fetch && { fetch }) }).layer)),
  );

  it.effect("reads and writes the viewer's own records on their PDS", () => {
    const declaration = { uri: `at://${DID}/org.tangled.repo.declaration/demo`, cid: "bafydecl" };
    const { layer, fetched, sent } = harness({
      signIns: signedIn,
      fetch: (_did, path) =>
        Promise.resolve(
          path.includes("getRecord")
            ? Response.json(
                { error: "RecordNotFound", message: "Could not locate record" },
                { status: 400 },
              )
            : Response.json(declaration),
        ),
    });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      const slot = { collection: "org.tangled.repo.declaration", rkey: "demo" };
      expect(Option.isNone(yield* auth.getRecord(slot))).toBe(true);
      const record = { $type: "org.tangled.repo.declaration", repo: "did:plc:newrepo" };
      expect(yield* auth.createRecord({ ...slot, record })).toEqual(declaration);
      expect(fetched).toEqual([
        `/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=org.tangled.repo.declaration&rkey=demo`,
        "/xrpc/com.atproto.repo.createRecord",
      ]);
      expect(sent[0]).toBeUndefined();
      expect(sent[1]?.method).toBe("POST");
      expect(JSON.parse(String(sent[1]?.body))).toEqual({ repo: DID, ...slot, record });
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the library's session in the signIns secret across restarts", () =>
    Effect.gen(function* () {
      const host = yield* SourceControlHost.SourceControlHost;
      const signingIn = TangledAuthLive.makeSessionStore(host, () => true);
      yield* Effect.promise(() => signingIn.set(DID, savedSession()));
      const settings = yield* host.settings.get;
      expect(
        Object.keys((settings.sourceControlHosts.tangled as { signIns: object }).signIns),
      ).toEqual(["tangled.org"]);

      const restarted = TangledAuthLive.makeSessionStore(host, () => false);
      expect(yield* Effect.promise(() => restarted.get(DID))).toEqual(savedSession());
      expect(yield* Effect.promise(() => restarted.get("did:plc:someoneelse"))).toBeUndefined();

      yield* Effect.promise(() => restarted.del(DID));
      expect(yield* Effect.promise(() => restarted.get(DID))).toBeUndefined();
      // A refresh finishing after the sign-out does not sign back in.
      yield* Effect.promise(() => restarted.set(DID, savedSession()));
      expect(yield* Effect.promise(() => restarted.get(DID))).toBeUndefined();
    }).pipe(Effect.provide(TestSourceControlHost.layer())),
  );
});
