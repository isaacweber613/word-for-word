/**
 * Word for Word's transcription server (a Cloudflare Worker).
 *
 * The Play Store build sends recordings here instead of to OpenRouter, so people can dictate
 * without their own OpenRouter key. This server holds the OpenRouter key, picks the model, gives
 * each phone FREE_SECONDS_PER_MONTH a month, and sells more through Google Play (Isaac,
 * 2026-11-20): a $3 monthly subscription with 10 hours each paid month, and $1 top-ups of 4 hours
 * that never expire but work only while subscribed.
 *
 * Everything is counted in plan seconds: one second of audio on a model costing $0.10 an hour
 * for free minutes, $0.15 an hour for paid hours (Isaac, 2026-11-20: "i think i can afford up to
 * 15 cents per hour still gives 10 hours a month"). A pricier model uses them up faster. The model and its two
 * backups, for free and for paying phones, are Isaac's choice on his model page
 * (yiddishvoicetotext.com, Models), saved in this server's D1 table `models`.
 *
 * The OpenRouter key has its own monthly spending limit set on openrouter.ai, which caps the
 * total cost even if someone fakes many phones.
 *
 * Endpoints (all with header X-Device-Id):
 *   POST /v1/transcriptions  same JSON body as OpenRouter's /api/v1/audio/transcriptions. The
 *                            body's model is ignored. Answers like OpenRouter, with X-Model.
 *   GET  /v1/usage           {"used_seconds", "free_seconds", "month", "subscribed", "out"}
 *   POST /v1/usage/extra     {"seconds", "weight"}: audio transcribed elsewhere that still counts.
 *   POST /v1/purchases       {"product_id", "purchase_token"}: a Google Play purchase to check
 *                            and count. Answers {"subscribed", "out"}.
 */

import { verify, type Verified } from "./google";
import { d1Store, type Account, type Bucket, type ModelChoice, type Store } from "./store";

export interface Env {
  DB: D1Database;
  OPENROUTER_KEY: string;
  FREE_SECONDS_PER_MONTH: string;
  /** The JSON key of the Google service account that may read this app's Play orders. */
  GOOGLE_SERVICE_ACCOUNT?: string;
}

/** The Play products (Play Console, Monetize). */
export const SUBSCRIPTION = "monthly";
export const TOPUP = "extra_hours_4";
/** 10 hours each paid month, 4 hours per top-up, in plan seconds. */
export const SUB_SECONDS = 10 * 3600;
export const TOPUP_SECONDS = 4 * 3600;
/** The model price one plan second stands for: $0.10 an hour free, $0.15 an hour paid. */
export const FREE_BASE_PER_HOUR = 0.1;
export const PAID_BASE_PER_HOUR = 0.15;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

/** "2026-11" for the current month, in UTC. */
export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Seconds of audio in a base64 WAV the app sent: 16 kHz, 16-bit mono is 32,000 bytes a
 * second, after a 44-byte header.
 */
export function wavSeconds(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = (base64.length * 3) / 4 - padding;
  return Math.max(0, bytes - 44) / 32000;
}

/**
 * Seconds of audio in one recording. Since 0.9.7 the app sends small Ogg Opus audio instead of
 * WAV (Isaac, 2026-11-19: "as fast as possible"), so the length comes from OpenRouter's answer
 * (usage.seconds). Without it: WAV from its size, Ogg at the app's 24 kbit/s (3,000 bytes a second).
 */
export function audioSeconds(responseText: string, base64: string, format: string): number {
  try {
    const s = (JSON.parse(responseText) as { usage?: { seconds?: unknown } }).usage?.seconds;
    if (typeof s === "number" && s > 0) return s;
  } catch { /* fall through */ }
  if (format === "wav") return wavSeconds(base64);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return ((base64.length * 3) / 4 - padding) / 3000;
}

/**
 * Plan seconds one recording uses: its audio length, or more for a model pricier than [base]
 * dollars an hour (what OpenRouter charged, usage.cost, at [base] an hour). A model at or under
 * [base] counts 1:1, so 10 paid hours are 10 real hours on any model up to $0.15 an hour.
 */
export function planSeconds(responseText: string, base64: string, format: string, model: ModelChoice,
                            base = FREE_BASE_PER_HOUR): number {
  try {
    const cost = (JSON.parse(responseText) as { usage?: { cost?: unknown } }).usage?.cost;
    if (typeof cost === "number" && cost > 0) {
      return Math.max(audioSeconds(responseText, base64, format), cost / base * 3600);
    }
  } catch { /* fall through */ }
  return audioSeconds(responseText, base64, format) * Math.max(1, (model.per_hour ?? base) / base);
}

/**
 * What pays for the next recording: this month's free minutes first, then the subscription's
 * hours, then bought hours (only while subscribed). Paying phones get the paid models even on
 * free minutes. Null when nothing is left.
 */
export function choose(a: Account, now: number, free: number): { bucket: Bucket; paid: boolean } | null {
  const subscribed = !!a.sub && a.sub.expiry > now;
  if (a.freeUsed < free) return { bucket: "free", paid: subscribed };
  if (!subscribed) return null;
  if (a.sub!.used < SUB_SECONDS) return { bucket: "sub", paid: true };
  if (a.credit > 0) return { bucket: "credit", paid: true };
  return null;
}

function error(status: number, message: string, code?: string): Response {
  return Response.json({ error: { message, ...(code ? { code } : {}) } }, { status });
}

