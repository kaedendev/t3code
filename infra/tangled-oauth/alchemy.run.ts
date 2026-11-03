import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/** Baked into T3 Code as Tangled's OAuth client ID, so it must never move. */
const DOMAIN = "t3-oauth.kaeden.codes";
const ZONE_ID = "fddb0c2795baf63e7fe0cf8d75575b7e";

const Callbacks = Cloudflare.D1.Database("Callbacks", { migrations: "./migrations" });

const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-10-01" },
  domain: { name: DOMAIN, zoneId: ZONE_ID },
  env: {
    DB: Callbacks,
    SIGNING_KEY: Config.Redacted("T3_TANGLED_OAUTH_SIGNING_KEY"),
    ORIGIN: `https://${DOMAIN}`,
  },
});

export default Alchemy.Stack(
  "T3TangledOAuth",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    yield* Callbacks;
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
