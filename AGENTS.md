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
the before and after sizes and wait for his OK. He OK'd Play Billing (2026-11-20, "yes."): the Play
APK went from 2,300,396 to 2,694,603 bytes, 17% bigger.

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
  total cost even if someone fakes many phones. It's stored only as the Worker secret `OPENROUTER_KEY`.
- Play Integrity (Isaac, 2026-11-22, built in 0.9.11): the app is open source, so before this anyone
  could script made-up device IDs from a computer and get free minutes forever. Once per install the
  Play build asks Google Play Integrity (`src/play/.../Integrity.kt`, standard request, request hash =
  the device ID) to vouch for it and sends the token to `POST /v1/register`; the server decodes it
  as the service account and answers a device token, an HMAC of the device ID with the Worker secret
  `DEVICE_TOKEN_SECRET`. The app sends it as `X-Device-Token` on every server call
  (`FreeMinutes.register`, `identify`). Isaac chose the weakest device check: the app must be
  `PLAY_RECOGNIZED` and the phone must have `MEETS_BASIC_INTEGRITY` (turned on in Play Console,
  Protected with Play, Play Integrity API), so GrapheneOS and rooted phones still work. Google
  Cloud project "Word for Word" (number 384040985984) is linked there; quota is 10,000 a day, free.
  Debug builds and sideloaded copies are never vouched for. The server only refuses calls without
  a valid token while `REQUIRE_INTEGRITY` in `server/wrangler.jsonc` is "true"; turn it on only once
  every testing track has 0.9.11 or later, since older builds send no token. 2026-11-22: 0.9.11
  (versionCode 48) is live on internal testing and in Google's review for closed testing (which had
  0.9.9), together with the Data safety change (device IDs also for fraud prevention); enforcement
  is still off. A preview Worker version with it on (`npx wrangler versions upload --var
  REQUIRE_INTEGRITY:true --preview-alias integritytest`) refused made-up IDs from a computer: 426
  without a token, 403 with a made-up one. 2026-11-25: enforcement is on in the live Worker. Six real
  phones passed (PostHog `device_check` ok); the only failing one, a OnePlus 8 Pro (Google error -9),
  was given 30 minutes a month on the Failed checks page, as Isaac had asked on 11-24.
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
  Word"; Play Console gave it "View financial data" on 2026-11-20). That alone wasn't enough:
  Google refused every call with 401 "The current user has insufficient permissions" for 4 days,
  until the account-level "View app information and download bulk reports (read-only)" was added
  on 2026-11-24, and purchase checks worked minutes after a product edit. Its JSON key is only the
  Worker secret `GOOGLE_SERVICE_ACCOUNT`.
