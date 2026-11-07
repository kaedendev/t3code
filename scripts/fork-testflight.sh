#!/usr/bin/env bash
# Build the fork's iOS app from a checkout and upload it to TestFlight. See FORK.md.
# Usage: scripts/fork-testflight.sh [checkout-dir]   (default: current directory)
# Signing uses the Apple account signed into Xcode. The values below are public; Clerk and relay
# match fork-release.yml. They are set here, not in .env.local, so dev builds keep their own bundle ID.
set -euo pipefail

CHECKOUT="${1:-$PWD}"
MOBILE="$CHECKOUT/apps/mobile"
BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/t3-testflight.XXXXXX")"
LOG="$WORK/build.log"
export T3CODE_IOS_TEAM_ID="${T3CODE_IOS_TEAM_ID:-28AUT7GBK3}"
export T3CODE_IOS_BUNDLE_ID="${T3CODE_IOS_BUNDLE_ID:-com.kaedenmurphy.t3code}"
export T3CODE_CLERK_PUBLISHABLE_KEY="${T3CODE_CLERK_PUBLISHABLE_KEY:-pk_live_Y2xlcmsudDMuY29kZXMk}"
export T3CODE_CLERK_JWT_TEMPLATE="${T3CODE_CLERK_JWT_TEMPLATE:-t3-relay}"
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID="${T3CODE_CLERK_CLI_OAUTH_CLIENT_ID:-hzxSgY2cH10sDU2r}"
export T3CODE_RELAY_URL="${T3CODE_RELAY_URL:-https://relay.t3.codes}"
TEAM_ID="$T3CODE_IOS_TEAM_ID"

export PATH="$HOME/.vite-plus/bin:/nix/var/nix/profiles/default/bin:$PATH"
export APP_VARIANT=production EXPO_NO_GIT_STATUS=1

[ -d "$MOBILE" ] || { echo "No apps/mobile in $CHECKOUT" >&2; exit 1; }
echo "Build $BUILD_NUMBER, log: $LOG"
cd "$MOBILE"

echo "1/3 prebuild + pods"
nix shell nixpkgs#cocoapods -c npx expo prebuild --clean --platform ios >>"$LOG" 2>&1
# Prebuild writes a literal CFBundleVersion 1; TestFlight needs a new one per upload.
for plist in ios/T3Code/Info.plist ios/ExpoWidgetsTarget/Info.plist; do
  [ -f "$plist" ] && /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$plist"
done

echo "2/3 archive"
xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code -configuration Release \
  -destination generic/platform=iOS -derivedDataPath ios/build \
  -archivePath "$WORK/T3Code.xcarchive" -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" DEVELOPMENT_TEAM="$TEAM_ID" archive >>"$LOG" 2>&1 \
  || { grep -E "error:" "$LOG" | sort -u | tail -10; exit 1; }

cat >"$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
EOF

echo "3/3 upload to TestFlight"
xcodebuild -exportArchive -archivePath "$WORK/T3Code.xcarchive" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" \
  -allowProvisioningUpdates >>"$LOG" 2>&1 \
  || { grep -E "error:" "$LOG" | sort -u | tail -10; exit 1; }

echo "Uploaded build $BUILD_NUMBER. Apple processing takes ~5-30 min, then it shows in TestFlight."
