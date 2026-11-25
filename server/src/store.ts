/**
 * What the server keeps in D1 (tables in schema.sql). All amounts are "plan seconds": a second of
 * audio on a model costing $0.10 an hour, so a pricier model uses them up faster (see weighted).
 */

/** One model Isaac picked on his model page (yiddishvoicetotext.com, Models), with its price. */
export interface ModelChoice { id: string; per_hour: number | null }
/** Main model first, then the backups, for people without and with the subscription. */
export interface Models { free: ModelChoice[]; paid: ModelChoice[] }

/** Used until Isaac saves a choice: the app's model and its backup before 2026-11-20. */
export const DEFAULT_MODELS: Models = {
  free: [{ id: "microsoft/mai-transcribe-2", per_hour: 0.1 }, { id: "openai/gpt-transcribe", per_hour: 0.27 }],
  paid: [{ id: "microsoft/mai-transcribe-2", per_hour: 0.1 }, { id: "openai/gpt-transcribe", per_hour: 0.27 }],
};

/** A Google Play subscription linked to the phone. [expiry] is the end of the paid month, in ms. */
export interface Sub { token: string; product: string; expiry: number }

/**
 * Hours Isaac gave a person on his Access page, shared by every phone with its access code, or given to
 * one phone on his Failed checks page ([device] set, no code needed). [seconds] is plan seconds a month,
 * null for unlimited; [used] is this month's.
 */
export interface Grant { id: number; who: string; seconds: number | null; used: number; device: string | null }

/** What the app says about a phone whose check failed (POST /v1/register). */
export interface FailedCheck { model: string; android: string; app_version: string; reason: string }

export interface Account {
  freeUsed: number;
  /** The grant for the access code the call carried, else one given to this phone, or null. */
  grant: Grant | null;
  models: Models;
  /** The phone's latest subscription (maybe expired), with the plan seconds used this paid month. */
  sub: (Sub & { used: number }) | null;
  /** Extra hours bought, in plan seconds. Usable only while subscribed. */
  credit: number;
}

export type Bucket = "grant" | "free" | "sub" | "credit";

export interface Store {
  /** [code] is the access code the call carried (normalized, see accessCode), or null. */
  account(device: string, month: string, code?: string | null): Promise<Account>;
  charge(device: string, month: string, bucket: Bucket, seconds: number, sub: Sub | null, grant?: Grant | null): Promise<void>;
  saveSubscription(device: string, sub: Sub): Promise<void>;
  /** Adds a bought top-up once. False when this purchase was already counted. */
  addTopup(token: string, device: string, seconds: number, now: number): Promise<boolean>;
  /** Saves a failed check on the Failed checks list, counting each report. */
  failedCheck(device: string, report: FailedCheck, now: number): Promise<void>;
  /** The phone passed: it leaves the list, unless Isaac gave it hours. */
  passedCheck(device: string): Promise<void>;
}

function parseModels(json: string | undefined, fallback: ModelChoice[]): ModelChoice[] {
  try {
    const list = JSON.parse(json ?? "") as ModelChoice[];
    if (Array.isArray(list) && list.length && list.every((m) => typeof m.id === "string")) return list;
  } catch { /* use the default */ }
  return fallback;
}