- Renewals (2026-11-25): the server used to learn a new expiry only when the app was opened
  (`Billing.sync` posts the purchase), so a subscriber who only used the mic button was refused after
  the first month although Google had charged them. Now a call that finds the stored subscription
  past its expiry asks Google (subscriptionsv2) once, stores the new expiry, Google's state and the
  time (`subscriptions.state`, `.checked`), and serves if it renewed or is in its grace period.
  Account hold, paused and pending are asked again once a day (Play's 24-hour silent grace period,
  the only wait Google's docs give); expired, canceled and unknown tokens wait for the app to post a
  purchase. A canceled subscription now works until its paid month ends (before, it was refused).
  Real-time developer notifications were not used: they need a Pub/Sub topic, a push endpoint that
  checks Google's signed token and a Play Console setting, for the same result. Checked live on
  Isaac's test subscription: Google said EXPIRED (paid until 13:48 UTC), and the server answered
  `subscribed: false` without asking Google a second time. The `monthly` base plan has a 7-day grace
  period and a 53-day account hold (Play Console, checked 2026-11-25), yet Google skipped both for
  that test subscription, probably because test subscriptions end after 6 renewals (not confirmed).
  Hours count per paid month (`subscriptions.period`, the key in `subscription_usage`): the expiry,
  except that in a grace period Google moves the expiry while the renewal is unpaid, so the hours keep
  counting in the month before; 10 fresh hours start only when Google says ACTIVE with a new expiry
  (Isaac, 2026-11-25). The same day fixed: a grace answer kept the phone served for a whole day even
  after Google's new expiry passed; the day now applies only when Google's answer was already past it.
  Refunds and chargebacks (review, 2026-11-25, not deployed yet): Google ends a revoked subscription at
  once (EXPIRED, often with the old expiry still ahead), and the app never sends a revoked purchase
  again, so a subscription that still looks paid is asked about once a day, after the answer has gone
  back (no slower call). EXPIRED, ON_HOLD, PAUSED and PENDING are never served, whatever the expiry,
  per Google's subscription lifecycle page, and neither is one Google stopped knowing (410) while it did
  not pay, stored as GONE with its old expiry. A refunded top-up gives back what is left of its 4 hours,
  never below zero: while a phone has bought hours left, the server asks Google's Voided Purchases API
  once a day, after the answer has gone back (Google lists refunded, canceled and charged-back one-time
  purchases there for 30 days; one answer covers every phone). Needs two new `topups` columns in D1
  before the deploy (`schema.sql`); without them only this check fails, in the Worker log.
- Security and money review of the whole server (2026-11-25, not deployed yet). `server/test/local.test.ts`
  attacks a local run (`test/local-run.ts`: the bundled Worker in Miniflare with a local D1 from `schema.sql`;
  every outside call goes to stand-ins, so no test can reach Google or OpenRouter). Fixed, each failing first:
  time was only checked before a recording and counted after it, so many recordings at once on a phone's, a
  code's or a subscription's last second were all typed; now each holds its length first in one
  conditional statement (`Store.reserve`) and OpenRouter's measured length replaces it afterwards. The length is read from
  the audio itself (`audioLength`: the Opus packets of the app's Ogg, or the app's 44-byte 16 kHz WAV; anything else is
  refused with 400, and the app sends a refused Ogg again as WAV), not guessed from the size: Opus can be far smaller per
  second than the app's 24 kbit/s (libopus at the app's settings, as Android's encoder runs it: speech 13% smaller,
  silence 12.6 times; a hand-made file of 1-byte packets 24 times), so such recordings were held a fraction of their length, five at once passed on a phone's last minute, and
  `MAX_RECORDING_SECONDS` let ten minutes through as 26 s (third review, 2026-11-25). Bought hours a
  recording on their last seconds ran over stay below zero until the next top-up, which counts from zero, so it is
  never a debt (clipping them to zero at each recording gave back hours nobody bought when two overlapped). The phone's
  whole body went to OpenRouter on the server's key (provider routing, paid extras, a download link); now only
  the audio, its format (ogg or wav), language and the app's verbatim switches. A failed write could leave a
  bought top-up counted without its hours; now one transaction. A refund older than Google's 30-day list
  kept its hours; now old top-ups are asked about one by one. Optional, off until Isaac sets them:
  `OPENROUTER_PAID_KEY` (a second key with its own limit for phones that pay, so free or given use reaching
  the main key's limit can't stop subscribers), `MAX_RECORDING_SECONDS`, and the rate limits `DEVICE_LIMITER`
  and `ADDRESS_LIMITER` (commented in `wrangler.jsonc`). Yiddish takes on the last second (same day, with
  yiddish-stt's yiddishtry Worker): see "Yiddish takes" below. Still open: one rooted phone with the real Play
  app can have Play Integrity vouch for any number of made-up device IDs, each with free minutes, since
  basic integrity is enough (Google's optional recent device activity and device recall verdicts are the
  documented answers); anyone can call `/v1/register`, and each call with a token makes one Play Integrity
  decode, whose quota is 10,000 a day for the whole app; device tokens and subscription purchase tokens work
  on any phone that has them, and a code is shared by design.

## Paid plan (agreed with Isaac 2026-11-20, built the same day)

2026-11-21: Isaac set up the payments profile (statement name WORD FOR WORD, support email
micromaxpro7@gmail.com). 0.9.10 (versionCode 47, the first build with billing) is on the internal
testing track; closed testing still has 0.9.9. Both products are Active: subscription `monthly`
(base plan `monthly`, auto-renewing) and one-time `extra_hours_4` (purchase option `buy`). Google's
price rounding made them US$2.99 and US$0.99; Isaac keeps those (2026-11-25: "Drop it!"), so don't
ask about the cent again. The bank account for payouts was added 11-24 and waits
on Google's test deposit (1 to 2 days) before Isaac can verify it; don't remind him. The account is a non-trader and the app isn't offered
in the EEA or UK; keep it that way while it sells anything.

Built: the server above, `Billing.kt` in the Play build (`src/play`; the GitHub builds get the
stand-in in `src/github`), the Settings row "Subscribe" / "Subscribed", and the out-of-minutes
messages (`FreeMinutes.OUT_FREE`, `OUT_HOURS`).
Paid hours count 1:1 on any model up to $0.15 an hour and faster above it (free minutes: $0.10):
"i think i can afford up to 15 cents per hour still gives 10 hours a month".

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

## Hours given without a subscription (Isaac, 2026-11-24, 0.9.15, links since 0.9.16)

"Make me a way to give access, for people, without subscribing ... I should be able to choose how many
monthly hours I give them ... 50 hours or unlimited, whatever number I want." Isaac adds a person by
name on his own web page (Admin, Access; it writes this server's D1 tables `grants` and `grant_usage`),
with hours a month or unlimited (empty box), sees each person's use this month, and copies their link.
Each person gets a 12-character access code (`server/src/index.ts`, `accessCode`). Every call with header
`X-Access-Code` uses those hours first, before free minutes and the subscription, on the paid models at
the paid rate ($0.15 an hour per plan second), shared by every phone with the code, reset each UTC month.
A valid code stands in for the Play Integrity device token. Used up: 402 `given_hours_used`. Removing a
person stops the code at the next call, and the app forgets it (`/v1/usage` answers `access: null`).

- The link is `https://nuchemweber.com/wordforword/a/?c=<code>` (on the app's own site, so it names
  nothing else). It's an Android App Link (MainActivity's intent filter, `autoVerify`); the server Worker
  answers `nuchemweber.com/.well-known/assetlinks.json` (route in `server/wrangler.jsonc`) with the Play
  signing key and the debug key the GitHub builds use. Without the app, `docs/a/index.html` says to install
  it and tap again, with an "Open in Word for Word" button (`wordforword://a/<code>`). The app checks the
  code with `GET /v1/usage` and says "Done. Your hours are ready to use."
- The Play build shows no row for it; the GitHub builds also have Settings, "Access code", to type it.
- 0.9.15 (GitHub only) had "Sign in with Google" in the Play build instead. Isaac, 2026-11-24: "I don't
  want to add Google Sign in just so I could give for three friends access... People will wonder what is
  the Google Sign in for." It also made the Play APK 7.1% bigger. 0.9.16 removed it and its endpoint. The
  Google Cloud project "Word for Word" still has the Google Auth Platform set up from that (published, web
  client "Word for Word server", three Android clients); nothing uses them.
- Play policy: free hours are not a sale, so Play Billing doesn't apply (Payments policy: apps "requiring
  or accepting payment for access to in-app features or services" must use Play billing).
- Shipped 2026-11-24: server Worker fd7d8f65 (assetlinks route), docs site a992248c, the Access page in
  yiddishvoicetotext site 15762b4a (one Admin tab with Models and Access under it), app 6ba7930 as 0.9.16
  (versionCode 53) on GitHub, Play internal testing, and in Google's review for closed testing. Play APK
  2,718,858 bytes (0.9.14: 2,717,040). Checked on the emulator: `nuchemweber.com: verified`, and opening a
  link showed "Done. Your hours are ready to use." with Settings showing the code in use.

## Phones that fail the check (Isaac, 2026-11-24, 0.9.17)

"add a page where i can see phone's that fail the check and i can click a button to give them 30 minutes a
month (or another amount if i want)". When Play Integrity gives the Play build no token, the app posts
`/v1/register` without one, with Google's error code (`integrity_error`, StandardIntegrityErrorCode such as -12,
or "timeout"), the phone model, Android version and app version. When the server refuses a token, it records
why itself. Both land in D1 `failed_checks` (one row per device ID, first and last seen, count); a phone that
passes later leaves it unless it has hours. The app asks Google at most once per app start (one OnePlus 8 Pro
had asked 254 times), and PostHog `device_check` carries `google_error`.

