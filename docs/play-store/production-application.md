# Production access application, draft answers

Drafted 2026-11-25 for the form Play Console opens once 12 testers have been opted in for 14 days
(earliest about December 7). Questions are from Google's help page "App testing requirements for new
personal developer accounts" (answer 14151465). Only answers we know are filled in; the rest are
Isaac's. Refresh the numbers from PostHog on the day of applying.

## Part 1: About your closed test

**How easy was it to recruit testers?** Isaac's answer.

**Tester engagement (did testers use all features; did usage match expected production use?)**

Testers installed the app from the closed test and used it as they would in daily life: they turned on
the floating microphone button and dictated into the text boxes of other apps (messaging, email, notes,
search). In the 7 days to November 24, 52 phones opened the app and 18 dictated, for 835 dictations in
total (anonymous usage counts, which testers can turn off). Features used: dictation into other apps,
transcription history, the monthly free minutes, and the subscription purchase (tested with license
testers). One difference from expected production use: about a third of the phones that opened the app
dictated that week, so most use came from a smaller group of regular users.
<!-- Before applying: re-run the PostHog counts and check which other features (share a file, language
and model choice, extra hours) testers used; only list what the data shows. -->



**Summary of feedback and how it was collected.** Isaac's answer. No feedback was sent through Google
Play's private testing feedback (checked 2026-11-25); say how testers told him (in person, messages,
email) and what they said.

## Part 2: About your app

**Target audience.** Adults who type a lot on their phone and would rather speak: people writing
messages, emails and notes on the go, people who find typing on a small screen slow or hard, and people
who dictate in more than one language. Not aimed at children.

**Value to users.** Word for Word lets people dictate into any text box without changing their
keyboard. They tap a floating microphone button, speak, and tap again; the words appear at the cursor in
the app they are already using. They keep their own keyboard, can pick the language and the speech
model, and can keep or drop filler words. Every phone gets free minutes each month; heavier users can
subscribe for more hours or use their own API key. Recordings that could not be transcribed are kept in
History so nothing said is lost. The app is open source.

**Estimated installs in the first year.** Isaac's answer.

## Part 3: About your production readiness

**Changes made based on the closed test.**

- Faster results: recordings are now compressed while recording (12 times smaller uploads) and the
  connection opens early, so text appears sooner after the stop.
- The microphone button remembers where each user put it in each app.
- Recordings that could not be transcribed (for example with no internet) stay in History with play,
  save and share, so nothing is lost.
- Purchases: if the payment can't be confirmed right away, the app says so and retries each time it
  opens, instead of failing silently.
- Shorter error messages that close with the keyboard.
- The free minutes are protected against misuse with Google Play Integrity, and phones that fail the
  check are told why.

**How we decided the app is ready.** It ran with 12 or more opted-in testers for 14 days on real
phones. Every release passes an automated test that times how long text takes to appear after the
stop, and fails if it got slower. The subscription was tested end to end with a license tester,
including confirmation by our server. The problems found during testing were fixed in the releases
listed above.
