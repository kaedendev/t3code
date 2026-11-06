const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# t3code: Parakeet's module map without an umbrella header";
// React Native builds every static pod with a Swift package into the shared products dir.
// ClerkExpo already has an umbrella header there, and clang rejects a second one in the same
// directory. T3ParakeetNative is Swift-only, so a plain header declares the same module.
const MODULE_MAP_FIX = `${MARKER}
    parakeet_module_map = File.join(installer.sandbox.root, "Target Support Files", "T3ParakeetNative", "T3ParakeetNative.modulemap")
    if File.exist?(parakeet_module_map)
      File.write(
        parakeet_module_map,
        File.read(parakeet_module_map)
          .sub('umbrella header "T3ParakeetNative-umbrella.h"', 'header "T3ParakeetNative-umbrella.h"')
          .sub(/^\\s*module \\* \\{ export \\* \\}\\n/, ""),
      )
    end
`;

module.exports = function withIosParakeetModuleMap(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");
      if (podfile.includes(MARKER)) return nextConfig;

      const postInstallStart = "post_install do |installer|\n";
      if (!podfile.includes(postInstallStart)) {
        throw new Error("Unable to fix Parakeet's module map: post_install is missing.");
      }
      fs.writeFileSync(
        podfilePath,
        podfile.replace(postInstallStart, `${postInstallStart}${MODULE_MAP_FIX}`),
        "utf8",
      );
      return nextConfig;
    },
  ]);
};
