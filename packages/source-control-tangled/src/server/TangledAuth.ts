import type { SourceControlSignIn } from "@t3tools/source-control-core/server/driver";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The atproto account the server is signed in to Tangled as. */
export interface TangledViewer {
  readonly did: string;
  readonly handle: string;
}

export interface TangledRecordRef {
  readonly uri: string;
  readonly cid: string;
}

export class TangledAuthError extends Schema.TaggedError<TangledAuthError>()("TangledAuthError", {
  reason: Schema.Literals(["not-signed-in", "expired", "denied", "failed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The server's Tangled sign-in: atproto OAuth through the relay in `infra/tangled-oauth`. Reads
 * need none of this. Writes to a repository are authorized by a short-lived service-auth token
 * minted here; the one record the viewer's own PDS holds, a repository's declaration, is written
 * here directly.
 */
export class TangledAuth extends Context.Service<
  TangledAuth,
  {
    readonly viewer: Effect.Effect<Option.Option<TangledViewer>>;
    /**
     * A service-auth JWT from the viewer's PDS for one call: `aud` is the repo DID for record
     * writes and `submitPatch`, or a knot's `did:web` for `org.tangled.git.receivePack`.
     */
    readonly serviceAuth: (input: {
      readonly aud: string;
      readonly lxm: string;
    }) => Effect.Effect<string, TangledAuthError>;
    /** A record in the viewer's own PDS repository; none when it does not exist. */
    readonly getRecord: (input: {
      readonly collection: string;
      readonly rkey: string;
    }) => Effect.Effect<Option.Option<TangledRecordRef>, TangledAuthError>;
    /** Writes a record to the viewer's own PDS repository, in a collection the sign-in covers. */
    readonly createRecord: (input: {
      readonly collection: string;
      readonly rkey: string;
      readonly record: Record<string, unknown>;
    }) => Effect.Effect<TangledRecordRef, TangledAuthError>;
    readonly signIn: SourceControlSignIn;
  }
>()("@t3tools/source-control-tangled/server/TangledAuth") {}
