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
  /**
   * [code] is the access code the call carried (normalized, see accessCode), or null. With [expireBefore] (ms), first
   * gives back, once, the phone's Yiddish holds made before then whose take never settled (state expired).
   */
  account(device: string, month: string, code?: string | null, expireBefore?: number | null): Promise<Account>;
  /**
   * Holds [seconds] on [bucket] for a recording about to be sent, only while what it used is still under
   * [limit] (null: no limit; bought hours: while any are left), in one statement, so calls at the same
   * moment can't all pass on the same last second. False when nothing is left. charge then settles it.
   */
  reserve(device: string, month: string, bucket: Bucket, seconds: number, limit: number | null, sub: Sub | null,
          grant?: Grant | null): Promise<boolean>;
  /**
   * Adds [seconds] to what [bucket] used; a negative amount gives back part of what reserve held. Bought hours can
   * stay below zero after a recording started on their last seconds ran over; a top-up counts from zero (addTopup).
   */
  charge(device: string, month: string, bucket: Bucket, seconds: number, sub: Sub | null, grant?: Grant | null): Promise<void>;
  saveSubscription(device: string, sub: Sub): Promise<void>;
  /**
   * Adds a bought top-up once, onto zero when the bought hours are below it, so going over on the last seconds is
   * never a debt against it. False when this purchase was already counted.
   */
  addTopup(token: string, device: string, seconds: number, now: number): Promise<boolean>;
  /**
   * When Google was last asked whether this phone's counted top-ups were refunded (the oldest of them;
   * one never asked about counts from when it was bought), or null when it has none.
   */
  topupsChecked(device: string): Promise<number | null>;
  /** The purchase tokens of [device]'s counted top-ups last checked (or bought, if never checked) before [before]. */
  staleTopups(device: string, before: number): Promise<string[]>;
  /**
   * Takes back what is left of each voided top-up's own hours from its phone (the oldest bought hours used first),
   * never below zero, once per top-up. Then marks as checked at [now] the counted top-ups Google's refund list covered
   * (last checked, or bought, since [since]) and all of [device]'s, which were asked about one by one. Answers how many
   * were taken back.
   */
  takeBackTopups(voided: string[], now: number, since: number, device: string): Promise<number>;
  /**
   * Holds [seconds] on [bucket] for the Yiddish take [take] before it is sent, only if all of them fit under [limit]
   * (null: no limit; bought hours: while that many are left), in one batch with the take's row (table yiddish_takes),
   * so takes at the same moment can't share the last seconds. False when they don't fit.
   */
  holdTake(take: string, device: string, month: string, bucket: Bucket, seconds: number, limit: number | null,
           sub: Sub | null, grant: Grant | null, now: number): Promise<boolean>;
  /**
   * Counts the held take [take] [seconds] in place of its hold, once, with [job] when it is a shared file's job; a take
   * whose hold expired is counted all of [seconds]. Bought hours a take runs over stay below zero until the next top-up.
   * False when it wasn't held or was already counted or given back.
   */
  settleTake(take: string, seconds: number, job: string | null): Promise<boolean>;
  /** Gives back what the take [take] holds, once, when it wasn't typed. */
  releaseTake(take: string): Promise<boolean>;
  /** Gives back what the shared file whose job is [job] was counted, once, when that job failed after it started. */
  refundJob(job: string): Promise<boolean>;
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

