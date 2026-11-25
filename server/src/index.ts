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
 * Each recording holds its estimated length on what pays for it before it is sent (Store.reserve), so
 * many recordings at once can't all pass on the same last second; OpenRouter's measured length replaces
 * the estimate afterwards. OpenRouter gets only what the app sends (forwardedBody). Optional limits,
 * all off until set (review, 2026-11-25): OPENROUTER_PAID_KEY, a key just for phones that pay, so free
 * or given use reaching OPENROUTER_KEY's limit doesn't stop them; MAX_RECORDING_SECONDS; and the rate
 * limits DEVICE_LIMITER (recordings and purchases per phone) and ADDRESS_LIMITER (phone checks per address).
 *
 * Only the real Play app may use it (Isaac, 2026-11-22): the app is open source, so anyone could
 * otherwise send made-up device IDs from a computer and get free minutes forever. Once per install
 * the app asks Google Play Integrity to vouch for it (POST /v1/register) and gets a device token
 * back, which it sends as X-Device-Token on every other call. Isaac chose the weakest device check:
 * the app must be Play's own build and the phone must pass basic integrity, so GrapheneOS and
 * rooted phones still work. While REQUIRE_INTEGRITY isn't "true", calls without a token still work.
 *
 * Endpoints (all with header X-Device-Id):
 *   POST /v1/register        {"integrity_token", "model", "android", "app_version"}: a Play Integrity
 *                            token whose request hash is the device ID. Answers {"device_token"}, or 403
 *                            code device_unverified. Without a token, {"integrity_error"} says why the
 *                            phone got none (answer: 400 no_play_token). Both failures go on the
 *                            Failed checks list (table failed_checks).
 *   POST /v1/transcriptions  same JSON body as OpenRouter's /api/v1/audio/transcriptions. The
 *                            body's model is ignored. Answers like OpenRouter, with X-Model.
 *   GET  /v1/usage           {"used_seconds", "free_seconds", "month", "subscribed", "out"}
 *   POST /v1/purchases       {"product_id", "purchase_token"}: a Google Play purchase to check
 *                            and count. Answers {"subscribed", "out"}.
 *
 * Hours given without a subscription (Isaac, 2026-11-24: "Make me a way to give access, for people,
 * without subscribing"): on yiddishvoicetotext.com, Access, Isaac gives a person any number of hours a
 * month or unlimited (table grants). Each person has an access code and a link with it; tapping the
 * link opens the app, which keeps the code (GitHub builds can also type it). Every call with the code
 * (header X-Access-Code) uses those hours first, on every phone that has it. They reset each UTC month
 * like the free minutes. A call with a valid code doesn't need a device token, since GitHub builds can't
 * get one; the code is the proof.
 * Isaac can also give hours to one phone whose check fails (Isaac, 2026-11-24: "a page where i can see
 * phone's that fail the check and i can click a button to give them 30 minutes a month"), on
 * yiddishvoicetotext.com, Admin, Failed checks: a grant with the phone's device ID, used like a code's.
 *   GET /.well-known/assetlinks.json   for nuchemweber.com (route in wrangler.jsonc), so Android opens
 *                            the access links (https://nuchemweber.com/wordforword/a/?c=...) in the app.
 *
 * The Worker in front of the Yiddish model asks this server before each of the app's Yiddish takes
 * and counts the take afterwards, through the RPC entrypoint in worker.ts (yiddishCheck and
 * yiddishCharge below), which isn't on the internet.
 */

import { decodeIntegrity, PACKAGE, productState, verify, VOIDED_WINDOW_MS, voidedPurchases, type IntegrityPayload,
  type Verified } from "./google";
import { d1Store, usagePeriod, type Account, type Bucket, type Grant, type ModelChoice, type Store, type Sub } from "./store";

export interface Env {
  DB: D1Database;
  OPENROUTER_KEY: string;
  FREE_SECONDS_PER_MONTH: string;
  /** The JSON key of the Google service account that may read this app's Play orders. */
  GOOGLE_SERVICE_ACCOUNT?: string;
  /** The secret device tokens are made with (HMAC of the device ID). */
  DEVICE_TOKEN_SECRET?: string;
  /** "true" once every call must carry a device token from /v1/register. */
  REQUIRE_INTEGRITY?: string;
  /**
   * Optional second OpenRouter key, with its own limit on openrouter.ai, for phones whose subscription pays
   * now (review, 2026-11-25): with one key for everyone, free or given use that reaches the key's limit
   * stops paying subscribers too. Unset: every call uses OPENROUTER_KEY, as before.
   */
  OPENROUTER_PAID_KEY?: string;
  /** Optional: the longest recording one call may send, in seconds of audio, estimated from its size. Unset: no limit. */
  MAX_RECORDING_SECONDS?: string;
  /** Optional rate limits (wrangler.jsonc "ratelimits"): recordings and purchases per phone, phone checks per address. */
  DEVICE_LIMITER?: RateLimit;
  ADDRESS_LIMITER?: RateLimit;
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
 * Lets Android open access links in the app without asking (developer.android.com/training/app-links):
 * the Play signing key (Play Console, App signing) and the debug key the GitHub builds are signed with.
 */
export const ASSET_LINKS = [{
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: PACKAGE, sha256_cert_fingerprints: [
    "BC:1E:48:02:CE:65:93:3E:45:B8:C8:91:E6:35:48:1D:96:EE:A8:9E:DD:97:7D:1D:4A:6F:EA:D3:94:3F:2C:ED",
    "90:79:A6:C7:E6:E9:72:77:33:3F:A5:92:8B:24:73:F6:F4:0F:00:22:FD:AF:50:14:CC:3D:25:F4:56:F5:BE:1A",
  ] },
}];

/** True while a grant has time left this month (unlimited always does). */
export function grantLeft(g: Grant | null): boolean {
  return !!g && (g.seconds == null || g.used < g.seconds);
}

/**
 * An access code as typed: letters and digits only, any case, dashes and spaces ignored. Null when it
 * can't be one (codes are 12 letters and digits, made by the Access page).
 */
export function accessCode(raw: string | null | undefined): string | null {
  const c = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 12 ? c : null;
}

/**
 * Play keeps a subscription ACTIVE for at least a day after a renewal fails (its "silent grace
 * period") and says to ask again after those 24 hours
 * (developer.android.com/google/play/billing/lifecycle/subscriptions, Silent grace period).
 */
export const SILENT_GRACE_MS = 24 * 3600_000;

/** States Google can still turn back into a paid subscription without a new purchase. */
const MAY_RECOVER = ["ACTIVE", "IN_GRACE_PERIOD", "ON_HOLD", "PAUSED", "PENDING"];

/**
 * States where Google gives no access, whatever the expiry says (developer.android.com/google/play/
 * billing/lifecycle/subscriptions, checked 2026-11-25): revoked or charged back is EXPIRED, "revoke the
 * user's entitlement immediately" (Revocations); account hold, "block access" (Account hold); paused,
 * "the user doesn't have access" (Paused subscriptions); and sign-ups not paid yet.
 */
const NOT_PAID = ["EXPIRED", "ON_HOLD", "PAUSED", "PENDING", "PENDING_PURCHASE_CANCELED"];

/**
 * Whether [sub] pays now: before its expiry, which Google moves forward on each renewal and during
 * the grace period. Also when Google last said ACTIVE or IN_GRACE_PERIOD but its expiry was already
 * behind (a renewal still being charged, or the silent grace period), for the day Play waits.
 */
export function subscribed(sub: Sub | null | undefined, now: number): boolean {
  if (!sub) return false;
  // Never paid, taken back, on hold or paused: a revoked or charged-back subscription is EXPIRED but
  // can keep its future expiry. Pending sign-ups haven't been paid yet.
  if (NOT_PAID.includes(sub.state ?? "")) return false;
  if (sub.expiry > now) return true;
  // Only when Google's own answer was already past its expiry; otherwise ask again once it passes.
  return (sub.state === "ACTIVE" || sub.state === "IN_GRACE_PERIOD") && sub.checked != null &&
    sub.checked >= sub.expiry && now - sub.checked < SILENT_GRACE_MS;
}

/**
 * Whether to ask Google about [sub] again (bug found 2026-11-25: the server learned of a renewal only
 * when the app was opened, so a subscriber who only uses the mic button was refused after the first
 * month). While it still pays: once a day, because a refund or chargeback ends it at once and nothing
 * else tells this server (the app sends only purchases the phone still owns, and a revoked one isn't).
 * Once it lapsed: once after each expiry, since that is when Google renews it, unless Google already
 * said it pays nothing. After that only while Google said it may still recover (account hold, paused,
 * pending), once a day as Play's silent grace period suggests. Expired, canceled and unknown ones wait
 * for the app to send the purchase again (POST /v1/purchases, on every app start).
 */
export function recheckDue(sub: Sub | null | undefined, now: number): boolean {
  if (!sub) return false;
  const dayOld = sub.checked == null || now - sub.checked >= SILENT_GRACE_MS;
  if (subscribed(sub, now)) return dayOld;
  if (sub.checked == null || (sub.checked < sub.expiry && !NOT_PAID.includes(sub.state ?? ""))) return true;
  return MAY_RECOVER.includes(sub.state ?? "") && dayOld;
}

/**
 * [a] with its subscription as Google says it is now, when it's time to ask (recheckDue). One that
 * still pays is asked through [defer] when given, after the answer went back, so the call is no
 * slower; a refund then counts from the next call.
 */
export async function refreshed(a: Account, env: Env, store: Store, device: string, now: number,
                                fetcher: typeof fetch, defer?: (work: Promise<unknown>) => unknown): Promise<Account> {
  const sub = a.sub;
  const serviceAccount = env.GOOGLE_SERVICE_ACCOUNT;
  if (!sub || !serviceAccount || !recheckDue(sub, now)) return a;
  const paid = subscribed(sub, now);
  const ask = async (): Promise<Sub | null> => {
    let v: Verified;
    try {
      v = await verify(serviceAccount, sub.product, sub.token, true, fetcher, now);
    } catch {
      return null; // Google didn't answer: keep what we know and ask on the next call.
    }
    const next: Sub = v?.kind === "subscription"
      ? { token: sub.token, product: v.product, expiry: v.expiry, state: v.state, checked: now }
      // Google doesn't know the token: a lapsed one is gone; one that still pays keeps its paid month.
      : { token: sub.token, product: sub.product, expiry: sub.expiry, state: paid ? sub.state ?? null : "GONE", checked: now };
    console.log("Subscription re-checked with Google:", next.state, "until", new Date(next.expiry).toISOString());
    await store.saveSubscription(device, next);
    return next;
  };
  if (paid && defer) {
    await defer(ask().catch((e) => console.error("Subscription re-check failed:", e)));
    return a;
  }
  const next = await ask();
  if (!next) return a;
  // A paid renewal is a new paid month, whose hours start unused; a grace period keeps the month before.
  const period = usagePeriod(sub, next);
  return { ...a, sub: { ...next, period, used: period === (sub.period ?? sub.expiry) ? sub.used : 0 } };
}

/**
 * Takes back what is left of a refunded top-up's hours, never below zero (review, 2026-11-25: a refunded,
 * canceled or charged-back top-up kept its 4 hours, since nothing asked Google about it after it was
 * counted). Google lists such purchases in its Voided Purchases API for 30 days (voidedPurchases).
 * While [a] has bought hours left, it is asked at most once a day, after the answer went back, the same
 * as a paid subscription's refund check (recheckDue), so the call is no slower and a refund counts from
 * a later call. One answer covers the top-ups of every phone checked in the last 30 days. Google's list
 * goes back only that far, so this phone's top-ups last checked before then are asked about one by one
 * (review, 2026-11-25: a top-up refunded while no phone with bought hours called for 30 days kept them).
 */
export async function takeBackRefunds(a: Account, env: Env, store: Store, device: string, now: number,
                                      fetcher: typeof fetch, defer?: (work: Promise<unknown>) => unknown): Promise<void> {
  const serviceAccount = env.GOOGLE_SERVICE_ACCOUNT;
  if (!serviceAccount || !(a.credit > 0)) return;
  const work = (async () => {
    const checked = await store.topupsChecked(device);
    if (checked == null || now - checked < SILENT_GRACE_MS) return;
    const voided = await voidedPurchases(serviceAccount, fetcher, now);
    const since = now - VOIDED_WINDOW_MS;
    for (const token of await store.staleTopups(device, since)) {
      if (await productState(serviceAccount, TOPUP, token, fetcher, now) === 1) voided.push(token);
    }
    const taken = await store.takeBackTopups(voided, now, since, device);
    if (taken) console.log("Refunded top-ups, hours left taken back:", taken);
  })().catch((e) => console.error("Top-up refund check failed:", e));
  if (defer) await defer(work); else await work;
}

/**
 * What may pay for the next recording, in the order it pays: hours given on the Access page first (so a
 * gift never uses up the free minutes or paid hours), then this month's free minutes, then the
 * subscription's hours, then bought hours (only while subscribed). Paying phones get the paid models
 * even on free minutes. Empty when nothing is left. With [grantOnly] (no word from Google Play for the
 * phone), only given hours.
 */
export function choices(a: Account, now: number, free: number, grantOnly = false): { bucket: Bucket; paid: boolean }[] {
  const out: { bucket: Bucket; paid: boolean }[] = [];
  // Given hours get the paid models and count like paid hours.
  if (grantLeft(a.grant)) out.push({ bucket: "grant", paid: true });
  if (grantOnly) return out;
  const paying = subscribed(a.sub, now);
  if (a.freeUsed < free) out.push({ bucket: "free", paid: paying });
  if (paying && a.sub!.used < SUB_SECONDS) out.push({ bucket: "sub", paid: true });
  if (paying && a.credit > 0) out.push({ bucket: "credit", paid: true });
  return out;
}

/** What pays for the next recording (the first of choices), or null when nothing is left. */
export function choose(a: Account, now: number, free: number): { bucket: Bucket; paid: boolean } | null {
  return choices(a, now, free)[0] ?? null;
}

/** The most [bucket] holds in plan seconds, for Store.reserve; null for no limit (unlimited hours, bought hours). */
function limitOf(bucket: Bucket, a: Account, free: number): number | null {
  return bucket === "free" ? free : bucket === "grant" ? a.grant?.seconds ?? null : bucket === "sub" ? SUB_SECONDS : null;
}

/** What a phone puts in a recording's body (TranscriberClient.buildBodyJson). */
interface TranscriptionBody {
  model?: unknown; language?: unknown; input_audio?: { data?: unknown; format?: unknown }; provider?: unknown;
}

/**
 * The request OpenRouter gets for [model]: only what the app sends, the audio, its format and language and
 * each provider's verbatim switch (review, 2026-11-25: everything else in the phone's body went on to
 * OpenRouter with the server's key, so a phone could pick OpenRouter's providers and fallbacks, turn on
 * extras that providers charge more for, or add a link for the provider to download audio from).
 */
export function forwardedBody(body: TranscriptionBody, data: string, format: string, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { model, input_audio: { data, format } };
  if (typeof body.language === "string") out.language = body.language;
  const options = styleOptions(body.provider);
  if (options) out.provider = { options };
  return out;
}

/** The app's verbatim switch for each provider (TranscriberClient.styleOptions), each only as the app sends it. */
function styleOptions(provider: unknown): Record<string, unknown> | null {
  const o = (provider as { options?: Record<string, Record<string, unknown> | undefined> } | null)?.options;
  if (!o || typeof o !== "object") return null;
  const out: Record<string, unknown> = {};
  const style = (o.azure?.enhancedMode as { modelOptions?: { transcribeStyle?: unknown } } | undefined)?.modelOptions?.transcribeStyle;
  if (style === "verbatim" || style === "clean") out.azure = { enhancedMode: { modelOptions: { transcribeStyle: style } } };
  if (typeof o.elevenlabs?.no_verbatim === "boolean") out.elevenlabs = { no_verbatim: o.elevenlabs.no_verbatim };
  if (typeof o.deepgram?.filler_words === "boolean") out.deepgram = { filler_words: o.deepgram.filler_words };
  if (typeof o.assemblyai?.disfluencies === "boolean") out.assemblyai = { disfluencies: o.assemblyai.disfluencies };
  return Object.keys(out).length ? out : null;
}

/** The audio formats the app sends: Ogg Opus, and WAV below Android 10 or when a model refuses the Ogg. */
const FORMATS = ["ogg", "wav"];

function error(status: number, message: string, code?: string): Response {
  return Response.json({ error: { message, ...(code ? { code } : {}) } }, { status });
}

/** The answer when nothing is left. The app shows its own message for each code. */
function outOfTime(a: Account, now: number, free: number): Response {
  if (subscribed(a.sub, now)) return error(402, "You've used this month's hours.", "hours_used");
  if (a.grant) return error(402, "You've used this month's hours. They start again on the 1st.", "given_hours_used");
  return error(402, "You've used your " + Math.round(free / 60) + " free minutes this month.", "free_minutes_used");
}

/** A short line of text from the app, for the Failed checks list. */
function short(v: unknown): string {
  return String(v ?? "").slice(0, 120);
}

/**
 * Why the phone got no Play Integrity token, as the app said: Google's error code on the phone
 * (StandardIntegrityErrorCode, a negative number) as "google:<code>", else the app's word ("timeout").
 */
export function failureReason(v: unknown): string {
  return typeof v === "number" || /^-?\d+$/.test(String(v)) ? "google:" + Number(v) : String(v);
}

/** A device ID is the app's hashed Android ID: 64 hex characters. */
function deviceOf(request: Request): string | null {
  const id = request.headers.get("X-Device-Id") ?? "";
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/** Device labels that pass: basic integrity is enough (Isaac, 2026-11-22); the stronger ones include it. */
const DEVICE_LABELS = ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"];

/**
 * Why a decoded Play Integrity verdict doesn't vouch for [device], or null when it does: it must
 * be for this app and this device ID (the request hash), from the build Play distributes, on a
 * phone with at least basic integrity. Google refuses to decode a standard token twice, so an old
 * token can't be replayed, and the request hash ties it to one device ID.
 */
export function integrityProblem(p: IntegrityPayload | null, device: string): string | null {
  if (!p) return "token not readable";
  if (p.requestDetails?.requestPackageName !== PACKAGE) return "package " + p.requestDetails?.requestPackageName;
  if (p.requestDetails?.requestHash !== device) return "request hash doesn't match";
  if (p.appIntegrity?.appRecognitionVerdict !== "PLAY_RECOGNIZED") return "app " + p.appIntegrity?.appRecognitionVerdict;
  if (p.appIntegrity?.packageName !== PACKAGE) return "app package " + p.appIntegrity?.packageName;
  const labels = p.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!labels.some((l) => DEVICE_LABELS.includes(l))) return "device " + (labels.join(",") || "none");
  return null;
}

function hmacKey(secret: string, use: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);
}

/** The device token for [device]: hex HMAC-SHA256 of the ID with DEVICE_TOKEN_SECRET. */
export async function deviceToken(secret: string, device: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(device));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tokenMatches(secret: string, device: string, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const mac = Uint8Array.from(token.match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, new TextEncoder().encode(device));
}

/** The answer when a call doesn't carry a valid device token, or null when it may go on. */
async function unverified(request: Request, env: Env, device: string): Promise<Response | null> {
  if (env.REQUIRE_INTEGRITY !== "true") return null;
  const token = request.headers.get("X-Device-Token");
  // Apps from before 0.9.11 send no token; they show this message as it is.
  if (!token) return error(426, "Update Word for Word from Google Play to keep using free minutes.", "device_unverified");
  if (!env.DEVICE_TOKEN_SECRET || !await tokenMatches(env.DEVICE_TOKEN_SECRET, device, token)) {
    return error(403, "Google Play couldn't confirm this phone. Free minutes work only in Word for Word from Google Play.", "device_unverified");
  }
  return null;
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
  const post = request.method === "POST";

  // Optional rate limits, before any database read or call to Google or OpenRouter. The phone check takes
  // anyone, so it counts per address; the others per phone.
  const limit = url.pathname === "/v1/register" && post
    ? { by: env.ADDRESS_LIMITER, key: "register:" + (request.headers.get("CF-Connecting-IP") ?? "") }
    : (url.pathname === "/v1/transcriptions" || url.pathname === "/v1/purchases") && post && device
    ? { by: env.DEVICE_LIMITER, key: "phone:" + device } : null;
  if (limit?.by && !(await limit.by.limit({ key: limit.key })).success) {
    return error(429, "Too many requests right now. Wait a moment and try again.", "rate_limited");
  }

  if (url.pathname === "/v1/register" && post) {
    if (!device) return error(400, "Missing device ID.");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const token = body.integrity_token;
    // What the phone is, for the Failed checks list. Anyone can send this; it gives nothing by itself.
    const failed = (reason: string) => store.failedCheck(device, { model: short(body.model), android: short(body.android),
      app_version: short(body.app_version), reason: short(reason) }, now.getTime());
    if (typeof token !== "string" || token.length === 0) {
      if (body.integrity_error != null) await failed(failureReason(body.integrity_error));
      return error(400, "Missing integrity token.", "no_play_token");
    }
    if (!env.GOOGLE_SERVICE_ACCOUNT || !env.DEVICE_TOKEN_SECRET) return error(503, "Phones can't be checked right now.");
    let payload: IntegrityPayload | null;
    try {
      payload = await decodeIntegrity(env.GOOGLE_SERVICE_ACCOUNT, token, fetcher, now.getTime());
    } catch {
      return error(503, "Google Play didn't answer. Try again.");
    }
    const problem = integrityProblem(payload, device);
    if (problem) {
      console.warn("Play Integrity refused a phone:", problem);
      await failed("refused:" + problem);
      return error(403, "Google Play couldn't confirm this phone. Free minutes work only in Word for Word from Google Play.", "device_unverified");
    }
    await store.passedCheck(device);
    return Response.json({ device_token: await deviceToken(env.DEVICE_TOKEN_SECRET, device) });
  }

  if (url.pathname === "/.well-known/assetlinks.json") return Response.json(ASSET_LINKS);

  const code = accessCode(request.headers.get("X-Access-Code"));
  // Loaded before the device check: a valid access code stands in for a device token.
  let account = device && ["/v1/usage", "/v1/purchases", "/v1/transcriptions"].includes(url.pathname)
    ? await store.account(device, month, code) : null;
  // Without a device token, given hours (a code's or the phone's own) still work, but only they do.
  let grantOnly = false;
  if (device && account) {
    const refused = await unverified(request, env, device);
    if (refused && !account.grant) return refused;
    grantOnly = !!refused;
    // A lapsed subscription may have renewed since, and a paid one or a top-up may have been refunded.
    // Not for /v1/purchases, which asks Google itself.
    if (!grantOnly && url.pathname !== "/v1/purchases") {
      account = await refreshed(account, env, store, device, now.getTime(), fetcher, later);
      await takeBackRefunds(account, env, store, device, now.getTime(), fetcher, later);
    }
  }
  const pickFor = (a: Account) => choices(a, now.getTime(), free, grantOnly)[0] ?? null;

  if (url.pathname === "/v1/usage" && request.method === "GET") {
    if (!device || !account) return error(400, "Missing device ID.");
    const a = account, g = a.grant;
    return Response.json({ used_seconds: a.freeUsed, free_seconds: free, month,
      subscribed: subscribed(a.sub, now.getTime()), out: !pickFor(a),
      // The hours given to this code; null when the call had no code or the code was removed (the app then
      // forgets it), so hours given to the phone itself don't show here.
      access: g && !g.device ? { who: g.who, seconds: g.seconds, used_seconds: g.used } : null });
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
    const notPaid = () => error(402, "Google Play doesn't show this purchase as paid.", "not_paid");
    if (!v) return notPaid();
    if (v.kind === "subscription") {
      const sub: Sub = { token, product: v.product, expiry: v.expiry, state: v.state, checked: now.getTime() };
      if (!subscribed(sub, now.getTime())) return notPaid();
      await store.saveSubscription(device, sub);
    } else await store.addTopup(token, device, TOPUP_SECONDS, now.getTime());
    const a = await store.account(device, month, code);
    return Response.json({ subscribed: subscribed(a.sub, now.getTime()), out: !pickFor(a) });
  }

  if (url.pathname !== "/v1/transcriptions" || request.method !== "POST") return error(404, "Not found.");
  if (!device) return error(400, "Missing device ID.");

  let body: TranscriptionBody;
  try {
    body = await request.json();
  } catch {
    return error(400, "The request isn't valid JSON.");
  }
  const audio = body.input_audio?.data;
  if (typeof audio !== "string" || audio.length === 0) return error(400, "No audio in the request.");
  const format = body.input_audio?.format ?? "wav";
  if (typeof format !== "string" || !FORMATS.includes(format)) return error(400, "Unsupported audio format.");
  // The recording's length from its size, before anything is sent; what OpenRouter measures replaces it afterwards.
  const estimate = audioSeconds("", audio, format);
  const longest = Number(env.MAX_RECORDING_SECONDS);
  if (env.MAX_RECORDING_SECONDS && Number.isFinite(longest) && estimate > longest) {
    return error(413, "That recording is too long to send in one piece. Try a shorter one.", "too_long");
  }

  const a = account ?? await store.account(device, month, code);
  // Holds the estimate on what pays, in one statement that refuses once nothing is left, before the audio goes
  // out (review, 2026-11-25: the time was only checked before and counted after, so many recordings sent at
  // once on a phone's, a code's or a subscription's last second were all typed and paid for by Isaac).
  let pick: { bucket: Bucket; paid: boolean } | null = null;
  for (const p of choices(a, now.getTime(), free, grantOnly)) {
    if (await store.reserve(device, month, p.bucket, estimate, limitOf(p.bucket, a, free), a.sub, a.grant)) { pick = p; break; }
  }
  if (!pick) return outOfTime(a, now.getTime(), free);

  const key = env.OPENROUTER_PAID_KEY && !grantOnly && subscribed(a.sub, now.getTime()) ? env.OPENROUTER_PAID_KEY : env.OPENROUTER_KEY;
  const send = (b: object) => fetcher(OPENROUTER_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "Word for Word" },
    body: JSON.stringify(b),
  });

  // The main model, then each backup when the one before is missing, busy or down.
  let status = 502, text = JSON.stringify({ error: { message: "No model answered." } }), used: ModelChoice | null = null;
  try {
    for (const model of pick.paid ? a.models.paid : a.models.free) {
      let b = forwardedBody(body, audio, format, model.id);
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
  } catch (e) {
    console.error("OpenRouter couldn't be reached:", e instanceof Error ? e.message : String(e));
    status = 502;
    text = JSON.stringify({ error: { message: "No model answered." } });
  }

  // Only audio that came back as text counts: the estimate held becomes what OpenRouter measured, or is
  // given back. Saved after the answer goes back.
  const typed = status >= 200 && status < 300 && used;
  const charged = typed ? planSeconds(text, audio, format, used!, pick.bucket === "free" ? FREE_BASE_PER_HOUR : PAID_BASE_PER_HOUR) : 0;
  // Bought hours held below zero end at zero (charge's floor) even when the estimate was exact.
  if (charged !== estimate || pick.bucket === "credit") {
    await later(store.charge(device, month, pick.bucket, charged - estimate, a.sub, a.grant));
  }
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...(used ? { "X-Model": used.id } : {}) } });
}

