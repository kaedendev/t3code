// @effect-diagnostics nodeBuiltinImport:off - Reads install.ps1 and resolves the desktop app's electron-updater semver.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  crossesReleaseTrack,
  cliReleaseChannelOf,
  desktopUpdateChannelOf,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { describe, expect, it } from "vite-plus/test";

import { isDesktopPreviewVersion, resolveDesktopUpdateChannel } from "./build-desktop-artifact.ts";
import {
  formatForkReleaseVersion,
  nextForkReleaseVersion,
  parseForkReleaseVersion,
} from "./fork-release-version.ts";

// The comparison electron-updater itself runs, from the copy the desktop app ships.
const desktopRequire = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../apps/desktop/package.json"),
);
const updaterSemver = NodeModule.createRequire(desktopRequire.resolve("electron-updater"))(
  "semver",
) as {
  readonly gt: (left: string, right: string) => boolean;
  readonly prerelease: (version: string) => ReadonlyArray<string | number> | null;
};

const installPs1StablePattern = (() => {
  const source = NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "install.ps1"), "utf8");
  const pattern = /"stable" \{ '([^']+)' \}/.exec(source)?.[1];
  if (pattern === undefined) throw new Error("install.ps1 no longer has a stable tag pattern");
  return new RegExp(pattern);
})();

// Oldest to newest; every pair must sort in this order everywhere a version is compared.
const ascending = [
  "0.1.5",
  "0.1.6",
  "0.1.10601",
  "0.1.10602",
  "0.1.10699",
  "0.1.10701",
  "0.2.10001",
];

describe("fork release versions", () => {
  it("encode upstream base and respin and decode back", () => {
    expect(formatForkReleaseVersion("0.1.6", 1)).toBe("0.1.10601");
    expect(formatForkReleaseVersion("v0.2.0", 1)).toBe("0.2.10001");
    expect(formatForkReleaseVersion("0.1.6", 0)).toBeUndefined();
    expect(formatForkReleaseVersion("0.1.6", 100)).toBeUndefined();
    expect(formatForkReleaseVersion("0.1.100", 1)).toBeUndefined();
    expect(formatForkReleaseVersion("0.1.6-nightly.20261031.1", 1)).toBeUndefined();
    expect(parseForkReleaseVersion("0.1.10601")).toEqual({ base: "0.1.6", respin: 1 });
    expect(parseForkReleaseVersion("v0.2.10012")).toEqual({ base: "0.2.0", respin: 12 });
    expect(parseForkReleaseVersion("0.1.6")).toBeUndefined();
    expect(parseForkReleaseVersion("0.1.10600")).toBeUndefined();
  });

  it("pick the respin after the highest one released on the same base", () => {
    expect(nextForkReleaseVersion("0.1.6", [])).toBe("0.1.10601");
    expect(nextForkReleaseVersion("v0.1.6", ["v0.1.10601", "v0.1.10603", "v0.1.10501"])).toBe(
      "0.1.10604",
    );
    expect(nextForkReleaseVersion("0.1.7", ["v0.1.10603"])).toBe("0.1.10701");
    expect(nextForkReleaseVersion("0.1.6", ["v0.1.10699"])).toBeUndefined();
  });

  it.each(ascending)("classify %s as Stable for the CLI, desktop, build, and installers", (v) => {
    expect(cliReleaseChannelOf(v)).toBe("stable");
    expect(desktopUpdateChannelOf(v)).toBe("latest");
    expect(resolveDesktopUpdateChannel(v)).toBe("latest");
    expect(isDesktopPreviewVersion(v)).toBe(false);
    expect(crossesReleaseTrack("0.1.5", v)).toBe(false);
    expect(installPs1StablePattern.test(`v${v}`)).toBe(true);
    expect(updaterSemver.prerelease(v)).toBeNull();
    expect(newestCliReleaseVersion([{ tag_name: `v${v}` }], "stable")).toBe(v);
  });

  it("sort upgrades in order for the shared and electron-updater comparisons", () => {
    for (const [index, older] of ascending.entries()) {
      for (const newer of ascending.slice(index + 1)) {
        expect(compareSemverVersions(newer, older), `${newer} > ${older}`).toBeGreaterThan(0);
        expect(updaterSemver.gt(newer, older), `${newer} > ${older}`).toBe(true);
      }
    }
  });

  it("never rank an upstream release on the same minor at or above a fork release", () => {
    const fork = formatForkReleaseVersion("0.1.0", 1) ?? "";
    for (let patch = 0; patch < 10_000; patch += 1) {
      const upstream = `0.1.${patch}`;
      expect(compareSemverVersions(fork, upstream), upstream).toBeGreaterThan(0);
      expect(updaterSemver.gt(fork, upstream), upstream).toBe(true);
    }
  });
});
