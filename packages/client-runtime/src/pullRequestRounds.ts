import type { PullRequestRound, PullRequestRoundSelection } from "@t3tools/contracts";

export interface PullRequestRoundOption {
  /** "Changes since round 2" keeps its key when a new round lands, and then ends at that one. */
  readonly key: string;
  readonly kind: "round" | "since";
  readonly label: string;
  /** Null reads the whole change, which on a host with rounds is the latest one. */
  readonly selection: PullRequestRoundSelection | null;
}

const LATEST_KEY = "latest";

const latestRound = (rounds: ReadonlyArray<PullRequestRound> | undefined) =>
  (rounds ?? []).reduce<number | undefined>(
    (latest, round) => (latest === undefined || round.number > latest ? round.number : latest),
    undefined,
  );

/** Empty unless the host kept more than one round, the only case with a choice to make. */
export function pullRequestRoundOptions(
  rounds: ReadonlyArray<PullRequestRound> | undefined,
): ReadonlyArray<PullRequestRoundOption> {
  const latest = latestRound(rounds);
  const earlier = (rounds ?? [])
    .map((round) => round.number)
    .filter((number) => number !== latest)
    .sort((left, right) => right - left);
  if (latest === undefined || earlier.length === 0) return [];
  return [
    { key: LATEST_KEY, kind: "round", label: `Round ${latest} (latest)`, selection: null },
    ...earlier.map((number) => ({
      key: `round:${number}`,
      kind: "round" as const,
      label: `Round ${number}`,
      selection: { number },
    })),
    ...earlier.map((since) => ({
      key: `since:${since}`,
      kind: "since" as const,
      label: `Changes since round ${since}`,
      selection: { number: latest, since },
    })),
  ];
}

/** The option a remembered key names, or the latest round when it names none of them. */
export function selectPullRequestRoundOption(
  options: ReadonlyArray<PullRequestRoundOption>,
  key: string | null,
): PullRequestRoundOption | null {
  return options.find((option) => option.key === key) ?? options[0] ?? null;
}

/**
 * A viewed tick records the head's version of a file, so it is true to what the reader saw only
 * where the diff ends at the latest round. Unknown rounds cannot confirm that.
 */
export function pullRequestRoundEndsAtHead(
  rounds: ReadonlyArray<PullRequestRound> | undefined,
  selection: PullRequestRoundSelection | null | undefined,
): boolean {
  return selection === null || selection === undefined || selection.number === latestRound(rounds);
}