/** How many plan seconds a second of Yiddish audio counts for (AGENTS.local.md). */
export const YIDDISH_WEIGHT = 2;

export type CheckAnswer = { ok: true } | { ok: false; status: number; code: string; message: string };

/**
 * Whether the app's Yiddish take may go to the Yiddish model (Isaac, 2026-11-24: "I don't want
 * everyone to be able to do that"). The model doesn't run on the person's OpenRouter key, so a
 * typed key changes nothing: every take needs a phone Google Play vouched for (a device token,
 * whatever REQUIRE_INTEGRITY says) with time left in the same free minutes and hours as
 * everything else. Builds not from Google Play never get a token, so they get Yiddish only with an
 * access code ([rawCode], from the Access page), which also stands in for the token.
 */
export async function yiddishCheck(env: Env, store: Store, device: unknown, token: unknown,
                                   now = new Date(), rawCode: unknown = null,
                                   fetcher: typeof fetch = fetch,
                                   defer?: (work: Promise<unknown>) => unknown): Promise<CheckAnswer> {
  if (typeof device !== "string" || !/^[0-9a-f]{64}$/.test(device)) {
    return { ok: false, status: 400, code: "no_device", message: "Missing device ID." };
  }
  const free = Number(env.FREE_SECONDS_PER_MONTH);
  let a = await store.account(device, monthOf(now), accessCode(typeof rawCode === "string" ? rawCode : null));
  const vouched = typeof token === "string" && !!env.DEVICE_TOKEN_SECRET && await tokenMatches(env.DEVICE_TOKEN_SECRET, device, token);
  if (vouched) {
    a = await refreshed(a, env, store, device, now.getTime(), fetcher, defer);
    await takeBackRefunds(a, env, store, device, now.getTime(), fetcher, defer);
  }
  if (!vouched && !a.grant) {
    return { ok: false, status: 403, code: "device_unverified", message: "Google Play couldn't confirm this phone." };
  }
  // Without Google Play's word for the phone, only the given hours count, not its free minutes.
  if (vouched ? choose(a, now.getTime(), free) : grantLeft(a.grant)) return { ok: true };
  const out = await outOfTime(a, now.getTime(), free).json() as { error: { message: string; code: string } };
  return { ok: false, status: 402, code: out.error.code, message: out.error.message };
}

/** Counts [seconds] of audio the Yiddish model typed, at YIDDISH_WEIGHT, on whatever pays next. */
export async function yiddishCharge(env: Env, store: Store, device: unknown, seconds: unknown,
                                    now = new Date(), rawCode: unknown = null): Promise<void> {
  if (typeof device !== "string" || !/^[0-9a-f]{64}$/.test(device)) return;
  if (typeof seconds !== "number" || !(seconds > 0)) return;
  const month = monthOf(now);
  const a = await store.account(device, month, accessCode(typeof rawCode === "string" ? rawCode : null));
  const pick = choose(a, now.getTime(), Number(env.FREE_SECONDS_PER_MONTH));
  // Nothing left now: the take was allowed when it started, so it still counts.
  const bucket = pick?.bucket ?? (a.grant ? "grant" : subscribed(a.sub, now.getTime()) ? "sub" : "free");
  await store.charge(device, month, bucket, seconds * YIDDISH_WEIGHT, a.sub, a.grant);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, d1Store(env.DB), new Date(), fetch, p => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Env>;
