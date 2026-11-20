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
  expiry INTEGER NOT NULL
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
