# Word for Word: notes for coding agents

## Two builds, always released together

Every build has the keyboard shortcut and runs on Android 6+ (Isaac, 2026-11-06: dropped 5.1 so the
PostHog analytics library, which needs Android 6, could be used). Earlier that day he chose this
over separate keypad and Android 11+ editions: the shortcut alone doesn't trigger Play Protect,
and about 1 MB more storage after installing is fine. The builds (flavors in
`app/build.gradle.kts`) differ only in how updates install:

- `browser` (`WordForWord.apk`): Update opens the new APK in the browser (`src/browser/`).
- `selfInstall` (`WordForWordSelfUpdate.apk`): the app downloads and installs its own updates
  (`src/selfInstall/`). Play Protect blocks it as harmful; "Install anyway" works.

Every change goes into both builds, and every release ships both.

## App size

Isaac (2026-11-06): "Anything you do that makes the app bigger in size, you have to consult me
first." Then: "Up to 5% bigger, you don't have to ask me." So measure every change that grows the
APK or its installed size. Up to 5% bigger, go ahead and mention the sizes. More than 5%, tell him
the before and after sizes and wait for his OK.

## Releasing

1. Bump `versionCode` and `versionName` in `app/build.gradle.kts`, commit and push.
2. Write release notes to a file, then run `./scripts/release.sh <notes-file>`. It runs the unit
   tests, builds and signs both builds, and creates the GitHub release with both APKs.
   Older releases stay up.
3. Send the APKs to Isaac's phone with `blip-send` only when he asks (Isaac, 2026-11-06).

Each build's updater looks only for its own APK name in the latest release.

Isaac (2026-11-20): "can you make a test, some better if it's like automatic test that would block
any regressions in this speed?" `release.sh` also runs `AfterStopSpeedTest` (`app/src/androidTest`)
with `connectedPlayDebugAndroidTest` on an emulator, and stops the release if it fails. It feeds a
15 s speech clip at real-time pace the way the recorder does, then checks that compressing after
the stop, and the whole phone-side path from the stop to the upload starting, each take under
50 ms (Isaac's limit), and that the upload is valid Ogg Opus. It uses a running emulator, or boots `WFW_AVD` (default
`FlashDim_Pixel_10_Pro_XL_API_37`) hidden after the builds and shuts down only that one.

## Play Protect and the in-app installer

Isaac (2026-11-06): 0.6.7 to 0.7.0 asked for `REQUEST_INSTALL_PACKAGES` so the app could install
its own updates, and Google Play Protect blocked every one of them as a "Harmful app". 0.6.6 and a
0.7.0 test build without that permission installed cleanly on his phone. An accessibility app that
can install other apps, signed with the public debug key, looks like malware. Isaac still wants
the in-app installer, so it lives only in the `selfInstall` build; `WordForWord.apk` is the one
without the warning. A keypad build without the installer also installed cleanly, so watching
key presses alone doesn't trigger it.

## Google Play build

A third flavor, `play`, is for the Play Store only and isn't released on GitHub (Isaac,
2026-11-06). It has no update check and no Update row
(`BuildConfig.UPDATES` is false), because Play policy bans apps that update themselves outside
Play. Build it with `./scripts/play-bundle.sh`, which writes `WordForWordPlay.aab`, signed with
the private upload key. The key is `~/.android/wordforword-upload.jks`; its password is in
`keystore.properties` in the repo root, which is never committed. Only the Play build uses that
key; the GitHub builds keep the debug key. Every change still goes into all three builds.

Isaac (2026-11-19): Google reviews every Play update, so don't upload one for every small change.
Collect changes and upload to Play at most once every day or two. GitHub releases still ship with
each change. Upload a new `versionCode` in Play Console (Test and release, the track's Create new
release), then send the change for review.

Isaac (2026-11-19), after Play notes said Yiddish works "when the developer's PC is busy or off":
"There was no need in mentioning the developer's PC. Nobody needs to know that it goes to my PC."
Release notes and store text describe what users get, not where the servers run. Only the privacy
policy and the Yiddish consent screen say where recordings go. Same day: "Yiddish typing doesn't
have to be mentioned. It's halfway a hidden feature." Leave Yiddish out of Play release notes.

