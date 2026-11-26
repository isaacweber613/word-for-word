#!/usr/bin/env bash
# Builds, signs and publishes both builds as one GitHub release.
#   ./scripts/release.sh <notes-file>
# Bump versionCode and versionName in app/build.gradle.kts and commit first.
# Assets: WordForWord.apk (updates open in the browser, no Play Protect block) and
# WordForWordSelfUpdate.apk (installs its own updates; Play Protect blocks it as harmful).
# Each build's updater downloads only its own file, so keep these names.
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES=${1:?usage: release.sh <notes-file>}

export JAVA_HOME="${JAVA_HOME:-$PWD/.dev/jdk-17.0.20.1+1}"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT=$(ls -d "$SDK/build-tools/"* | tail -1)
# Releases so far are signed with the debug key; a different key can't install over them.
KS="$HOME/.android/debug.keystore"

# The after-stop speed test (app/src/androidTest, AfterStopSpeedTest) runs on an emulator and blocks
# the release if text would come back slower after the stop. Uses a running emulator, or boots one
# hidden (WFW_AVD) after the builds and shuts down only that one. Booting it during the builds ran
# this PC out of memory twice on 2026-11-20.
./gradlew testBrowserDebugUnitTest testSelfInstallDebugUnitTest \
  assembleBrowserRelease assembleSelfInstallRelease -q

ADB="$SDK/platform-tools/adb.exe"; [ -e "$ADB" ] || ADB="$SDK/platform-tools/adb"
# Only this app's own emulator: other projects run theirs on this PC too (2026-11-25).
AVD="${WFW_AVD:-FlashDim_Pixel_10_Pro_XL_API_37}"
SERIAL=""
for s in $("$ADB" devices | awk '/^emulator-/ && $2 == "device" { print $1 }'); do
  [ "$("$ADB" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" = "$AVD" ] && { SERIAL=$s; break; }
done
STARTED=""
if [ -z "$SERIAL" ]; then
  SERIAL=emulator-5584
  "$SDK/emulator/emulator" -avd "$AVD" -port 5584 \
    -no-window -no-boot-anim -no-snapshot-save >/dev/null 2>&1 &
  STARTED=$!
  trap '"$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true' EXIT
fi

until [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
  if [ -n "$STARTED" ] && ! kill -0 "$STARTED" 2>/dev/null; then echo "The emulator didn't start" >&2; exit 1; fi
  sleep 2
done
ANDROID_SERIAL=$SERIAL ./gradlew connectedPlayDebugAndroidTest -q
"$ADB" -s "$SERIAL" logcat -d -s AfterStopSpeed:I | grep -v "Body fully" | tail -3
if [ -n "$STARTED" ]; then "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true; trap - EXIT; fi

sign() { # <variant folder> <output>
  local tmp; tmp=$(mktemp)
  "$BT/zipalign" -f -p 4 app/build/outputs/apk/$1/release/app-*-release-unsigned.apk "$tmp"
  "$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out "$2" "$tmp" 2>/dev/null     || "$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out "$2" "$tmp"
  rm -f "$tmp" "$2.idsig"
}
sign browser WordForWord.apk
sign selfInstall WordForWordSelfUpdate.apk

VERSION=$(grep -o 'versionName = "[^"]*"' app/build.gradle.kts | cut -d'"' -f2)
gh release create "v$VERSION" WordForWord.apk WordForWordSelfUpdate.apk \
  -R isaacweber613/word-for-word --title "Word for Word $VERSION" --notes-file "$NOTES" --target main
