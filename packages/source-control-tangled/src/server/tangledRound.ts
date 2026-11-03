import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as TangledApi from "./TangledApi.ts";

const POLL = Schedule.spaced(Duration.seconds(1));
const MIRROR_WAIT = Duration.seconds(20);
const INDEX_WAIT = Duration.seconds(10);

const refused = (detail: string) =>
  new TangledApi.TangledApiError({
    operation: TangledApi.NSID.submitPatch,
    status: null,
    reason: "failed",
    detail,
  });

export interface TangledRoundSource {
  readonly target: TangledApi.TangledRepository;
  readonly targetBranch: string;
  readonly sourceRepoDid: string;
  readonly sourceBranch: string;
}

/**
 * The range a round of `sourceBranch` proposes now: its tip as Tangled has it, from where it left
 * the target's tip, as `tg pr create` and the web's Resubmit compute it.
 */
export const proposeRound = Effect.fn("TangledRound.proposeRound")(function* (
  api: TangledApi.TangledApi["Service"],
  source: TangledRoundSource,
) {
  const { target, targetBranch, sourceRepoDid, sourceBranch } = source;
  const [head, targetTip] = yield* Effect.all(
    [
      api.getRef({ repoDid: sourceRepoDid, ref: `refs/heads/${sourceBranch}` }),
      api.getRef({ repoDid: target.repoDid, ref: `refs/heads/${targetBranch}` }),
    ],
    { concurrency: 2 },
  );
  if (head === null)
    return yield* refused(`Tangled does not have ${sourceBranch} yet. Push it, then try again.`);
  if (targetTip === null) return yield* refused(`Tangled has no ${targetBranch} branch.`);
  const base = yield* api.getMergeBase({
    repoDids: sourceRepoDid === target.repoDid ? [target.repoDid] : [target.repoDid, sourceRepoDid],
    base: targetTip,
    head,
  });
  if (base === head)
    return yield* refused(`${sourceBranch} has no commits that ${targetBranch} lacks.`);
  return { base, head };
});

/** Tangled's mirror learns of a push after the knot takes it; this waits for it, briefly. */
export const awaitMirroredHead = Effect.fn("TangledRound.awaitMirroredHead")(function* (
  api: TangledApi.TangledApi["Service"],
  input: { readonly repoDid: string; readonly branch: string; readonly head: string },
) {
  const seen = yield* api
    .getRef({ repoDid: input.repoDid, ref: `refs/heads/${input.branch}` })
    .pipe(
      Effect.repeat({ until: (tip) => tip === input.head, schedule: POLL }),
      Effect.timeoutOption(MIRROR_WAIT),
    );
  if (seen._tag === "None")
    return yield* refused(
      `Tangled has not seen ${input.branch} at ${input.head.slice(0, 12)} yet. Resubmit from the pull request once it has.`,
    );
});

/**
 * Adds `round` as the ticket's next round, then waits briefly for bobbin to list it, so a read
 * straight after shows it as the web's Resubmit does.
 */
export const submitRound = Effect.fn("TangledRound.submitRound")(function* (
  api: TangledApi.TangledApi["Service"],
  input: TangledRoundSource & {
    readonly ticketUri: string;
    readonly base: string;
    readonly head: string;
  },
) {
  const rkey = input.ticketUri.slice(input.ticketUri.lastIndexOf("/") + 1);
  const receipt = yield* api.write({
    service: "knot",
    repository: input.target,
    nsid: TangledApi.NSID.submitPatch,
    body: {
      patch: {
        ticket: rkey,
        base: { oid: input.base },
        head: { oid: input.head },
        sourceRepo: input.sourceRepoDid,
        sourceBranch: input.sourceBranch,
      },
    },
  });
  yield* api.forgetRounds(input.ticketUri).pipe(
    Effect.andThen(api.listRounds(input.ticketUri)),
    Effect.repeat({
      until: (rounds) =>
        rounds.at(-1)?.headOid === input.head &&
        (receipt === null || rounds.at(-1)?.cid === receipt.cid),
      schedule: POLL,
    }),
    Effect.timeoutOption(INDEX_WAIT),
    Effect.ignore,
  );
  yield* api.forgetRounds(input.ticketUri);
  return receipt;
});
