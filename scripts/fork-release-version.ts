#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

// Fork release X.Y.Z carries respin N of upstream stable X.Y.P as Z = 10000 + 100·P + N. A plain
// stable version classifies as Stable everywhere, and the offset keeps every fork version above, and
// never equal to, any upstream X.Y.P, so no fork build shares a runtime directory with an upstream one.
const PATCH_OFFSET = 10_000;
const MAX_COMPONENT = 99;
const PLAIN_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class ForkReleaseVersionError extends Schema.TaggedError<ForkReleaseVersionError>()(
  "ForkReleaseVersionError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

function parsePlain(version: string) {
  const match = PLAIN_VERSION.exec(version.trim());
  return match ? { major: match[1], minor: match[2], patch: Number(match[3]) } : undefined;
}

export function formatForkReleaseVersion(base: string, respin: number): string | undefined {
  const parsed = parsePlain(base);
  if (
    parsed === undefined ||
    parsed.patch > MAX_COMPONENT ||
    !Number.isInteger(respin) ||
    respin < 1 ||
    respin > MAX_COMPONENT
  ) {
    return undefined;
  }
  return `${parsed.major}.${parsed.minor}.${PATCH_OFFSET + parsed.patch * 100 + respin}`;
}

export function parseForkReleaseVersion(
  version: string,
): { readonly base: string; readonly respin: number } | undefined {
  const parsed = parsePlain(version);
  if (parsed === undefined || parsed.patch <= PATCH_OFFSET) return undefined;
  const encoded = parsed.patch - PATCH_OFFSET;
  const respin = encoded % 100;
  const basePatch = Math.floor(encoded / 100);
  if (respin === 0 || basePatch > MAX_COMPONENT) return undefined;
  return { base: `${parsed.major}.${parsed.minor}.${basePatch}`, respin };
}

/** The next respin of `base`, one past the highest fork release already tagged on it. */
export function nextForkReleaseVersion(
  base: string,
  releasedTags: ReadonlyArray<string>,
): string | undefined {
  const normalizedBase = base.trim().replace(/^v/, "");
  const highest = releasedTags.reduce((max, tag) => {
    const fork = parseForkReleaseVersion(tag);
    return fork?.base === normalizedBase ? Math.max(max, fork.respin) : max;
  }, 0);
  return formatForkReleaseVersion(normalizedBase, highest + 1);
}

const command = Command.make(
  "fork-release-version",
  {
    base: Flag.String("base").pipe(
      Flag.withDescription("Upstream stable version the fork build is based on, such as 0.1.6."),
    ),
    released: Flag.String("released").pipe(
      Flag.withDescription("Whitespace-separated tags already released on the fork."),
      Flag.withDefault(""),
    ),
    version: Flag.String("version").pipe(
      Flag.withDescription("Exact fork version to use instead of the next respin."),
      Flag.optional,
    ),
  },
  Effect.fn("fork-release-version")(function* ({ base, released, version }) {
    const releasedTags = released.split(/\s+/).filter((tag) => tag.length > 0);
    const requested = Option.getOrUndefined(version)?.trim().replace(/^v/, "");
    if (requested !== undefined) {
      const fork = parseForkReleaseVersion(requested);
      if (fork === undefined || fork.base !== base.trim().replace(/^v/, "")) {
        return yield* new ForkReleaseVersionError({
          reason: `${requested} is not a fork release of upstream ${base}.`,
        });
      }
      return yield* Console.log(requested);
    }
    const next = nextForkReleaseVersion(base, releasedTags);
    if (next === undefined) {
      return yield* new ForkReleaseVersionError({
        reason: `No fork release version is left for upstream ${base}.`,
      });
    }
    yield* Console.log(next);
  }),
).pipe(Command.withDescription("Print the fork release version for an upstream stable base."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