/** A row of yiddish_takes (schema.sql). */
interface TakeRow { take: string; device: string; month: string; bucket: Bucket; grant_id: number | null; sub_token: string | null;
                    sub_period: number | null; held: number; charged: number | null; state: string; job: string | null }

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
  /**
   * For a batch: adds [amount] (an expression over the take's own row, this file's text, never input) to the counter
   * the take [t] is held on, only right after a statement that changed one row: the take's move from one state to the
   * next, so a call made twice, or after another one, changes nothing. Bought hours count down.
   */
  const onTakeCounter = (t: TakeRow, amount: string) => {
    const of = `(SELECT ${amount} FROM yiddish_takes WHERE take = ?1)`;
    return t.bucket === "free"
      ? db.prepare(`UPDATE usage SET seconds = seconds + ${of} WHERE device = ?2 AND month = ?3 AND changes() = 1`).bind(t.take, t.device, t.month)
      : t.bucket === "grant"
      ? db.prepare(`UPDATE grant_usage SET seconds = seconds + ${of} WHERE grant_id = ?2 AND month = ?3 AND changes() = 1`).bind(t.take, t.grant_id, t.month)
      : t.bucket === "sub"
      ? db.prepare(`UPDATE subscription_usage SET seconds = seconds + ${of} WHERE token = ?2 AND period = ?3 AND changes() = 1`)
          .bind(t.take, t.sub_token, t.sub_period)
      : db.prepare(`UPDATE credit SET seconds = seconds - ${of} WHERE device = ?2 AND changes() = 1`).bind(t.take, t.device);
  };
  const takeRow = (where: string, value: string) =>
    db.prepare(`SELECT * FROM yiddish_takes WHERE ${where} = ?`).bind(value).first<TakeRow>();
  /**
   * For account's batch: gives back, once, what [device]'s takes held before [before] (ms) still hold, on the counter each
   * is held on, and marks them expired (settleTake still counts one whose result comes).
   */
  const expireTakes = (device: string, before: number) => {
    const stale = (bucket: string, cols = "1") => `SELECT ${cols} FROM yiddish_takes WHERE device = ?1 AND state = 'held' ` +
      `AND created_at < ?2 AND bucket = '${bucket}'`;
    const sum = (bucket: string, match: string) => `(SELECT sum(held) FROM yiddish_takes WHERE device = ?1 AND state = 'held' ` +
      `AND created_at < ?2 AND bucket = '${bucket}' AND ${match})`;
    return [
      db.prepare(`UPDATE usage SET seconds = seconds - ${sum("free", "month = usage.month")} ` +
        `WHERE device = ?1 AND month IN (${stale("free", "month")})`),
      db.prepare(`UPDATE grant_usage SET seconds = seconds - ${sum("grant", "grant_id = grant_usage.grant_id AND month = grant_usage.month")} ` +
        `WHERE (grant_id, month) IN (${stale("grant", "grant_id, month")})`),
      db.prepare(`UPDATE subscription_usage SET seconds = seconds - ` +
        `${sum("sub", "sub_token = subscription_usage.token AND sub_period = subscription_usage.period")} ` +
        `WHERE (token, period) IN (${stale("sub", "sub_token, sub_period")})`),
      db.prepare(`UPDATE credit SET seconds = seconds + ${sum("credit", "1")} WHERE device = ?1 AND EXISTS (${stale("credit")})`),
      db.prepare("UPDATE yiddish_takes SET state = 'expired' WHERE device = ?1 AND state = 'held' AND created_at < ?2"),
    ].map((s) => s.bind(device, before));
  };
  return {
    async account(device, month, code, expireBefore) {
      // One round trip for everything a recording needs, with the phone's expired Yiddish holds given back first.
      const reads = [
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
      ];
      const expire = expireBefore == null ? [] : expireTakes(device, expireBefore);
      let results: D1Result[];
      try {
        results = (await db.batch([...expire, ...reads])).slice(expire.length);
      } catch (e) {
        // A database without yiddish_takes yet (schema.sql) has no holds to give back.
        if (!expire.length || !/no such table/i.test(String((e as Error | null)?.message ?? e))) throw e;
        results = await db.batch(reads);
      }
      const [free, models, sub, credit, grant] = results;
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
        // Bought hours may go below zero while held, and after (charge, addTopup).
        : bucket === "credit" ? db.prepare("UPDATE credit SET seconds = seconds - ?1 WHERE device = ?2 AND seconds > 0").bind(seconds, device)
        : null;
      return !!held && ((await held.run()).meta.changes ?? 0) > 0;
    },
    async charge(device, month, bucket, seconds, sub, grant) {
      if (bucket === "grant" && grant) await add("grant_usage", ["grant_id", "month"], [grant.id, month], seconds);
      else if (bucket === "free") await add("usage", ["device", "month"], [device, month], seconds);
      else if (bucket === "sub" && sub) await add("subscription_usage", ["token", "period"], [sub.token, sub.period ?? sub.expiry], seconds);
      else if (bucket === "credit") {
        // Not floored at zero here (Codex review of 52c15aa): another recording's hold may still be out in the same
        // balance, and clipping it gave hours nobody bought once that recording was given back. addTopup floors.
        await db.prepare("UPDATE credit SET seconds = seconds - ? WHERE device = ?").bind(seconds, device).run();
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
          "ON CONFLICT (device) DO UPDATE SET seconds = max(0, seconds) + excluded.seconds").bind(device, seconds),
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
      // What is left of the refunded top-up itself, with the oldest bought hours used first: the phone's balance less the
      // top-ups bought after it, never more than its own hours or below zero (third review, 2026-11-25: its whole 4 hours
      // came off the balance, so a top-up used up and then refunded took the hours of one bought after it).
      const results = await db.batch([
        ...voided.flatMap((token) => [
          db.prepare("UPDATE credit SET seconds = seconds - min((SELECT seconds FROM topups WHERE token = ?1 AND voided IS NULL), " +
            "max(0, seconds - (SELECT coalesce(sum(t.seconds), 0) FROM topups t JOIN topups v ON v.token = ?1 " +
            "WHERE t.device = v.device AND t.voided IS NULL AND t.token != v.token AND " +
            "(t.created_at > v.created_at OR (t.created_at = v.created_at AND t.token > v.token))))) " +
            "WHERE device = (SELECT device FROM topups WHERE token = ?1 AND voided IS NULL)").bind(token),
          db.prepare("UPDATE topups SET voided = ? WHERE token = ? AND voided IS NULL").bind(now, token),
        ]),
        // Another phone's top-up last checked before [since] stays unchecked until that phone asks about it itself.
        db.prepare("UPDATE topups SET checked = ? WHERE voided IS NULL AND (coalesce(checked, created_at) >= ? OR device = ?)")
          .bind(now, since, device),
      ]);
      return results.filter((_, i) => i % 2 === 1 && i < voided.length * 2).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    },
    async holdTake(take, device, month, bucket, seconds, limit, sub, grant, now) {
      // The counter changes only when all of [seconds] fit (an upsert whose insert and update both check), and the
      // take's row is written only when it did (changes() is the counter's), in one transaction.
      const counter =
        bucket === "free" ? db.prepare("INSERT INTO usage (device, month, seconds) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4 " +
          "ON CONFLICT (device, month) DO UPDATE SET seconds = seconds + excluded.seconds WHERE usage.seconds + excluded.seconds <= ?4")
          .bind(device, month, seconds, limit)
        : bucket === "grant" && grant ? db.prepare("INSERT INTO grant_usage (grant_id, month, seconds) SELECT ?1, ?2, ?3 " +
          "WHERE ?4 IS NULL OR ?3 <= ?4 ON CONFLICT (grant_id, month) DO UPDATE SET seconds = seconds + excluded.seconds " +
          "WHERE ?4 IS NULL OR grant_usage.seconds + excluded.seconds <= ?4").bind(grant.id, month, seconds, limit)
        : bucket === "sub" && sub ? db.prepare("INSERT INTO subscription_usage (token, period, seconds) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4 " +
          "ON CONFLICT (token, period) DO UPDATE SET seconds = seconds + excluded.seconds " +
          "WHERE subscription_usage.seconds + excluded.seconds <= ?4").bind(sub.token, sub.period ?? sub.expiry, seconds, limit)
        : bucket === "credit" ? db.prepare("UPDATE credit SET seconds = seconds - ?1 WHERE device = ?2 AND seconds >= ?1").bind(seconds, device)
        : null;
      if (!counter) return false;
      const [, row] = await db.batch([counter,
        db.prepare("INSERT INTO yiddish_takes (take, device, month, bucket, grant_id, sub_token, sub_period, held, state, created_at) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'held', ? WHERE changes() = 1")
          .bind(take, device, month, bucket, grant?.id ?? null, sub?.token ?? null, sub ? sub.period ?? sub.expiry : null, seconds, now),
      ]);
      return (row.meta.changes ?? 0) > 0;
    },
    async settleTake(take, seconds, job) {
      const t = await takeRow("take", take);
      if (!t || (t.state !== "held" && t.state !== "expired")) return false;
      // All of [seconds], on bought hours too (third review, 2026-11-25: capped at the hold plus what other holds left, a
      // take that ran over its hold while a normal recording's time was held went partly free). Held: in place of the
      // hold. Expired (its hold given back since, account): all of it. One batch, so an expiry just before it is seen.
      const moved = (from: string) => db.prepare("UPDATE yiddish_takes SET state = 'charged', job = ?2, charged = ?1 " +
        "WHERE take = ?3 AND state = ?4").bind(seconds, job, take, from);
      const [held, , expired] = await db.batch([moved("held"), onTakeCounter(t, "charged - held"),
                                                moved("expired"), onTakeCounter(t, "charged")]);
      return (held.meta.changes ?? 0) + (expired.meta.changes ?? 0) > 0;
    },
    async releaseTake(take) {
      const t = await takeRow("take", take);
      if (!t || t.state !== "held") return false;
      const [moved] = await db.batch([
        db.prepare("UPDATE yiddish_takes SET state = 'released' WHERE take = ? AND state = 'held'").bind(take),
        onTakeCounter(t, "-held"),
      ]);
      return (moved.meta.changes ?? 0) > 0;
    },
    async refundJob(job) {
      const t = await takeRow("job", job);
      if (!t || t.state !== "charged") return false;
      const [moved] = await db.batch([
        db.prepare("UPDATE yiddish_takes SET state = 'refunded' WHERE take = ? AND state = 'charged'").bind(t.take),
        onTakeCounter(t, "-charged"),
      ]);
      return (moved.meta.changes ?? 0) > 0;
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