- yiddishvoicetotext.com, Admin, Failed checks lists them with what Google said in plain words; Give (0.5 hours
  a month unless changed, empty for unlimited) adds a `grants` row with `device` set and a random code that's
  never shown. The phone uses it with no link, counted like other given hours (Yiddish twice).
- Without a valid device token (once REQUIRE_INTEGRITY is on), given hours, a code's or the phone's own, still
  work, but only they do: used up means 402 `given_hours_used`, never the free minutes. This also closed a hole
  where a used-up code fell through to free minutes without the check.
- `-PserviceUrl=...` builds the Play flavor against another server (a preview made with `npx wrangler versions
  upload --var REQUIRE_INTEGRITY:true --preview-alias strictcheck` in server/, which shares the live D1).
  Releases never set it.
- The daily task that turns the block on (T3 Code "Turn on Play Integrity enforcement when ready") reads this
  table too, and a failing phone Isaac gave hours to no longer holds the block back.
- Shipped 2026-11-24: server Worker 255d034f (D1 got `failed_checks` and `grants.device` by hand, see
  schema.sql), yiddishvoicetotext site ee9a6441 (commit 1d3c65f), app d43e5b3 as 0.9.17 (versionCode 54) on
  GitHub, Play internal testing, and in Google's review for closed testing. Play APK 2,719,223 bytes (0.9.16:
  2,718,858). Checked on the emulator against preview `strictcheck` (REQUIRE_INTEGRITY true): Play Integrity
  gave -9, the phone showed on the page, Give, then a shared 6 s recording was typed and counted on the given
  hours, not the free minutes. The test rows were deleted afterwards.

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

