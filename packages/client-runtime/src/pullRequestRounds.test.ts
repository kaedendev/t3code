import type { PullRequestRound } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestRoundEndsAtHead,
  pullRequestRoundOptions,
  selectPullRequestRoundOption,
} from "./pullRequestRounds.ts";

const rounds = (...numbers: ReadonlyArray<number>): ReadonlyArray<PullRequestRound> =>
  numbers.map((number) => ({
    number,
    baseSha: "b".repeat(64),
    headSha: String(number).repeat(64),
    createdAt: "2026-10-01T00:00:00.000Z",
  }));

describe("pullRequestRoundOptions", () => {
  it("offers nothing until there is a second round to choose", () => {
    expect(pullRequestRoundOptions(undefined)).toEqual([]);
    expect(pullRequestRoundOptions(rounds(1))).toEqual([]);
  });

  it("offers the latest round, each earlier one, and the changes since each earlier one", () => {
    expect(
      pullRequestRoundOptions(rounds(2, 3, 1)).map(({ label, selection }) => ({
        label,
        selection,
      })),
    ).toEqual([
      { label: "Round 3 (latest)", selection: null },
      { label: "Round 2", selection: { number: 2 } },
      { label: "Round 1", selection: { number: 1 } },
      { label: "Changes since round 2", selection: { number: 3, since: 2 } },
      { label: "Changes since round 1", selection: { number: 3, since: 1 } },
    ]);
  });
});

describe("selectPullRequestRoundOption", () => {
  it("keeps a reader on the changes since a round when a new round lands", () => {
    const before = pullRequestRoundOptions(rounds(1, 2));
    const key = before.find((option) => option.label === "Changes since round 1")!.key;

    expect(
      selectPullRequestRoundOption(pullRequestRoundOptions(rounds(1, 2, 3)), key),
    ).toMatchObject({ label: "Changes since round 1", selection: { number: 3, since: 1 } });
  });

  it("falls back to the latest round for a key this change request does not offer", () => {
    const key = pullRequestRoundOptions(rounds(1, 2, 3, 4, 5)).at(1)!.key;

    expect(selectPullRequestRoundOption(pullRequestRoundOptions(rounds(1, 2)), key)).toMatchObject({
      label: "Round 2 (latest)",
      selection: null,
    });
    expect(selectPullRequestRoundOption([], key)).toBeNull();
  });
});

describe("pullRequestRoundEndsAtHead", () => {
  it("lets a viewed tick stand only for a diff that ends at the latest round", () => {
    const three = rounds(1, 2, 3);
    expect(pullRequestRoundEndsAtHead(three, null)).toBe(true);
    expect(pullRequestRoundEndsAtHead(three, { number: 3, since: 1 })).toBe(true);
    expect(pullRequestRoundEndsAtHead(three, { number: 2 })).toBe(false);
    expect(pullRequestRoundEndsAtHead(rounds(1, 2, 3, 4), { number: 3, since: 1 })).toBe(false);
    expect(pullRequestRoundEndsAtHead(undefined, { number: 3, since: 1 })).toBe(false);
  });
});
