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
  checked INTEGER
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
  created_at INTEGER NOT NULL
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
