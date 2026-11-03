import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as TangledApi from "./TangledApi.ts";
import { TangledAuth, TangledAuthError, type TangledViewer } from "./TangledAuth.ts";

export const FAKE_PDS = "pds.test";

export interface RecordedRequest {
  readonly method: string;
  readonly host: string;
  readonly nsid: string;
  readonly params: URLSearchParams;
  readonly body: Record<string, unknown> | undefined;
  readonly token: string | null;
}

export interface FakeAnswer {
  readonly status?: number;
  readonly body: unknown;
}

/** An answer, or a function of the request; returning undefined answers 404. */
export type FakeRoute = unknown | ((request: RecordedRequest) => FakeAnswer | undefined);

export const KAEDEN: TangledViewer = {
  did: "did:plc:aszazhqi6awopjhatmhcvqsr",
  handle: "kaeden.codes",
};

/** Tangled's XRPC hosts as one fake that records every call and the tokens minted for them. */
export function fakeTangled(
  routes: Readonly<Record<string, FakeRoute>>,
  options: { readonly viewer?: TangledViewer | null } = {},
) {
  const requests: Array<RecordedRequest> = [];
  const minted: Array<{ readonly aud: string; readonly lxm: string }> = [];
  const decoder = new TextDecoder();
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const body =
      request.body._tag === "Uint8Array"
        ? (JSON.parse(decoder.decode(request.body.body)) as Record<string, unknown>)
        : undefined;
    const recorded: RecordedRequest = {
      method: request.method,
      host: url.host,
      nsid: url.pathname.replace(/^\/xrpc\//u, ""),
      params: url.searchParams,
      body,
      token: request.headers.authorization?.replace(/^Bearer /u, "") ?? null,
    };
    requests.push(recorded);
    const route = routes[recorded.nsid];
    const answer: FakeAnswer | undefined =
      typeof route === "function"
        ? (route as (request: RecordedRequest) => FakeAnswer | undefined)(recorded)
        : route === undefined
          ? undefined
          : { body: route };
    const text =
      answer === undefined
        ? JSON.stringify({ error: "RecordNotFound", message: `No route for ${recorded.nsid}` })
        : typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: answer === undefined ? 404 : (answer.status ?? 200) }),
      ),
    );
  });
  const viewer = options.viewer === undefined ? KAEDEN : options.viewer;
  /** The viewer's PDS answers from the same routes, on host `pds.test`. */
  const pds = (method: "GET" | "POST", path: string, body?: unknown) =>
    client
      .execute(
        body === undefined
          ? HttpClientRequest.get(`https://${FAKE_PDS}/xrpc/${path}`)
          : HttpClientRequest.post(`https://${FAKE_PDS}/xrpc/${path}`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.map((json) => {
              const fields = json as { uri: string; cid: string; message?: string };
              return {
                ok: response.status < 300,
                ref: { uri: fields.uri, cid: fields.cid },
                detail: fields.message ?? `HTTP ${response.status}`,
              };
            }),
          ),
        ),
        Effect.orDie,
      );
  const auth = Layer.succeed(
    TangledAuth,
    TangledAuth.of({
      viewer: Effect.succeed(Option.fromNullishOr(viewer)),
      serviceAuth: Effect.fn("FakeTangledAuth.serviceAuth")((input) =>
        Effect.sync(() => {
          minted.push(input);
          return `token:${input.lxm}`;
        }),
      ),
      getRecord: Effect.fn("FakeTangledAuth.getRecord")(function* (input) {
        const query = new URLSearchParams({ repo: viewer?.did ?? "", ...input });
        const reply = yield* pds("GET", `com.atproto.repo.getRecord?${query}`);
        return reply.ok ? Option.some(reply.ref) : Option.none();
      }),
      createRecord: Effect.fn("FakeTangledAuth.createRecord")(function* (input) {
        const reply = yield* pds("POST", "com.atproto.repo.createRecord", {
          repo: viewer?.did ?? "",
          ...input,
        });
        if (!reply.ok)
          return yield* new TangledAuthError({ reason: "failed", detail: reply.detail });
        return reply.ref;
      }),
      signIn: {
        start: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        cancel: () => Effect.void,
        access: () => Effect.succeed("signed-out"),
      },
    }),
  );
  const layer = TangledApi.layer.pipe(
    Layer.provideMerge(auth),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return {
    layer,
    requests,
    minted,
    writes: () => requests.filter((request) => request.method === "POST"),
    calls: (nsid: string) => requests.filter((request) => request.nsid === nsid),
  };
}