Since 0.9.14 (Isaac, 2026-11-24: "it's a good thing that I can use Yiddish, but I don't want
everyone to be able to do that") the server decides, not the app. Before, any OpenRouter key typed
in the app, even a made-up one, skipped the minutes check, and the PC checked nothing. Now every
Yiddish take sends `X-Device-Id` and `X-Device-Token`, and the `yiddishtry` Worker asks this repo's
server (RPC entrypoint `Yiddish` in `server/src/worker.ts`, service binding `WFW`) while the audio
is still arriving: the phone needs a device token from Play Integrity, whatever
`REQUIRE_INTEGRITY` says, and time left in its free minutes or hours, whatever key is typed. A take
that comes back with words is counted there (`yiddishCheck`, `yiddishCharge`).
Holds (review, 2026-11-25, not deployed yet): checked once before and counted after, every take started on a
phone's last second was typed, on the paid cloud copy when the PC was busy (test/yiddish-e2e.test.ts, the real
yiddishtry Worker and this server in Miniflare: 4 of 4 takes at once on one second left were typed). Now the
yiddishtry Worker gives each take an id and its length from its size, and `yiddishCheck` holds that length in whole
seconds plus one, twice over, all of it on the first hours with that much left, in one statement (table
`yiddish_takes`); a take that doesn't fit is refused (402, the same codes as before) before it is sent. The Worker
sends the length held as `x-max-seconds`, so the model server refuses a longer take before typing it, and
`yiddishCharge` counts what the model server measured (its answer's `seconds`) in place of the hold, once.
`release` gives back the hold of a take that wasn't typed, `refund` what a shared file's job was counted when the job
fails later, each once. A yiddishtry Worker from before this only checks and counts after, as before, and without the
`yiddish_takes` table this server does the same, so either side can go out first; the hole closes once both are out.
Release: the table, then `server/`, then yiddish-stt's `tryout/worker`. The cloud copy refuses a take longer than its
hold only once yiddishvoicetotext's PR 1 cloud copy is deployed (`modal deploy backup/modal_app.py`), the PC once
yiddish-stt PR 2 is merged and the PC's server restarted; until then a take whose size understates its length is
typed whole and counted all of it. Installed apps need nothing new: the last take of the month that doesn't fit what
is left is refused with the out-of-time message, where before it was typed. No phone is exempt
(Isaac, same day: "I don't want mine to be different than everyone's"). GitHub builds never get a
device token, so they don't offer Yiddish takes (`YiddishServer.available`); Yiddish is a normal
language for the cloud model there. Apps before 0.9.14 send no device ID and get 503, which they
treat as the PC being off. Deploy both: `server/` first, then `tryout/worker` in yiddish-stt.
Shipped 2026-11-24: word-for-word Worker version 2d7af896, yiddishtry 8e567285 (yiddish-stt
141728a), 0.9.14 (versionCode 51) on GitHub, Play internal testing, and in Google's review for
closed testing. Checked live: no device ID 503, a made-up device ID with no token or a made-up
token 403 `device_unverified`, on both `/api/transcribe` and `/api/job`.

## Recordings kept in History (Isaac, 2026-11-24, built in 0.9.13)

"If a transcription fails for any reason whatsoever ... you should still see the actual audio file
and you should be able to save or share it ... Also add a switch to always save the audio." A
recording that couldn't be typed (no key, no connection, out of minutes, server error, Yiddish PC
failure) goes to History with its audio (`HistoryStore.addWithAudio`, Ogg Opus in
`filesDir/audio`, WAV below Android 10), marked "Not typed" with the reason, and Play, Save and
Share under it. Not kept: recordings too short to send, and ones the model answered with no words
("only if it's a legit recording"). A later try that types it fills in the same entry. History's
"Always save audio" switch (pref `always_save_audio`) keeps the audio of typed recordings too.
Audio is deleted with its entry, after 24 hours unless "Keep history forever" is on.