## What only the Play build shows (Isaac, 2026-11-11)

Isaac: add consent dialogs, settings rows and policy links "only if it's really needed and if
yes only to the Play Store version". Checked against Google's User Data and AccessibilityService
policy pages that day, the Play build (`BuildConfig.FLAVOR == "play"`) has three things the
GitHub builds don't:

- A "Privacy policy" row in Settings. Play requires the policy inside the app.
- A "Yiddish training" dialog with Agree / No thanks before the first Yiddish take or shared
  Yiddish file (`YiddishServer.needsConsent`). Play requires a disclosure and an Agree tap before
  data is kept in a way people don't expect; recordings kept for training qualify.
- An Accessibility disclosure that says what the service reads (only the focused text box) and that
  it never saves or shares it.

Left out on purpose because the policy doesn't require them: a consent dialog for normal cloud
dictation, and a settings row to turn Yiddish training off or copy an ID. Don't add them to any
build unless Google rejects the app for it. An earlier draft with them is in
`.dev/pending-consent-0.8.5.patch` (not committed).

## Free minutes server (Play build only)

Isaac (2026-11-06): the Play build gives 30 free minutes a month per phone, so people can dictate
without their own OpenRouter key. With no key entered, the app sends audio to a Cloudflare Worker
(`server/`, deployed as `word-for-word` at https://word-for-word.ynbsd6242.workers.dev), which
holds an OpenRouter key, counts each phone's seconds in the D1 database `word-for-word`, and
answers like OpenRouter. GitHub builds have no server URL and always need the person's own key.

- The OpenRouter key "Word for Word server" has a $10 monthly limit (Isaac's choice) that caps
  total cost, since a faked device ID could get extra free minutes until Play purchases and
  Play Integrity checks are added. It's stored only as the Worker secret `OPENROUTER_KEY`.
- Free minutes per month: `FREE_SECONDS_PER_MONTH` in `server/wrangler.jsonc`.
- Since 0.9.7 (Isaac, 2026-11-19: "It should be as fast as possible") cloud recordings upload as
  Ogg Opus, about 12 times smaller than WAV (`OggOpus.kt`, Android 10+). The app writes the Ogg
  pages itself (`OggWriter.kt`) because MAI-Transcribe 2 rejects Android's own Ogg muxer output
  as malformed. The server counts seconds from OpenRouter's `usage.seconds`. Yiddish takes to the
  PC stay WAV.
- Since 0.9.9 dictation compresses while recording (`OggOpus.Stream`) and opens the upload
  connection when recording starts (`CloudTranscription.warm`). In 0.9.7 and 0.9.8, compressing
  after the stop took about 7 s for a 12.5 s recording on Isaac's Pixel. Isaac's target for the
  after-stop compression was under 100 ms, then under 50 ms (2026-11-20, now a release test, see
  Releasing); 0.9.9 measured 24 ms for 13.6 s on the emulator.
  Agent-device snapshots switch the app's accessibility service off on the emulator, because
  its UI automation helper suppresses other services. Tap with `adb shell input tap` while
  testing the mic button.
- Deploy: `cd server && npm test && npx wrangler deploy`.
- The server picks the model (2026-11-20): the main model and up to two backups, separately for
  free and paying phones, from its D1 table `models`. Isaac sets them on yiddishvoicetotext.com,
  Models tab (that site's `site/src/models.js` writes this database). The app's model in the body
  is ignored; the answer's `X-Model` header names the model that typed it.
- Everything is counted in plan seconds: a second of audio on a $0.10-an-hour model. The server
  takes OpenRouter's `usage.cost` per recording and divides by $0.10 an hour, so a pricier model
  uses the minutes and hours up faster and no model choice loses money.
- `POST /v1/purchases` checks a Play purchase with the Android Publisher API as the service account
  `play-purchases@word-for-word-515315.iam.gserviceaccount.com` (Google Cloud project "Word for
  Word"; Play Console gave it "View financial data" on 2026-11-20). Its JSON key is only the
  Worker secret `GOOGLE_SERVICE_ACCOUNT`.

## Paid plan (agreed with Isaac 2026-11-20, built the same day, not on sale yet)

Built: the server above, `Billing.kt` in the Play build (`src/play`; the GitHub builds get the
stand-in in `src/github`), the Settings row "Subscribe" / "Subscribed", and the out-of-minutes
messages (`FreeMinutes.OUT_FREE`, `OUT_HOURS`). Not on sale until Play Console has a payments
profile (Monetize needs a Google Payments merchant account, which needs Isaac's business and bank
details) and the products exist: subscription `monthly` ($3, base plan monthly) and one-time
product `extra_hours_4` ($1).

- One subscription: $3 a month for 10 hours of transcription a month. No yearly plan.
- Extra hours: $1 for 4 hours. They never expire, but work only while the $3 subscription is
  active.
- A model that costs more than the default uses up the hours faster, in proportion to its price.
  The app doesn't show hours left: "it shouldn't really be shown it's going to be confusing."
- When the free minutes run out, the app offers the subscription first; your own OpenRouter key
  stays an option, not the main suggestion.
- A yearly plan comes later: "i do want to add it in the future, maybe in 3 months from now."
- Isaac picks the models himself (main and backups, free and paid) on a model page; agents don't
  pick or benchmark them for him: "just leave the model picking for me."

## Testing the keyboard shortcut on an emulator

`adb shell input keyevent` and `input keycombination` never reach accessibility services, so
they can't trigger the shortcut. Send real hardware key events with `sendevent` to the
emulator's keyboard device (`getevent -p` lists it; needs an AVD with `hw.keyboard=yes`).
Also, a UI-automation snapshot tool (such as agent-device `snapshot`) pauses accessibility
services while connected; close its session before testing.

## Sharing an audio file (Isaac, 2026-11-11)

Any app can share an audio file to Word for Word (`ShareActivity.kt`, an `audio/*` share target).
Since Isaac's 2026-11-17 ask it also takes `video/*`: only the video's sound track is decoded. The
file is read in place and copied into the cache only when it can't be read that way.
A shared Yiddish file goes to the PC as a job (`/api/job`, then `/api/job/status` every 3 s,
`YiddishServer.transcribeJob`), because Cloudflare drops a request with no answer for 125 s and a
62-second video once took the PC 150 s (Isaac, 2026-11-17).
`AudioDecoder.kt` turns it into 16 kHz mono, it goes through the same cloud path as dictation
(`CloudTranscription.kt`), and the text is copied to the clipboard and saved to History. With
Yiddish picked it first asks "Is this recording in Yiddish?"; Yiddish sends it to the PC model
with `x-client: app-share` (the voice is often someone else's) and outcome `not_tracked`. The
file is decoded into a cache file and sent in pieces of about 5 minutes, cut at a quiet moment
(`AudioSplitter`), because OpenRouter rejects a request over 25 MB (about 13 minutes of WAV).
A Yiddish file is one take on the PC per piece.

## Yiddish takes (Isaac, 2026-11-08)

With Yiddish picked as the language, one recording at a time can go to the Yiddish model running
on Isaac's PC (ivrit.ai yi-whisper-large-v3, served by the `yiddishtry` Cloudflare Worker from the
yiddish-stt repo's `tryout/`): hold the idle mic button (Android's long-press time), or press the
second "Yiddish shortcut keys" shortcut, which shows only with the shortcut on and Yiddish picked.
A quick tap or the normal shortcut sends the take to the normal cloud model with Auto language,
not marked Yiddish. With any other language nothing changes. Code: `YiddishServer.kt`. The PC must
be on; when it's off the Worker answers 503 and the take is kept for a retry.

Since 0.8.2 (Isaac, 2026-11-08): when the PC is off (Worker 503, or the Worker can't be reached),
a Yiddish take falls back to the normal model with Auto language and says so. Every Yiddish take is
kept on the PC for training (D:/yiddish-stt/takes). Since 0.9.3 (Isaac, 2026-11-17: "remove that
part") the app no longer follows edits to a typed take or sends corrected words back; the
service doesn't receive text-changed events at all. Debug builds:
`am broadcast -a com.isaacweber.wordforword.DEBUG_DICTATE --es text "..."` types text without audio. Never stop the PC model server to test (Isaac, 2026-11-08).
