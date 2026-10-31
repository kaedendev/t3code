import { describe, expect, it } from "vite-plus/test";

import { compareExactServiceVersions, isExactServiceVersion } from "./serviceProtocol.ts";

// Fork versions from scripts/fork-release-version.ts, oldest to newest after the upstream 0.1.5 and
// 0.1.6 the fleet runs today. The service launcher only moves to a newer exact version.
const ascending = ["0.1.5", "0.1.6", "0.1.10601", "0.1.10602", "0.1.10701", "0.2.10001"];

describe("fork release versions in the service launcher", () => {
  it.each(ascending)("accepts %s as an exact service version", (version) => {
    expect(isExactServiceVersion(version)).toBe(true);
  });

  it("orders every upgrade as newer", () => {
    for (const [index, older] of ascending.entries()) {
      for (const newer of ascending.slice(index + 1)) {
        expect(compareExactServiceVersions(newer, older), `${newer} > ${older}`).toBe(1);
        expect(compareExactServiceVersions(older, newer), `${older} < ${newer}`).toBe(-1);
      }
    }
  });

  it("ranks an upstream release on the same minor below a fork release", () => {
    for (const upstream of ["0.1.0", "0.1.7", "0.1.45", "0.1.9999"]) {
      expect(compareExactServiceVersions("0.1.10001", upstream), upstream).toBe(1);
    }
  });
});
