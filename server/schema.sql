-- Plan seconds each phone used of its free minutes per month (month is "2026-11", UTC).
-- A plan second is a second of audio on a $0.10-an-hour model (see src/index.ts).
CREATE TABLE IF NOT EXISTS usage (
  device TEXT NOT NULL,
  month TEXT NOT NULL,
  seconds REAL NOT NULL,
  PRIMARY KEY (device, month)
);

-- The models Isaac picked on his model page (yiddishvoicetotext.com, Models). tier is "free" or
-- "paid"; models is a JSON list, main model first: [{"id": "...", "per_hour": 0.1}, ...].
CREATE TABLE IF NOT EXISTS models (
  tier TEXT PRIMARY KEY,
  models TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Google Play subscriptions, checked with Google. expiry is the end of the paid month (ms).
CREATE TABLE IF NOT EXISTS subscriptions (
  token TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  -- What Google said the last time the server asked (ACTIVE, IN_GRACE_PERIOD, ON_HOLD, CANCELED, EXPIRED,
  -- GONE for a token Google no longer knows) and when (ms). Added 2026-11-25:
  -- ALTER TABLE subscriptions ADD COLUMN state TEXT; ALTER TABLE subscriptions ADD COLUMN checked INTEGER.
  state TEXT,
  checked INTEGER,
  -- The paid month its hours count in (subscription_usage.period): the expiry, except that a grace period
  -- keeps the month before, since Google moves the expiry while the renewal is unpaid. NULL means expiry.
  -- Added 2026-11-25: ALTER TABLE subscriptions ADD COLUMN period INTEGER.
  period INTEGER
);

-- Which phones a subscription is on (the same Google account on more than one phone shares it).
CREATE TABLE IF NOT EXISTS subscription_devices (
  device TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (device, token)
);

-- Plan seconds used per subscription per paid month (period is that month's expiry).
CREATE TABLE IF NOT EXISTS subscription_usage (
  token TEXT NOT NULL,
  period INTEGER NOT NULL,
  seconds REAL NOT NULL,
  PRIMARY KEY (token, period)
);

-- Bought hours left per phone, in plan seconds. They never expire.
CREATE TABLE IF NOT EXISTS credit (
  device TEXT PRIMARY KEY,
  seconds REAL NOT NULL
);

-- Each top-up purchase, so one is never counted twice.
CREATE TABLE IF NOT EXISTS topups (
  token TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  seconds REAL NOT NULL,
  created_at INTEGER NOT NULL,
  -- When Google was last asked whether it was refunded (ms; NULL: not since it was counted), and when it was
  -- found refunded and what was left of its hours taken back (ms; NULL: not refunded). Added 2026-11-25:
  -- ALTER TABLE topups ADD COLUMN checked INTEGER; ALTER TABLE topups ADD COLUMN voided INTEGER.
  checked INTEGER,
  voided INTEGER
);

-- People Isaac gives hours to without a subscription (yiddishvoicetotext.com, Access tab; that site's
-- src/access.js writes this table). who is the name Isaac typed; the person gets a link with the code.
-- seconds is plan seconds a month;
-- NULL is unlimited. code is the access code without dashes.
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY,
  who TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  seconds REAL,
  created_at INTEGER NOT NULL,
  -- Set for hours given to one phone on the Failed checks page: they need no code, the phone's ID is
  -- enough (its code is random and never shown). Added 2026-11-24: ALTER TABLE grants ADD COLUMN device TEXT.
  device TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS grants_who ON grants (lower(who));
CREATE UNIQUE INDEX IF NOT EXISTS grants_device ON grants (device);

-- Plan seconds each grant used per month ("2026-11", UTC), across all its phones.
CREATE TABLE IF NOT EXISTS grant_usage (
  grant_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  seconds REAL NOT NULL,
  PRIMARY KEY (grant_id, month)
);

-- Each Yiddish take or shared Yiddish file the yiddishtry Worker sends to be typed (review, 2026-11-25), under the
-- Worker's own id for it (take). Before it is sent, held plan seconds are added to bucket's counter (usage, grant_usage,
-- subscription_usage, or taken from credit); once the model server has typed it, charged (what it measured, twice)
-- replaces held. state: held, charged, released (not typed: held given back), expired (held longer than any take can
-- run, so its Worker stopped: held given back on the phone's next request, and charged all of it if its result still
-- comes), or refunded (a shared file's job that failed after it was charged; job is its id). Added 2026-11-25: run this
-- CREATE TABLE and its indexes on the live D1 before the deploy. Without the table, Yiddish takes are checked and
-- counted as before.
CREATE TABLE IF NOT EXISTS yiddish_takes (
  take TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  month TEXT NOT NULL,
  bucket TEXT NOT NULL,
  grant_id INTEGER,
  sub_token TEXT,
  sub_period INTEGER,
  held REAL NOT NULL,
  charged REAL,
  state TEXT NOT NULL,
  job TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS yiddish_takes_job ON yiddish_takes (job);
CREATE INDEX IF NOT EXISTS yiddish_takes_device ON yiddish_takes (device, state);

-- Phones Google Play doesn't vouch for (Isaac, 2026-11-24: "a page where i can see phone's that fail the
-- check and i can click a button to give them 30 minutes a month"). The app reports a failed check with
-- POST /v1/register; yiddishvoicetotext.com, Admin, Failed checks lists them. reason is "google:<code>"
-- (Play Integrity's error code on the phone), "timeout", "error:<what>" or "refused:<why>" (this server
-- read Google's answer and it didn't vouch). A phone that passes later leaves the list unless it has hours.
CREATE TABLE IF NOT EXISTS failed_checks (
  device TEXT PRIMARY KEY,
  model TEXT,
  android TEXT,
  app_version TEXT,
  reason TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL
);
