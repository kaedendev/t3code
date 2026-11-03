import type { PullRequestDiffParams } from "./usePullRequestDiff";

/** Names the diff a screen shows, for its title and for keys that must not mix two diffs. */
export function pullRequestDiffScope(params: PullRequestDiffParams) {
  const { commit, round } = params;
  if (commit) return { key: commit, title: "Commit changes" };
  if (round?.since !== undefined)
    return {
      key: `since:${round.since}:${round.number}`,
      title: `Changes since round ${round.since}`,
    };
  if (round) return { key: `round:${round.number}`, title: `Round ${round.number} changes` };
  return { key: "all", title: "Changes" };
}
