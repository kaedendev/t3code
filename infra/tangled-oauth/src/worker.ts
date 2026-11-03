// @effect-diagnostics globalDate:off - a plain fetch Worker with no Effect runtime.
/**
 * The OAuth client T3 Code servers sign in to Tangled as. atproto requires a public client
 * metadata URL, and T3 servers usually sit on a private network, so this Worker holds what must
 * be public: the metadata, the signing key of the confidential client, and the redirect target.
 * A server polls `/tangled/callback/<state>` for the code, so the browser never has to reach it.
 */

export interface Env {
  readonly DB: D1Database;
  /** ES256 private JWK, as JSON (scripts/keygen.ts). */
  readonly SIGNING_KEY: string;
  /** This Worker's origin, as `https://t3-oauth.kaeden.codes`. */
  readonly ORIGIN: string;
}

export const SCOPES = [
  "atproto",
  "blob:image/*",
  "blob:video/*",
  "repo:org.tangled.repo.declaration",
  "repo:org.tangled.key.sshKey",
  "rpc:com.atproto.repo.createRecord?aud=*",
  "rpc:com.atproto.repo.putRecord?aud=*",
  "rpc:com.atproto.repo.deleteRecord?aud=*",
  "rpc:com.atproto.repo.uploadBlob?aud=*",
  "rpc:org.tangled.repo.createRepo?aud=*",
  "rpc:org.tangled.repo.deleteRepo?aud=*",
  "rpc:org.tangled.review.submitPatch?aud=*",
  "rpc:org.tangled.git.receivePack?aud=*",
  "rpc:org.tangled.ci.approvePipeline?aud=*",
  "rpc:org.tangled.ci.retryPipeline?aud=*",
  "rpc:org.tangled.ci.cancelPipeline?aud=*",
];

/** How long a callback waits for its server; a sign-in takes minutes at most. */
const CALLBACK_SECONDS = 15 * 60;
/** atproto authorization servers reject client assertions older than this. */
const ASSERTION_MAX_AGE_SECONDS = 60;
const CALLBACK_PARAMS = ["code", "state", "iss", "error", "error_description"] as const;
const STATE = /^[A-Za-z0-9_-]{16,128}$/u;

export function clientId(origin: string): string {
  return `${origin}/tangled/client-metadata.json`;
}

export function clientMetadata(origin: string) {
  return {
    client_id: clientId(origin),
    client_name: "T3 Code",
    client_uri: origin,
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [`${origin}/tangled/callback`],
    scope: SCOPES.join(" "),
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${origin}/tangled/jwks.json`,
    dpop_bound_access_tokens: true,
  };
}

interface PrivateJwk extends JsonWebKey {
  readonly kid: string;
}

export function publicJwk({ kid, kty, crv, x, y }: PrivateJwk) {
  return { kid, kty, crv, x, y, alg: "ES256", use: "sig" };
}

/**
 * The claims a client assertion may carry, or null. Only this client's own assertions are
 * signed, for an HTTPS audience, issued now; the Worker never signs anything else.
 */
export function assertionClaims(
  body: unknown,
  origin: string,
  nowSeconds: number,
): Record<string, string | number> | null {
  if (typeof body !== "object" || body === null) return null;
  const { iss, sub, aud, jti, iat } = body as Record<string, unknown>;
  const id = clientId(origin);
  if (iss !== id || sub !== id) return null;
  if (typeof aud !== "string" || typeof jti !== "string" || jti.length < 8 || jti.length > 128)
    return null;
  if (typeof iat !== "number" || Math.abs(nowSeconds - iat) > ASSERTION_MAX_AGE_SECONDS)
    return null;
  try {
    if (new URL(aud).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { iss, sub, aud, jti, iat };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function signJwt(jwk: PrivateJwk, claims: Record<string, string | number>) {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const input = `${encodeJson({ alg: "ES256", typ: "JWT", kid: jwk.kid })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

const page = (title: string, message: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;margin:20vh auto;max-width:28rem;text-align:center"><h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/gu, (character) => `&#${character.codePointAt(0)};`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const jwk = JSON.parse(env.SIGNING_KEY) as PrivateJwk;
    const now = Math.floor(Date.now() / 1000);

    if (request.method === "GET" && url.pathname === "/tangled/client-metadata.json") {
      return Response.json(clientMetadata(env.ORIGIN), {
        headers: { "cache-control": "public, max-age=300" },
      });
    }
    if (request.method === "GET" && url.pathname === "/tangled/jwks.json") {
      return Response.json(
        { keys: [publicJwk(jwk)] },
        { headers: { "cache-control": "public, max-age=300" } },
      );
    }
    if (request.method === "POST" && url.pathname === "/tangled/assertion") {
      const claims = assertionClaims(await request.json().catch(() => null), env.ORIGIN, now);
      if (claims === null) return Response.json({ error: "invalid_claims" }, { status: 400 });
      return Response.json({ assertion: await signJwt(jwk, claims) });
    }
    if (request.method === "GET" && url.pathname === "/tangled/callback") {
      const state = url.searchParams.get("state") ?? "";
      if (!STATE.test(state)) return page("Sign-in failed", "The sign-in link is not valid.", 400);
      const query = new URLSearchParams();
      for (const name of CALLBACK_PARAMS) {
        const value = url.searchParams.get(name);
        if (value !== null) query.set(name, value);
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM callbacks WHERE created_at < ?").bind(now - CALLBACK_SECONDS),
        env.DB.prepare(
          "INSERT OR REPLACE INTO callbacks (state, query, created_at) VALUES (?, ?, ?)",
        ).bind(state, query.toString(), now),
      ]);
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      return error === null
        ? page("Signed in to Tangled", "You can close this tab and return to T3 Code.")
        : page("Sign-in did not finish", escapeHtml(error));
    }
    const pending = /^\/tangled\/callback\/([A-Za-z0-9_-]+)$/u.exec(url.pathname)?.[1];
    if (request.method === "GET" && pending !== undefined && STATE.test(pending)) {
      const row = await env.DB.prepare(
        "DELETE FROM callbacks WHERE state = ? AND created_at >= ? RETURNING query",
      )
        .bind(pending, now - CALLBACK_SECONDS)
        .first<{ query: string }>();
      return row === null
        ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
        : new Response(row.query, {
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "cache-control": "no-store",
            },
          });
    }
    return new Response("Not found", { status: 404 });
  },
};
