// @effect-diagnostics nodeBuiltinImport:off - verifies signatures with node:crypto against the plain Worker.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";

import worker, { assertionClaims, clientId, type Env } from "./worker.ts";

const ORIGIN = "https://t3-oauth.example";
const ID = clientId(ORIGIN);
const NOW = 1_800_000_000;

function fakeDb() {
  const rows = new Map<string, { query: string; created_at: number }>();
  const statement = (sql: string, args: ReadonlyArray<unknown> = []) => ({
    bind: (...values: ReadonlyArray<unknown>) => statement(sql, values),
    run: async () => {
      if (sql.startsWith("DELETE FROM callbacks WHERE created_at")) {
        for (const [state, row] of rows)
          if (row.created_at < (args[0] as number)) rows.delete(state);
      } else if (sql.startsWith("INSERT")) {
        rows.set(args[0] as string, { query: args[1] as string, created_at: args[2] as number });
      }
    },
    first: async () => {
      const row = rows.get(args[0] as string);
      if (row === undefined || row.created_at < (args[1] as number)) return null;
      rows.delete(args[0] as string);
      return { query: row.query };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReadonlyArray<{ run: () => Promise<void> }>) => {
      for (const s of statements) await s.run();
    },
  } as unknown as D1Database;
}

function env(): Env {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...privateKey.export({ format: "jwk" }), kid: "test-key" };
  return { DB: fakeDb(), SIGNING_KEY: JSON.stringify(jwk), ORIGIN };
}

describe("assertionClaims", () => {
  const valid = { iss: ID, sub: ID, aud: "https://bsky.social", jti: "abcdefgh", iat: NOW };

  it("signs only this client's assertions for an HTTPS audience issued now", () => {
    expect(assertionClaims(valid, ORIGIN, NOW)).toEqual(valid);
    expect(assertionClaims({ ...valid, iss: "https://other/client.json" }, ORIGIN, NOW)).toBeNull();
    expect(assertionClaims({ ...valid, sub: "did:plc:someone" }, ORIGIN, NOW)).toBeNull();
    expect(assertionClaims({ ...valid, aud: "http://bsky.social" }, ORIGIN, NOW)).toBeNull();
    expect(assertionClaims({ ...valid, iat: NOW - 120 }, ORIGIN, NOW)).toBeNull();
    expect(assertionClaims({ ...valid, jti: "x" }, ORIGIN, NOW)).toBeNull();
    expect(assertionClaims(null, ORIGIN, NOW)).toBeNull();
  });
});

describe("worker", () => {
  it("serves an assertion that verifies against the published key", async () => {
    const e = env();
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const iat = NOW;
    const response = await worker.fetch(
      new Request(`${ORIGIN}/tangled/assertion`, {
        method: "POST",
        body: JSON.stringify({
          iss: ID,
          sub: ID,
          aud: "https://bsky.social",
          jti: "abcdefgh",
          iat,
        }),
      }),
      e,
    );
    const { assertion } = (await response.json()) as { assertion: string };
    const jwks = (await (
      await worker.fetch(new Request(`${ORIGIN}/tangled/jwks.json`), e)
    ).json()) as {
      keys: ReadonlyArray<JsonWebKey & { kid: string }>;
    };
    const [header, payload, signature] = assertion.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({
      alg: "ES256",
      kid: "test-key",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      aud: "https://bsky.social",
    });
    const key = NodeCrypto.createPublicKey({ key: jwks.keys[0] as never, format: "jwk" });
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("hands a callback to the server once", async () => {
    const e = env();
    const state = "AAAAAAAAAAAAAAAAAAAAAA";
    const callback = await worker.fetch(
      new Request(
        `${ORIGIN}/tangled/callback?code=abc&state=${state}&iss=https%3A%2F%2Fbsky.social&extra=1`,
      ),
      e,
    );
    expect(callback.status).toBe(200);
    const first = await worker.fetch(new Request(`${ORIGIN}/tangled/callback/${state}`), e);
    expect(new URLSearchParams(await first.text())).toEqual(
      new URLSearchParams({ code: "abc", state, iss: "https://bsky.social" }),
    );
    const second = await worker.fetch(new Request(`${ORIGIN}/tangled/callback/${state}`), e);
    expect(second.status).toBe(204);
  });

  it("refuses a callback without a valid state", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/tangled/callback?code=abc&state=x`),
      env(),
    );
    expect(response.status).toBe(400);
  });
});