## Subscribe sheet when time runs out (Isaac, 2026-11-25, 0.9.18)

Isaac, about the "You've used this month's free minutes. Subscribe in Word for Word..." message shown over
the app he was in: "It doesn't push me hard enough and make it easy enough to subscribe. That pop-up should
probably be a subscribe button." Now in the Play build, when a recording is refused for no time left
(`FreeMinutes.OUT_FREE`, `OUT_HOURS`), a small sheet opens over the current app (`SubscribeSheet.kt`):
one line saying what ran out, one button ("Subscribe, 10 hours a month for $3", or "Add 4 hours for $1"
when subscribed) that opens Google Play's purchase screen right there, and "Not now". After a purchase it
says "Ready. Press the mic to keep going." The kept recording stays on the retry button, so that press
types it.

- From dictation the service starts `SubscribeActivity` (see-through, its own task so the app's main
  screen doesn't come up behind it, and the activity Play Billing needs to show its screen). Android
  allows that only while one of the service's windows is on screen; the emulator log showed it allowed
  as `BAL_ALLOW_NON_APP_VISIBLE_WINDOW` (the floating button). If the sheet hasn't opened 1.5 s later
  (button hidden, such as a Yiddish shortcut press with the keyboard shortcut on), the old message shows.
- A shared file (`ShareActivity`) shows the same sheet and carries on with the file after a purchase.
- Unchanged: the GitHub builds (they sell nothing, so they keep the plain message) and hours given on
  the Access page (`OUT_GIVEN`, nothing to buy).
- The emulators on this PC have no Play Store (all `google_apis` images), so tests here reach the sheet and
  the button's "Google Play isn't available" answer, not Google's purchase screen. The button calls the same
  `Billing.subscribe` / `buyHours` as the Settings Subscribe row. To test the sheet without using up real
  minutes, build with `-PserviceUrl=http://localhost:8787` against a local server that answers 402
  `free_minutes_used`, with `adb reverse tcp:8787 tcp:8787` (debug builds allow plain HTTP to localhost).
