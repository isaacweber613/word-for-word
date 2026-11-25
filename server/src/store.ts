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

/**
 * A Google Play subscription linked to the phone. [expiry] is the end of the paid month, in ms.
 * [state] is what Google said the last time this server asked (ACTIVE, IN_GRACE_PERIOD, ON_HOLD,
 * CANCELED, EXPIRED, ..., or GONE when Google no longer knows the token), [checked] when it asked
 * (ms). Both are null for rows saved before 2026-11-25. [period] is the paid month its hours count in
 * (see usagePeriod); null means [expiry].
 */
export interface Sub { token: string; product: string; expiry: number; state?: string | null; checked?: number | null;
                       period?: number | null }

/**
 * The paid month [next] counts its hours in, after [prev] (the same subscription as stored, or null):
 * its expiry, so each paid renewal starts 10 fresh hours, except in Google's grace period. There
 * Google moves the expiry forward while the renewal is still unpaid, so the hours keep counting in
 * the month before (Isaac, 2026-11-25). The d1Store's saveSubscription applies the same rule in SQL.
 */
export function usagePeriod(prev: Sub | null | undefined, next: Sub): number {
  return next.state === "IN_GRACE_PERIOD" && prev ? prev.period ?? prev.expiry : next.expiry;
}

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
  /**
   * Holds [seconds] on [bucket] for a recording about to be sent, only while what it used is still under
   * [limit] (null: no limit; bought hours: while any are left), in one statement, so calls at the same
   * moment can't all pass on the same last second. False when nothing is left. charge then settles it.
   */
  reserve(device: string, month: string, bucket: Bucket, seconds: number, limit: number | null, sub: Sub | null,
          grant?: Grant | null): Promise<boolean>;
  /** Adds [seconds] to what [bucket] used; a negative amount gives back part of what reserve held. */
  charge(device: string, month: string, bucket: Bucket, seconds: number, sub: Sub | null, grant?: Grant | null): Promise<void>;
  saveSubscription(device: string, sub: Sub): Promise<void>;
  /** Adds a bought top-up once. False when this purchase was already counted. */
  addTopup(token: string, device: string, seconds: number, now: number): Promise<boolean>;
  /**
   * When Google was last asked whether this phone's counted top-ups were refunded (the oldest of them;
   * one never asked about counts from when it was bought), or null when it has none.
   */
  topupsChecked(device: string): Promise<number | null>;
  /** The purchase tokens of [device]'s counted top-ups last checked (or bought, if never checked) before [before]. */
  staleTopups(device: string, before: number): Promise<string[]>;
  /**
   * Takes back what is left of each voided top-up's hours from its phone, never below zero, once per
   * top-up. Then marks as checked at [now] the counted top-ups Google's refund list covered (last checked,
   * or bought, since [since]) and all of [device]'s, which were asked about one by one. Answers how many
   * were taken back.
   */
  takeBackTopups(voided: string[], now: number, since: number, device: string): Promise<number>;
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
  /**
   * Adds [seconds] to the counter row of [table] keyed by [keys]; a negative amount (giving back what reserve
   * held) only changes a row that is there. [table] and [keys] are this file's own names, never input.
   */
  const add = (table: string, keys: [string, string], values: [string | number, string | number], seconds: number) =>
    (seconds < 0
      ? db.prepare(`UPDATE ${table} SET seconds = seconds + ? WHERE ${keys[0]} = ? AND ${keys[1]} = ?`).bind(seconds, ...values)
      : db.prepare(`INSERT INTO ${table} (${keys[0]}, ${keys[1]}, seconds) VALUES (?, ?, ?) ON CONFLICT (${keys[0]}, ${keys[1]}) ` +
          "DO UPDATE SET seconds = seconds + excluded.seconds").bind(...values, seconds)).run();
  return {
    async account(device, month, code) {
      // One round trip for everything a recording needs.
      const [free, models, sub, credit, grant] = await db.batch([
        db.prepare("SELECT seconds FROM usage WHERE device = ? AND month = ?").bind(device, month),
        db.prepare("SELECT tier, models FROM models"),
        db.prepare(
          "SELECT s.token, s.product, s.expiry, s.state, s.checked, coalesce(s.period, s.expiry) AS period, " +
          "coalesce(u.seconds, 0) AS used FROM subscription_devices d " +
          "JOIN subscriptions s ON s.token = d.token " +
          "LEFT JOIN subscription_usage u ON u.token = s.token AND u.period = coalesce(s.period, s.expiry) " +
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
    async reserve(device, month, bucket, seconds, limit, sub, grant) {
      // An upsert whose update runs only under the limit: no row changes (meta.changes 0) once nothing is left.
      const held =
        bucket === "free" ? db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?1, ?2, ?3) ON CONFLICT (device, month) " +
          "DO UPDATE SET seconds = seconds + excluded.seconds WHERE usage.seconds < ?4").bind(device, month, seconds, limit)
        : bucket === "grant" && grant ? db.prepare("INSERT INTO grant_usage (grant_id, month, seconds) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT (grant_id, month) DO UPDATE SET seconds = seconds + excluded.seconds WHERE ?4 IS NULL OR grant_usage.seconds < ?4")
          .bind(grant.id, month, seconds, limit)
        : bucket === "sub" && sub ? db.prepare("INSERT INTO subscription_usage (token, period, seconds) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT (token, period) DO UPDATE SET seconds = seconds + excluded.seconds WHERE subscription_usage.seconds < ?4")
          .bind(sub.token, sub.period ?? sub.expiry, seconds, limit)
        // Bought hours may go below zero while held; charge settles them at zero or more, as before.
        : bucket === "credit" ? db.prepare("UPDATE credit SET seconds = seconds - ?1 WHERE device = ?2 AND seconds > 0").bind(seconds, device)
        : null;
      return !!held && ((await held.run()).meta.changes ?? 0) > 0;
    },
    async charge(device, month, bucket, seconds, sub, grant) {
      if (bucket === "grant" && grant) await add("grant_usage", ["grant_id", "month"], [grant.id, month], seconds);
      else if (bucket === "free") await add("usage", ["device", "month"], [device, month], seconds);
      else if (bucket === "sub" && sub) await add("subscription_usage", ["token", "period"], [sub.token, sub.period ?? sub.expiry], seconds);
      else if (bucket === "credit") {
        await db.prepare("UPDATE credit SET seconds = max(0, seconds - ?) WHERE device = ?").bind(seconds, device).run();
      }
    },
    async saveSubscription(device, sub) {
      await db.batch([
        // usagePeriod: a new row, or a paid renewal, counts in its expiry; a grace period keeps the stored month.
        db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (token) DO UPDATE SET product = excluded.product, expiry = excluded.expiry, state = excluded.state, " +
          "checked = excluded.checked, period = CASE WHEN excluded.state = 'IN_GRACE_PERIOD' " +
          "THEN coalesce(subscriptions.period, subscriptions.expiry) ELSE excluded.expiry END")
          .bind(sub.token, sub.product, sub.expiry, sub.state ?? null, sub.checked ?? null, sub.expiry),
        db.prepare("INSERT OR IGNORE INTO subscription_devices (device, token) VALUES (?, ?)").bind(device, sub.token),
      ]);
    },
    async addTopup(token, device, seconds, now) {
      // One transaction, the hours added only when this call counted the top-up (changes() is the insert's), so a
      // failure between the two can't leave it counted without its hours (review, 2026-11-25: then every later
      // send of the purchase was ignored as already counted, and the 4 hours bought were never added).
      const [counted] = await db.batch([
        db.prepare("INSERT OR IGNORE INTO topups (token, device, seconds, created_at) VALUES (?, ?, ?, ?)").bind(token, device, seconds, now),
        db.prepare("INSERT INTO credit (device, seconds) SELECT ?, ? WHERE changes() = 1 " +
          "ON CONFLICT (device) DO UPDATE SET seconds = seconds + excluded.seconds").bind(device, seconds),
      ]);
      return (counted.meta.changes ?? 0) > 0;
    },
    async topupsChecked(device) {
      const row = await db.prepare("SELECT min(coalesce(checked, created_at)) AS at FROM topups WHERE device = ? AND voided IS NULL")
        .bind(device).first<{ at: number | null }>();
      return row?.at ?? null;
    },
    async staleTopups(device, before) {
      const rows = await db.prepare("SELECT token FROM topups WHERE device = ? AND voided IS NULL AND coalesce(checked, created_at) < ?")
        .bind(device, before).all<{ token: string }>();
      return rows.results.map((r) => r.token);
    },
    async takeBackTopups(voided, now, since, device) {
      // One transaction: a top-up already taken back, or one this server never counted, changes nothing.
      const results = await db.batch([
        ...voided.flatMap((token) => [
          db.prepare("UPDATE credit SET seconds = max(0, seconds - (SELECT seconds FROM topups WHERE token = ? AND voided IS NULL)) " +
            "WHERE device = (SELECT device FROM topups WHERE token = ? AND voided IS NULL)").bind(token, token),
          db.prepare("UPDATE topups SET voided = ? WHERE token = ? AND voided IS NULL").bind(now, token),
        ]),
        // Another phone's top-up last checked before [since] stays unchecked until that phone asks about it itself.
        db.prepare("UPDATE topups SET checked = ? WHERE voided IS NULL AND (coalesce(checked, created_at) >= ? OR device = ?)")
          .bind(now, since, device),
      ]);
      return results.filter((_, i) => i % 2 === 1 && i < voided.length * 2).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
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