export function d1Store(db: D1Database): Store {
  return {
    async account(device, month, code) {
      // One round trip for everything a recording needs.
      const [free, models, sub, credit, grant] = await db.batch([
        db.prepare("SELECT seconds FROM usage WHERE device = ? AND month = ?").bind(device, month),
        db.prepare("SELECT tier, models FROM models"),
        db.prepare(
          "SELECT s.token, s.product, s.expiry, coalesce(u.seconds, 0) AS used FROM subscription_devices d " +
          "JOIN subscriptions s ON s.token = d.token " +
          "LEFT JOIN subscription_usage u ON u.token = s.token AND u.period = s.expiry " +
          "WHERE d.device = ? ORDER BY s.expiry DESC LIMIT 1").bind(device),
        db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(device),
        // The code's grant first, else the phone's own.
        db.prepare("SELECT g.id, g.who, g.seconds, g.device, coalesce(u.seconds, 0) AS used FROM grants g " +
          "LEFT JOIN grant_usage u ON u.grant_id = g.id AND u.month = ? WHERE g.code = ? OR g.device = ? " +
          "ORDER BY g.device IS NULL DESC LIMIT 1").bind(month, code ?? "", device),
      ]);
      const tiers = Object.fromEntries((models.results as { tier: string; models: string }[]).map((r) => [r.tier, r.models]));
      return {
        freeUsed: (free.results[0] as { seconds: number } | undefined)?.seconds ?? 0,
        grant: (grant.results[0] as Grant | undefined) ?? null,
        models: { free: parseModels(tiers.free, DEFAULT_MODELS.free), paid: parseModels(tiers.paid, DEFAULT_MODELS.paid) },
        sub: (sub.results[0] as (Sub & { used: number }) | undefined) ?? null,
        credit: (credit.results[0] as { seconds: number } | undefined)?.seconds ?? 0,
      };
    },
    async charge(device, month, bucket, seconds, sub, grant) {
      if (bucket === "grant" && grant) {
        await db.prepare("INSERT INTO grant_usage (grant_id, month, seconds) VALUES (?, ?, ?) " +
          "ON CONFLICT (grant_id, month) DO UPDATE SET seconds = seconds + excluded.seconds").bind(grant.id, month, seconds).run();
      } else if (bucket === "free") {
        await db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, ?) " +
          "ON CONFLICT (device, month) DO UPDATE SET seconds = seconds + excluded.seconds").bind(device, month, seconds).run();
      } else if (bucket === "sub" && sub) {
        await db.prepare("INSERT INTO subscription_usage (token, period, seconds) VALUES (?, ?, ?) " +
          "ON CONFLICT (token, period) DO UPDATE SET seconds = seconds + excluded.seconds").bind(sub.token, sub.expiry, seconds).run();
      } else if (bucket === "credit") {
        await db.prepare("UPDATE credit SET seconds = max(0, seconds - ?) WHERE device = ?").bind(seconds, device).run();
      }
    },
    async saveSubscription(device, sub) {
      await db.batch([
        db.prepare("INSERT INTO subscriptions (token, product, expiry) VALUES (?, ?, ?) " +
          "ON CONFLICT (token) DO UPDATE SET product = excluded.product, expiry = excluded.expiry").bind(sub.token, sub.product, sub.expiry),
        db.prepare("INSERT OR IGNORE INTO subscription_devices (device, token) VALUES (?, ?)").bind(device, sub.token),
      ]);
    },
    async addTopup(token, device, seconds, now) {
      const r = await db.prepare("INSERT OR IGNORE INTO topups (token, device, seconds, created_at) VALUES (?, ?, ?, ?)")
        .bind(token, device, seconds, now).run();
      if (!r.meta.changes) return false;
      await db.prepare("INSERT INTO credit (device, seconds) VALUES (?, ?) " +
        "ON CONFLICT (device) DO UPDATE SET seconds = seconds + excluded.seconds").bind(device, seconds).run();
      return true;
    },
    async failedCheck(device, r, now) {
      await db.prepare("INSERT INTO failed_checks (device, model, android, app_version, reason, first_seen, last_seen, count) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (device) DO UPDATE SET model = excluded.model, android = excluded.android, " +
        "app_version = excluded.app_version, reason = excluded.reason, last_seen = excluded.last_seen, count = count + 1")
        .bind(device, r.model, r.android, r.app_version, r.reason, now, now).run();
    },
    async passedCheck(device) {
      await db.prepare("DELETE FROM failed_checks WHERE device = ? AND NOT EXISTS (SELECT 1 FROM grants WHERE device = ?)")
        .bind(device, device).run();
    },
  };
}