/** The answer when nothing is left. The app shows its own message for each code. */
function outOfTime(a: Account, now: number, free: number): Response {
  return a.sub && a.sub.expiry > now
    ? error(402, "You've used this month's hours.", "hours_used")
    : error(402, "You've used your " + Math.round(free / 60) + " free minutes this month.", "free_minutes_used");
}

/** A device ID is the app's hashed Android ID: 64 hex characters. */
function deviceOf(request: Request): string | null {
  const id = request.headers.get("X-Device-Id") ?? "";
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/**
 * Errors where another model may still work: the model is missing, busy, timed out, or its
 * company's servers failed. Not recording-size errors, which hit every model.
 */
export function tryAnother(status: number, text: string): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500 ||
    (status === 400 && text.toLowerCase().includes("does not exist"));
}

export async function handle(request: Request, env: Env, store: Store, now = new Date(),
                             fetcher: typeof fetch = fetch,
                             defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const device = deviceOf(request);
  const free = Number(env.FREE_SECONDS_PER_MONTH);
  const month = monthOf(now);
  const later = async (work: Promise<unknown>) => { if (defer) defer(work); else await work; };

  if (url.pathname === "/v1/usage" && request.method === "GET") {
    if (!device) return error(400, "Missing device ID.");
    const a = await store.account(device, month);
    return Response.json({ used_seconds: a.freeUsed, free_seconds: free, month,
      subscribed: !!a.sub && a.sub.expiry > now.getTime(), out: !choose(a, now.getTime(), free) });
  }

  if (url.pathname === "/v1/usage/extra" && request.method === "POST") {
    if (!device) return error(400, "Missing device ID.");
    const { seconds, weight } = await request.json().catch(() => ({})) as { seconds?: unknown; weight?: unknown };
    if (typeof seconds !== "number" || !(seconds > 0)) return error(400, "Missing seconds.");
    const w = typeof weight === "number" && weight >= 1 ? weight : 1;
    const a = await store.account(device, month);
    const pick = choose(a, now.getTime(), free);
    if (pick) await store.charge(device, month, pick.bucket, seconds * w, a.sub);
    const after = await store.account(device, month);
    return Response.json({ out: !choose(after, now.getTime(), free) });
  }

  if (url.pathname === "/v1/purchases" && request.method === "POST") {
    if (!device) return error(400, "Missing device ID.");
    if (!env.GOOGLE_SERVICE_ACCOUNT) return error(503, "Purchases can't be checked right now.");
    const { product_id: product, purchase_token: token } = await request.json().catch(() => ({})) as
      { product_id?: unknown; purchase_token?: unknown };
    if (typeof product !== "string" || typeof token !== "string" || ![SUBSCRIPTION, TOPUP].includes(product)) {
      return error(400, "Unknown purchase.");
    }
    let v: Verified;
    try {
      v = await verify(env.GOOGLE_SERVICE_ACCOUNT, product, token, product === SUBSCRIPTION, fetcher, now.getTime());
    } catch {
      return error(503, "Google Play didn't answer. Try again.");
    }
    if (!v) return error(402, "Google Play doesn't show this purchase as paid.", "not_paid");
    if (v.kind === "subscription") await store.saveSubscription(device, { token, product: v.product, expiry: v.expiry });
    else await store.addTopup(token, device, TOPUP_SECONDS, now.getTime());
    const a = await store.account(device, month);
    return Response.json({ subscribed: !!a.sub && a.sub.expiry > now.getTime(), out: !choose(a, now.getTime(), free) });
  }

  if (url.pathname !== "/v1/transcriptions" || request.method !== "POST") return error(404, "Not found.");
  if (!device) return error(400, "Missing device ID.");

  let body: { model?: unknown; language?: unknown; input_audio?: { data?: unknown; format?: unknown } };
  try {
    body = await request.json();
  } catch {
    return error(400, "The request isn't valid JSON.");
  }
  const audio = body.input_audio?.data;
  if (typeof audio !== "string" || audio.length === 0) return error(400, "No audio in the request.");
  const format = typeof body.input_audio?.format === "string" ? body.input_audio.format : "wav";

  const a = await store.account(device, month);
  const pick = choose(a, now.getTime(), free);
  if (!pick) return outOfTime(a, now.getTime(), free);

  const send = (b: object) => fetcher(OPENROUTER_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json", "X-Title": "Word for Word" },
    body: JSON.stringify(b),
  });

  // The main model, then each backup when the one before is missing, busy or down.
  let status = 502, text = JSON.stringify({ error: { message: "No model answered." } }), used: ModelChoice | null = null;
  for (const model of pick.paid ? a.models.paid : a.models.free) {
    let b: Record<string, unknown> = { ...body, model: model.id };
    let res = await send(b);
    text = await res.text();
    if ("language" in b && (res.status === 400 || res.status === 422) && !text.includes("does not exist")) {
      // The model refused the language: send again and let it guess.
      const { language: _drop, ...rest } = b;
      b = rest;
      res = await send(b);
      text = await res.text();
    }
    status = res.status;
    used = model;
    if (res.ok || !tryAnother(res.status, text)) break;
  }

  // Only audio that came back as text counts. The count is saved after the answer goes back.
  if (status >= 200 && status < 300 && used) {
    await later(store.charge(device, month, pick.bucket, planSeconds(text, audio, format, used,
      pick.bucket === "free" ? FREE_BASE_PER_HOUR : PAID_BASE_PER_HOUR), a.sub));
  }
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...(used ? { "X-Model": used.id } : {}) } });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, d1Store(env.DB), new Date(), fetch, p => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Env>;
