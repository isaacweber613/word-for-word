import { describe, expect, it } from "vitest";
import {
  accessCode, audioLength, audioSeconds, choose, deviceToken, handle, integrityProblem, monthOf, planSeconds, SUB_SECONDS, TOPUP_SECONDS,
  yiddishCharge, yiddishCheck, type Env,
} from "../src/index";
import { oggOpus, wav } from "./audio";
import { sqliteD1 } from "./sqlite-d1";
import { d1Store, DEFAULT_MODELS, usagePeriod, type Account, type Bucket, type FailedCheck, type Grant, type Models, type Store, type Sub } from "../src/store";

const device = "a".repeat(64);
const env = { OPENROUTER_KEY: "test-key", FREE_SECONDS_PER_MONTH: "1800" } as Env;
const now = new Date("2026-11-06T12:00:00Z");
const later = now.getTime() + 20 * 86400_000;

/** The D1 store in memory. */
function memoryStore(init: Partial<{ free: number; models: Models; sub: Sub | null; subUsed: number; credit: number;
                                    grant: { code: string; who: string; seconds: number | null; used?: number; device?: string };
                                    topups: { token: string; seconds: number; created: number }[] }> = {}) {
  const s = {
    free: init.free ?? 0, models: init.models ?? DEFAULT_MODELS, sub: init.sub ?? null,
    subUsed: init.subUsed ?? 0, credit: init.credit ?? 0,
    // Counted top-ups (table topups): their hours, when counted, last checked for a refund, refunded.
    topups: new Map((init.topups ?? []).map((t) => [t.token,
      { seconds: t.seconds, created: t.created, checked: null as number | null, voided: null as number | null }])),
    grant: init.grant ? { used: 0, ...init.grant } : null,
    // Plan seconds per paid month (subscription_usage), keyed like the D1 store.
    usage: new Map<number, number>(init.sub ? [[init.sub.period ?? init.sub.expiry, init.subUsed ?? 0]] : []),
    failed: new Map<string, FailedCheck & { count: number }>(),
  };
  const store: Store = {
    async account(d, _m, code): Promise<Account> {
      const g: Grant | null = s.grant && (code === s.grant.code || d === s.grant.device)
        ? { id: 1, who: s.grant.who, seconds: s.grant.seconds, used: s.grant.used, device: s.grant.device ?? null } : null;
      return { freeUsed: s.free, grant: g, models: s.models, sub: s.sub ? { ...s.sub, used: s.usage.get(s.sub.period ?? s.sub.expiry) ?? 0 } : null, credit: s.credit };
    },
    async reserve(_d, _m, bucket: Bucket, seconds, limit, sub) {
      if (bucket === "grant") {
        if (!s.grant || (limit != null && s.grant.used >= limit)) return false;
        s.grant.used += seconds;
      } else if (bucket === "free") {
        if (s.free >= limit!) return false;
        s.free += seconds;
      } else if (bucket === "sub") {
        const k = sub!.period ?? sub!.expiry;
        if ((s.usage.get(k) ?? 0) >= limit!) return false;
        s.usage.set(k, (s.usage.get(k) ?? 0) + seconds);
        s.subUsed += seconds;
      } else {
        if (!(s.credit > 0)) return false;
        s.credit -= seconds; // may go below zero while held, as in D1; charge settles it
      }
      return true;
    },
    async charge(_d, _m, bucket: Bucket, seconds, sub) {
      if (bucket === "sub" && sub) s.usage.set(sub.period ?? sub.expiry, (s.usage.get(sub.period ?? sub.expiry) ?? 0) + seconds);
      if (bucket === "grant") s.grant!.used += seconds;
      else if (bucket === "free") s.free += seconds;
      else if (bucket === "sub") s.subUsed += seconds;
      else s.credit -= seconds;   // may stay below zero, as in D1; a top-up counts from zero
    },
    async saveSubscription(_d, sub) { s.sub = { ...sub, period: usagePeriod(s.sub?.token === sub.token ? s.sub : null, sub) }; },
    async addTopup(token, _d, seconds, at) {
      if (s.topups.has(token)) return false;
      s.topups.set(token, { seconds, created: at, checked: null, voided: null }); s.credit = Math.max(0, s.credit) + seconds; return true;
    },
    async topupsChecked() {
      const counted = [...s.topups.values()].filter((t) => t.voided == null);
      return counted.length ? Math.min(...counted.map((t) => t.checked ?? t.created)) : null;
    },
    async staleTopups(_d, before) {
      return [...s.topups].filter(([, t]) => t.voided == null && (t.checked ?? t.created) < before).map(([token]) => token);
    },
    async takeBackTopups(voided, at) {
      // Every top-up here is the one phone's, which the real store marks checked whatever Google's list covered.
      let taken = 0;
      for (const token of voided) {
        const t = s.topups.get(token);
        if (!t || t.voided != null) continue;
        // What is left of this top-up itself, the oldest bought hours used first, as in D1.
        const after = [...s.topups.values()].filter((o) => o !== t && o.voided == null && o.created > t.created)
          .reduce((n, o) => n + o.seconds, 0);
        s.credit -= Math.min(t.seconds, Math.max(0, s.credit - after));
        t.voided = at;
        taken++;
      }
      for (const t of s.topups.values()) if (t.voided == null) t.checked = at;
      return taken;
    },
    async failedCheck(d, r) { s.failed.set(d, { ...r, count: (s.failed.get(d)?.count ?? 0) + 1 }); },
    async passedCheck(d) { if (s.grant?.device !== d) s.failed.delete(d); },
    // Yiddish holds run on the real tables only (local.test.ts).
    holdTake: () => { throw new Error("not in the memory store"); },
    settleTake: () => { throw new Error("not in the memory store"); },
    releaseTake: () => { throw new Error("not in the memory store"); },
    refundJob: () => { throw new Error("not in the memory store"); },
  };
  return { s, store };
}

/** A base64 WAV body of [seconds] of audio, as the app sends it (WavWriter). */
function audio(seconds: number): string {
  return wav(seconds).toString("base64");
}

function transcribe(seconds: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = { "X-Device-Id": device }) {
  return new Request("https://example.com/v1/transcriptions", {
    method: "POST", headers,
    body: JSON.stringify({ model: "microsoft/mai-transcribe-2", input_audio: { data: audio(seconds), format: "wav" }, ...extra }),
  });
}

const ok = (async () => Response.json({ text: "hello" })) as unknown as typeof fetch;

describe("transcription server", () => {
  it("measures audio length from the WAV", () => {
    expect(audioLength(audio(10), "wav")).toBeCloseTo(10, 5);
  });

  it("measures Ogg Opus by its packets, whatever its size", () => {
    expect(audioLength(oggOpus(10).toString("base64"), "ogg")).toBeCloseTo(10, 5);
    expect(audioLength(oggOpus(10, 1).toString("base64"), "ogg")).toBeCloseTo(10, 5);
    expect(audioLength(oggOpus(10, 300).toString("base64"), "ogg")).toBeCloseTo(10, 5);   // packets over a lacing value
    expect(audioLength(oggOpus(10).toString("base64"), "wav")).toBeNull();
    expect(audioLength(wav(10, 8000).toString("base64"), "wav")).toBeNull();
    expect(audioLength(" " + audio(10), "wav")).toBeNull();
  });

  it("counts compressed audio by the seconds OpenRouter reports", () => {
    expect(audioSeconds(JSON.stringify({ text: "hi", usage: { seconds: 13.74 } }), 1)).toBe(13.74);
  });

  it("counts the recording's own length when OpenRouter reports no seconds", () => {
    expect(audioSeconds(JSON.stringify({ text: "hi" }), 10)).toBe(10);
  });

  it("counts plan seconds by what OpenRouter charged, at $0.10 an hour", () => {
    // 12 s at $0.10/h costs $0.000333: 12 plan seconds. The same 12 s at $0.54/h: 64.8.
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 12, cost: 12 * 0.1 / 3600 } }), 0,
      { id: "x", per_hour: 0.1 })).toBeCloseTo(12, 5);
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 12, cost: 12 * 0.54 / 3600 } }), 0,
      { id: "x", per_hour: 0.54 })).toBeCloseTo(64.8, 5);
  });

  it("counts paid hours 1:1 up to $0.15 an hour, faster above it", () => {
    const at = (perHour: number) => planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 12, cost: 12 * perHour / 3600 } }),
      0, { id: "x", per_hour: perHour }, 0.15);
    expect(at(0.06)).toBeCloseTo(12, 5);
    expect(at(0.15)).toBeCloseTo(12, 5);
    expect(at(0.27)).toBeCloseTo(21.6, 5);
  });

  it("uses the model's price when OpenRouter reports no cost, never less than one second a second", () => {
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 10 } }), 0, { id: "x", per_hour: 0.27 })).toBeCloseTo(27, 5);
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 10 } }), 0, { id: "x", per_hour: 0.06 })).toBeCloseTo(10, 5);
  });

  it("names months in UTC", () => {
    expect(monthOf(now)).toBe("2026-11");
  });

  it("passes audio to OpenRouter with the server's key and the picked model, and counts the seconds", async () => {
    const { s, store } = memoryStore({ models: { free: [{ id: "nvidia/nemotron-3.5-transcribe", per_hour: 0.06 }], paid: [] } });
    let sentKey = "", sentModel = "";
    const fetcher = (async (_u: string, init: RequestInit) => {
      sentKey = (init.headers as Record<string, string>)["Authorization"];
      sentModel = JSON.parse(init.body as string).model;
      return Response.json({ text: "hello" });
    }) as unknown as typeof fetch;
    const res = await handle(transcribe(12), env, store, now, fetcher);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Model")).toBe("nvidia/nemotron-3.5-transcribe");
    expect(await res.json()).toEqual({ text: "hello" });
    expect(sentKey).toBe("Bearer test-key");
    expect(sentModel).toBe("nvidia/nemotron-3.5-transcribe");
    expect(s.free).toBeCloseTo(12, 5);
  });

  it("tries the backups in order when a model is down, and not after other errors", async () => {
    const tried: string[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      const m = JSON.parse(init.body as string).model;
      tried.push(m);
      return m === "c" ? Response.json({ text: "hi" }) : Response.json({ error: { message: "busy" } }, { status: 503 });
    }) as unknown as typeof fetch;
    const models = { free: [{ id: "a", per_hour: 0.1 }, { id: "b", per_hour: 0.1 }, { id: "c", per_hour: 0.1 }], paid: [] };
    const res = await handle(transcribe(5), env, memoryStore({ models }).store, now, fetcher);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Model")).toBe("c");
    expect(tried).toEqual(["a", "b", "c"]);

    tried.length = 0;
    const tooBig = (async (_u: string, init: RequestInit) => {
      tried.push(JSON.parse(init.body as string).model);
      return Response.json({ error: { message: "too large" } }, { status: 413 });
    }) as unknown as typeof fetch;
    expect((await handle(transcribe(5), env, memoryStore({ models }).store, now, tooBig)).status).toBe(413);
    expect(tried).toEqual(["a"]);
  });

  it("sends again without the language when a model refuses it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      bodies.push(b);
      return "language" in b ? Response.json({ error: { message: "bad language" } }, { status: 400 }) : Response.json({ text: "hi" });
    }) as unknown as typeof fetch;
    const res = await handle(transcribe(5, { language: "yi" }), env, memoryStore().store, now, fetcher);
    expect(res.status).toBe(200);
    expect(bodies.map((b) => "language" in b)).toEqual([true, false]);
  });

  it("stops at the free minutes without a subscription", async () => {
    const res = await handle(transcribe(5), env, memoryStore({ free: 1800 }).store, now, ok);
    expect(res.status).toBe(402);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("free_minutes_used");
  });

  it("gives subscribers the paid models, then their hours, then bought hours", async () => {
    const sub = { token: "t", product: "monthly", expiry: later };
    const models = { free: [{ id: "free-model", per_hour: 0.1 }], paid: [{ id: "paid-model", per_hour: 0.1 }] };
    let sent = "";
    const fetcher = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string).model;
      return Response.json({ text: "hi", usage: { seconds: 10, cost: 10 * 0.1 / 3600 } });
    }) as unknown as typeof fetch;

    const a = memoryStore({ free: 1800, sub, models });
    expect((await handle(transcribe(10), env, a.store, now, fetcher)).status).toBe(200);
    expect(sent).toBe("paid-model");
    expect(a.s.subUsed).toBeCloseTo(10, 5);

    const b = memoryStore({ free: 1800, sub, subUsed: SUB_SECONDS, credit: 100, models });
    expect((await handle(transcribe(10), env, b.store, now, fetcher)).status).toBe(200);
    expect(b.s.credit).toBeCloseTo(90, 5);

    const c = memoryStore({ free: 1800, sub, subUsed: SUB_SECONDS, models });
    const res = await handle(transcribe(10), env, c.store, now, fetcher);
    expect(res.status).toBe(402);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("hours_used");
  });

  it("doesn't let bought hours work without an active subscription", () => {
    const expired = { token: "t", product: "monthly", expiry: now.getTime() - 1, used: 0 };
    expect(choose({ freeUsed: 1800, grant: null, models: DEFAULT_MODELS, sub: expired, credit: 9999 }, now.getTime(), 1800)).toBeNull();
    expect(choose({ freeUsed: 1800, grant: null, models: DEFAULT_MODELS, sub: null, credit: 9999 }, now.getTime(), 1800)).toBeNull();
  });

  it("doesn't count audio no model could type", async () => {
    const { s, store } = memoryStore();
    const failing = (async () => Response.json({ error: { message: "busy" } }, { status: 503 })) as unknown as typeof fetch;
    const res = await handle(transcribe(5), env, store, now, failing);
    expect(res.status).toBe(503);
    expect(s.free).toBe(0);
  });

  it("lets a Yiddish take through only with a device token and time left, whatever REQUIRE_INTEGRITY says", async () => {
    const e = { ...env, DEVICE_TOKEN_SECRET: "s" } as Env;
    const token = await deviceToken("s", device);
    expect(await yiddishCheck(e, memoryStore().store, device, token, now)).toEqual({ ok: true });
    // A made-up phone (or any key typed in the app) without a token from Google Play: refused.
    expect(await yiddishCheck(e, memoryStore().store, device, null, now)).toMatchObject({ ok: false, status: 403, code: "device_unverified" });
    expect(await yiddishCheck(e, memoryStore().store, device, "b".repeat(64), now)).toMatchObject({ ok: false, status: 403 });
    expect(await yiddishCheck(e, memoryStore().store, "made-up", token, now)).toMatchObject({ ok: false, status: 400 });
    // No time left: the same answer as a normal recording.
    expect(await yiddishCheck(e, memoryStore({ free: 1800 }).store, device, token, now))
      .toMatchObject({ ok: false, status: 402, code: "free_minutes_used" });
    const subscribed = memoryStore({ free: 1800, sub: { token: "t", product: "monthly", expiry: later }, subUsed: SUB_SECONDS });
    expect(await yiddishCheck(e, subscribed.store, device, token, now)).toMatchObject({ ok: false, status: 402, code: "hours_used" });
  });

  it("counts a Yiddish take twice its length on whatever pays next", async () => {
    const { s, store } = memoryStore();
    await yiddishCharge(env, store, device, 30, now);
    expect(s.free).toBe(60);
    const sub = memoryStore({ free: 1800, sub: { token: "t", product: "monthly", expiry: later } });
    await yiddishCharge(env, sub.store, device, 30, now);
    expect(sub.s.subUsed).toBe(60);
    // Allowed when it started but nothing left by the end: still counted.
    const out = memoryStore({ free: 1800 });
    await yiddishCharge(env, out.store, device, 30, now);
    expect(out.s.free).toBe(1860);
  });

  it("needs a device ID", async () => {
    const res = await handle(transcribe(5, {}, {}), env, memoryStore().store, now, ok);
    expect(res.status).toBe(400);
  });

  it("reports usage", async () => {
    const res = await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }),
      env, memoryStore({ free: 90 }).store, now, ok);
    expect(await res.json()).toEqual({ used_seconds: 90, free_seconds: 1800, month: "2026-11", subscribed: false, out: false, access: null });
  });

  it("checks a top-up with Google once and adds its hours once", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({ client_email: "x@y", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const urls: string[] = [];
    const google = (async (u: string) => {
      urls.push(u);
      if (u.includes("oauth2")) return Response.json({ access_token: "a", expires_in: 3600 });
      return Response.json({ purchaseState: 0 });
    }) as unknown as typeof fetch;
    const { s, store } = memoryStore();
    const buy = () => new Request("https://example.com/v1/purchases", {
      method: "POST", headers: { "X-Device-Id": device }, body: JSON.stringify({ product_id: "extra_hours_4", purchase_token: "tok" }),
    });
    expect((await handle(buy(), { ...env, GOOGLE_SERVICE_ACCOUNT: sa }, store, now, google)).status).toBe(200);
    expect((await handle(buy(), { ...env, GOOGLE_SERVICE_ACCOUNT: sa }, store, now, google)).status).toBe(200);
    expect(s.credit).toBe(TOPUP_SECONDS);
    expect(urls.some((u) => u.includes("/purchases/products/extra_hours_4/tokens/tok"))).toBe(true);
  });

  it("links an active subscription to the phone", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({ client_email: "x@y", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const google = (async (u: string) => u.includes("oauth2")
      ? Response.json({ access_token: "a", expires_in: 3600 })
      : Response.json({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          lineItems: [{ productId: "monthly", expiryTime: new Date(later).toISOString() }] })) as unknown as typeof fetch;
    const { s, store } = memoryStore({ free: 1800 });
    const res = await handle(new Request("https://example.com/v1/purchases", {
      method: "POST", headers: { "X-Device-Id": device }, body: JSON.stringify({ product_id: "monthly", purchase_token: "sub" }),
    }), { ...env, GOOGLE_SERVICE_ACCOUNT: sa }, store, now, google);
    expect(await res.json()).toEqual({ subscribed: true, out: false });
    expect(s.sub).toEqual({ token: "sub", product: "monthly", expiry: later, state: "ACTIVE", checked: now.getTime(), period: later });
  });

  it("refuses a refunded or unpaid subscription even when its expiry is still ahead", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({ client_email: "x@y", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    for (const state of ["EXPIRED", "PENDING", "PENDING_PURCHASE_CANCELED"]) {
      const google = (async (u: string) => u.includes("oauth2")
        ? Response.json({ access_token: "a", expires_in: 3600 })
        : Response.json({ subscriptionState: "SUBSCRIPTION_STATE_" + state,
            lineItems: [{ productId: "monthly", expiryTime: new Date(later).toISOString() }] })) as unknown as typeof fetch;
      const { s, store } = memoryStore({ free: 1800 });
      const res = await handle(new Request("https://example.com/v1/purchases", {
        method: "POST", headers: { "X-Device-Id": device }, body: JSON.stringify({ product_id: "monthly", purchase_token: "sub" }),
      }), { ...env, GOOGLE_SERVICE_ACCOUNT: sa }, store, now, google);
      expect(res.status).toBe(402);
      expect(s.sub).toBeNull();
    }
    expect(choose({ freeUsed: 1800, grant: null, models: DEFAULT_MODELS, credit: 0,
      sub: { token: "t", product: "monthly", expiry: later, state: "EXPIRED", checked: now.getTime(), used: 0 } }, now.getTime(), 1800)).toBeNull();
  });

  const DAY = 24 * 3600_000;
  /** Google's Play API answering [state] and [expiry] for every subscription (410 when [expiry] is null). */
  async function googleSays(state: string, expiry: number | null) {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({ client_email: "x@y", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const asked: string[] = [];
    const fetcher = (async (u: string) => {
      if (u.includes("oauth2")) return Response.json({ access_token: "a", expires_in: 3600 });
      if (u.includes("subscriptionsv2")) {
        asked.push(u);
        if (expiry == null) return new Response("gone", { status: 410 });
        return Response.json({ subscriptionState: "SUBSCRIPTION_STATE_" + state,
          lineItems: [{ productId: "monthly", expiryTime: new Date(expiry).toISOString() }] });
      }
      return Response.json({ text: "hello", usage: { seconds: 10 } });
    }) as unknown as typeof fetch;
    return { e: { ...env, GOOGLE_SERVICE_ACCOUNT: sa }, fetcher, asked };
  }

  describe("a subscription that still looks paid in the database", () => {
    const paid = { token: "sub", product: "monthly", expiry: later, state: "ACTIVE" };

    it("notices a refund or chargeback within a day, without slowing the call", async () => {
      // Revoked: Google says EXPIRED and may keep the future expiry. The app never sends a revoked purchase again.
      const g = await googleSays("EXPIRED", later);
      const { s, store } = memoryStore({ free: 1800, sub: { ...paid, checked: now.getTime() - DAY } });
      const deferred: Promise<unknown>[] = [];
      const first = await handle(transcribe(10), g.e, store, now, g.fetcher, (p) => { deferred.push(p); });
      expect(first.status).toBe(200); // served on what was known; Google is asked after the answer
      await Promise.all(deferred);
      expect(g.asked).toHaveLength(1);
      expect(s.sub).toMatchObject({ state: "EXPIRED", checked: now.getTime() });
      const second = await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(second.status).toBe(402);
      expect(g.asked).toHaveLength(1); // and not asked again on every call
    });

    it("asks at most once a day while it pays", async () => {
      const g = await googleSays("ACTIVE", later);
      const { s, store } = memoryStore({ free: 1800, sub: { ...paid, checked: now.getTime() - DAY + 60_000 } });
      expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(200);
      expect(g.asked).toHaveLength(0);
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + 60_000), g.fetcher);
      expect(g.asked).toHaveLength(1);
      expect(s.sub).toMatchObject({ state: "ACTIVE", checked: now.getTime() + 60_000, period: later });
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + 2 * 60_000), g.fetcher);
      expect(g.asked).toHaveLength(1);
    });

    it("keeps serving a paid month when Google doesn't know the token, and asks again a day later", async () => {
      const g = await googleSays("", null);
      const { s, store } = memoryStore({ free: 1800, sub: { ...paid, checked: now.getTime() - DAY } });
      await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(s.sub).toMatchObject({ state: "ACTIVE", expiry: later, checked: now.getTime() });
      expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(200);
      expect(g.asked).toHaveLength(1);
    });

    it("never serves account hold, a pause or an unpaid sign-up, whatever the expiry, and asks about them once a day", async () => {
      for (const state of ["ON_HOLD", "PAUSED", "PENDING"]) {
        const g = await googleSays(state, later);
        const { store } = memoryStore({ free: 1800, sub: { ...paid, state, checked: now.getTime() } });
        expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(402);
        await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY - 1), g.fetcher);
        expect(g.asked).toHaveLength(0);
        await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY), g.fetcher);
        expect(g.asked).toHaveLength(1);
      }
    });

    it("never serves an unpaid one that Google stops knowing before its expiry, and stops asking", async () => {
      for (const state of ["ON_HOLD", "PAUSED", "PENDING"]) {
        const g = await googleSays("", null);   // Google no longer knows the token (410)
        const { s, store } = memoryStore({ free: 1800, sub: { ...paid, state, checked: now.getTime() - DAY } });
        expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(402);
        expect(s.sub).toMatchObject({ state: "GONE", expiry: later });
        expect((await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY), g.fetcher)).status).toBe(402);
        expect(g.asked).toHaveLength(1);
      }
    });

    it("doesn't ask on every call about a revoked one whose expiry is still ahead", async () => {
      const g = await googleSays("EXPIRED", later);
      const { store } = memoryStore({ free: 1800, sub: { ...paid, state: "EXPIRED", checked: now.getTime() } });
      for (const t of [0, DAY, 10 * DAY]) await handle(transcribe(10), g.e, store, new Date(now.getTime() + t), g.fetcher);
      expect(g.asked).toHaveLength(0);
    });
  });

  describe("a subscription that lapsed in the database", () => {
    const lapsed = { token: "sub", product: "monthly", expiry: now.getTime() - 60_000 };

    it("asks Google and keeps serving a subscriber Google renewed", async () => {
      const g = await googleSays("ACTIVE", later);
      const { s, store } = memoryStore({ free: 1800, sub: lapsed, subUsed: SUB_SECONDS });
      const res = await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(res.status).toBe(200);
      expect(s.sub).toMatchObject({ expiry: later, state: "ACTIVE", checked: now.getTime() });
      expect(s.subUsed).toBeGreaterThan(SUB_SECONDS); // the memory store keeps one counter
      await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(g.asked).toHaveLength(1);
    });

    it("keeps serving in the grace period", async () => {
      const g = await googleSays("IN_GRACE_PERIOD", now.getTime() + 5 * 60_000);
      const { store } = memoryStore({ free: 1800, sub: lapsed });
      expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(200);
    });

    it("counts hours in a grace period against the unpaid month, and starts 10 fresh hours on a paid renewal", async () => {
      const grace = await googleSays("IN_GRACE_PERIOD", now.getTime() + 5 * 60_000);
      const { s, store } = memoryStore({ free: 1800, sub: lapsed, subUsed: SUB_SECONDS });
      const res = await handle(transcribe(10), grace.e, store, now, grace.fetcher);
      expect(res.status).toBe(402);
      expect((await res.json()).error.code).toBe("hours_used");
      expect(s.sub).toMatchObject({ state: "IN_GRACE_PERIOD", period: lapsed.expiry });
      // Google moves the expiry again while still unpaid: still the same month.
      const graceLater = await googleSays("IN_GRACE_PERIOD", now.getTime() + 20 * 60_000);
      await handle(transcribe(10), graceLater.e, store, new Date(now.getTime() + 6 * 60_000), graceLater.fetcher);
      expect(s.sub).toMatchObject({ period: lapsed.expiry });
      // Paid: 10 fresh hours.
      const paid = await googleSays("ACTIVE", later);
      const after = new Date(now.getTime() + 21 * 60_000);
      expect((await handle(transcribe(10), paid.e, store, after, paid.fetcher)).status).toBe(200);
      expect(s.sub).toMatchObject({ state: "ACTIVE", period: later });
      expect(s.usage.get(later)).toBeGreaterThan(0);
    });

    it("serves a day when Google says ACTIVE past its expiry, then asks again", async () => {
      const g = await googleSays("ACTIVE", lapsed.expiry);
      const { store } = memoryStore({ free: 1800, sub: lapsed });
      expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(200);
      expect((await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY - 1), g.fetcher)).status).toBe(200);
      expect(g.asked).toHaveLength(1);
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY), g.fetcher);
      expect(g.asked).toHaveLength(2);
    });

    it("refuses on account hold, and asks again only a day later", async () => {
      const g = await googleSays("ON_HOLD", lapsed.expiry);
      const { s, store } = memoryStore({ free: 1800, sub: lapsed });
      const res = await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(res.status).toBe(402);
      expect(s.sub).toMatchObject({ state: "ON_HOLD", checked: now.getTime() });
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY - 1), g.fetcher);
      expect(g.asked).toHaveLength(1);
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + DAY), g.fetcher);
      expect(g.asked).toHaveLength(2);
    });

    it("stops asking once Google says it expired or no longer knows it", async () => {
      for (const [state, expiry] of [["EXPIRED", lapsed.expiry], ["CANCELED", lapsed.expiry], ["", null]] as const) {
        const g = await googleSays(state, expiry);
        const { s, store } = memoryStore({ free: 1800, sub: lapsed });
        expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(402);
        await handle(transcribe(10), g.e, store, new Date(now.getTime() + 30 * DAY), g.fetcher);
        expect(g.asked).toHaveLength(1);
        expect(s.sub?.state).toBe(expiry == null ? "GONE" : state);
      }
    });

    it("serves a canceled subscription until its paid month ends", async () => {
      const g = await googleSays("CANCELED", later);
      const { store } = memoryStore({ free: 1800 });
      const res = await handle(new Request("https://example.com/v1/purchases", {
        method: "POST", headers: { "X-Device-Id": device }, body: JSON.stringify({ product_id: "monthly", purchase_token: "sub" }),
      }), g.e, store, now, g.fetcher);
      expect(await res.json()).toEqual({ subscribed: true, out: false });
    });

    it("tries again on the next call when Google doesn't answer", async () => {
      const g = await googleSays("ACTIVE", later);
      let down = true;
      const fetcher = (async (u: string, init?: RequestInit) => down && u.includes("subscriptionsv2")
        ? new Response("busy", { status: 503 }) : g.fetcher(u, init)) as unknown as typeof fetch;
      const { s, store } = memoryStore({ free: 1800, sub: lapsed });
      expect((await handle(transcribe(10), g.e, store, now, fetcher)).status).toBe(402);
      expect(s.sub?.checked).toBeUndefined();
      down = false;
      expect((await handle(transcribe(10), g.e, store, now, fetcher)).status).toBe(200);
    });

    it("re-checks before a Yiddish take too", async () => {
      const g = await googleSays("ACTIVE", later);
      const e = { ...g.e, DEVICE_TOKEN_SECRET: "secret" };
      const { store } = memoryStore({ free: 1800, sub: lapsed });
      expect(await yiddishCheck(e, store, device, await deviceToken("secret", device), now, null, g.fetcher)).toEqual({ ok: true });
    });
  });

  describe("a refunded top-up", () => {
    /** Google's Play API listing [voided] as refunded one-time purchases (or failing with [status]). */
    async function googleVoided(voided: string[], status = 200) {
      const g = await googleSays("ACTIVE", later);
      const asked: string[] = [];
      const fetcher = (async (u: string, init?: RequestInit) => {
        if (!u.includes("/purchases/voidedpurchases")) return g.fetcher(u, init);
        asked.push(u);
        if (status !== 200) return new Response("busy", { status });
        return Response.json({ voidedPurchases: voided.map((purchaseToken) => ({ kind: "androidpublisher#voidedPurchase", purchaseToken })) });
      }) as unknown as typeof fetch;
      return { e: g.e, fetcher, asked };
    }
    // Subscribed, this month's 10 hours used: the bought hours pay next.
    const paying = { free: 1800, sub: { token: "sub", product: "monthly", expiry: later, state: "ACTIVE", checked: now.getTime() },
      subUsed: SUB_SECONDS };
    const bought = (token: string, ago = DAY) => ({ token, seconds: TOPUP_SECONDS, created: now.getTime() - ago });

    it("takes back the hours not used yet, never below zero, without slowing the call", async () => {
      const g = await googleVoided(["tok"]);
      // 4 hours bought, 1 used, then refunded.
      const { s, store } = memoryStore({ ...paying, credit: TOPUP_SECONDS - 3600, topups: [bought("tok")] });
      const deferred: Promise<unknown>[] = [];
      const first = await handle(transcribe(10), g.e, store, now, g.fetcher, (p) => { deferred.push(p); });
      expect(first.status).toBe(200); // served on what was known; Google is asked after the answer
      await Promise.all(deferred);
      expect(g.asked).toHaveLength(1);
      expect(g.asked[0]).toContain("/applications/com.isaacweber.wordforword/purchases/voidedpurchases");
      expect(s.credit).toBe(0);
      expect((await handle(transcribe(10), g.e, store, now, g.fetcher)).status).toBe(402);
    });

    it("keeps the hours of a top-up that wasn't refunded", async () => {
      const g = await googleVoided(["two"]);
      const { s, store } = memoryStore({ ...paying, credit: 2 * TOPUP_SECONDS - 3600, topups: [bought("one"), bought("two")] });
      await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }), g.e, store, now, g.fetcher);
      expect(s.credit).toBe(TOPUP_SECONDS - 3600);
    });

    it("asks once a day, and takes back each refund once although Google lists it for 30 days", async () => {
      const g = await googleVoided(["one"]);
      const { s, store } = memoryStore({ ...paying, credit: 2 * TOPUP_SECONDS, topups: [bought("one", DAY - 60_000), bought("two", DAY - 60_000)] });
      await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(g.asked).toHaveLength(0); // counted less than a day ago
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + 60_000), g.fetcher);
      expect(g.asked).toHaveLength(1);
      const left = s.credit;
      expect(left).toBeLessThanOrEqual(TOPUP_SECONDS);
      await handle(transcribe(10), g.e, store, new Date(now.getTime() + 2 * 60_000), g.fetcher);
      expect(g.asked).toHaveLength(1);
      await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }), g.e, store,
        new Date(now.getTime() + 60_000 + DAY), g.fetcher);
      expect(g.asked).toHaveLength(2);
      expect(s.credit).toBeGreaterThan(left - 60); // only the two recordings since, not 4 more hours
    });

    it("tries again on the next call when Google doesn't answer", async () => {
      const down = await googleVoided([], 503);
      const { s, store } = memoryStore({ ...paying, credit: TOPUP_SECONDS, topups: [bought("tok")] });
      await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }), down.e, store, now, down.fetcher);
      expect(s.credit).toBe(TOPUP_SECONDS);
      const up = await googleVoided(["tok"]);
      await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }), up.e, store, now, up.fetcher);
      expect(up.asked).toHaveLength(1);
      expect(s.credit).toBe(0);
    });

    it("doesn't ask Google without bought hours left", async () => {
      const g = await googleVoided(["tok"]);
      const { store } = memoryStore({ ...paying, credit: 0, topups: [bought("tok")] });
      await handle(transcribe(10), g.e, store, now, g.fetcher);
      expect(g.asked).toHaveLength(0);
    });

    it("checks before a Yiddish take too", async () => {
      const g = await googleVoided(["tok"]);
      const e = { ...g.e, DEVICE_TOKEN_SECRET: "secret" };
      const { s, store } = memoryStore({ ...paying, credit: TOPUP_SECONDS, topups: [bought("tok")] });
      await yiddishCheck(e, store, device, await deviceToken("secret", device), now, null, g.fetcher);
      expect(s.credit).toBe(0);
    });

    it("takes back only what is left of the refunded top-up itself, the oldest bought hours used first (the real SQL)", async () => {
      // Third review, 2026-11-25: a phone's bought hours are one balance, and a refund took the top-up's whole 4 hours
      // from it, so a top-up used up and then refunded took the 4 hours of a top-up bought after it.
      const db = sqliteD1(), store = d1Store(db);
      const credit = async () => (await db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(device).first<{ seconds: number }>())!.seconds;
      await store.addTopup("used", device, TOPUP_SECONDS, 1);
      await store.charge(device, "2026-11", "credit", TOPUP_SECONDS, null);
      await store.addTopup("new", device, TOPUP_SECONDS, 2);
      expect(await store.takeBackTopups(["used"], 3, 0, device)).toBe(1);
      expect(await credit()).toBe(TOPUP_SECONDS);   // nothing of the refunded one was left
      // One hour of three top-ups used: the first had 3 hours left, and those go; the newest is taken whole.
      const other = "b".repeat(64), creditOf = async () =>
        (await db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(other).first<{ seconds: number }>())!.seconds;
      for (const [t, at] of [["x", 10], ["y", 11], ["z", 12]] as const) await store.addTopup(t, other, TOPUP_SECONDS, at);
      await store.charge(other, "2026-11", "credit", 3600, null);
      await store.takeBackTopups(["x"], 13, 0, other);
      expect(await creditOf()).toBe(2 * TOPUP_SECONDS);
      await store.takeBackTopups(["z", "z"], 14, 0, other);
      expect(await creditOf()).toBe(TOPUP_SECONDS);
    });
  });

  describe("hours given on the Access page", () => {
    const CODE = "K7QM4XPA9TRW";
    const withCode = (c = "k7qm-4xpa-9trw") => ({ "X-Device-Id": device, "X-Access-Code": c });
    const paidFetch = (sent: string[]) => (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).model);
      return Response.json({ text: "hi", usage: { seconds: 10, cost: 10 * 0.1 / 3600 } });
    }) as unknown as typeof fetch;
    const models = { free: [{ id: "free-model", per_hour: 0.1 }], paid: [{ id: "paid-model", per_hour: 0.1 }] };

    it("reads a code as typed, with dashes, spaces and any case", () => {
      expect(accessCode(" k7qm-4xpa 9trw ")).toBe(CODE);
      expect(accessCode("short")).toBeNull();
      expect(accessCode(null)).toBeNull();
    });

    it("uses given hours first, past the free minutes, on the paid models, until they're used", async () => {
      const sent: string[] = [];
      const a = memoryStore({ free: 1800, models, grant: { code: CODE, who: "friend@gmail.com", seconds: 3600 } });
      expect((await handle(transcribe(10, {}, withCode()), env, a.store, now, paidFetch(sent))).status).toBe(200);
      expect(sent).toEqual(["paid-model"]);
      expect(a.s.grant!.used).toBeCloseTo(10, 5);
      expect(a.s.free).toBe(1800);
      // Used up, free minutes too: refused with its own code.
      const b = memoryStore({ free: 1800, grant: { code: CODE, who: "friend@gmail.com", seconds: 3600, used: 3600 } });
      const res = await handle(transcribe(10, {}, withCode()), env, b.store, now, ok);
      expect(res.status).toBe(402);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("given_hours_used");
      // Used up with free minutes left: the free minutes go next.
      const c = memoryStore({ free: 0, grant: { code: CODE, who: "friend@gmail.com", seconds: 3600, used: 3600 } });
      expect((await handle(transcribe(10, {}, withCode()), env, c.store, now, ok)).status).toBe(200);
      expect(c.s.free).toBeGreaterThan(0);
    });

    it("never refuses unlimited", async () => {
      const a = memoryStore({ free: 1800, grant: { code: CODE, who: "me@gmail.com", seconds: null, used: 1e9 } });
      expect((await handle(transcribe(10, {}, withCode()), env, a.store, now, ok)).status).toBe(200);
    });

    it("ignores a wrong or removed code", async () => {
      const a = memoryStore({ free: 1800, grant: { code: CODE, who: "friend@gmail.com", seconds: null } });
      expect((await handle(transcribe(10, {}, withCode("AAAABBBBCCCC")), env, a.store, now, ok)).status).toBe(402);
      const usage = await handle(new Request("https://example.com/v1/usage", { headers: withCode("AAAABBBBCCCC") }), env, a.store, now, ok);
      expect((await usage.json() as { access: unknown }).access).toBeNull();
    });

    it("reports the given hours on usage", async () => {
      const a = memoryStore({ grant: { code: CODE, who: "friend@gmail.com", seconds: 7200, used: 60 } });
      const usage = await handle(new Request("https://example.com/v1/usage", { headers: withCode() }), env, a.store, now, ok);
      expect((await usage.json() as { access: unknown }).access).toEqual({ who: "friend@gmail.com", seconds: 7200, used_seconds: 60 });
    });

    it("lets a valid code stand in for the device token, and nothing else", async () => {
      const strict = { ...env, REQUIRE_INTEGRITY: "true", DEVICE_TOKEN_SECRET: "s" } as Env;
      const a = memoryStore({ grant: { code: CODE, who: "friend", seconds: null } });
      expect((await handle(transcribe(5, {}, withCode()), strict, a.store, now, ok)).status).toBe(200);
      expect((await handle(transcribe(5, {}, withCode("AAAABBBBCCCC")), strict, a.store, now, ok)).status).toBe(426);
    });

    it("lets a Yiddish take through with a code and no device token, counted twice on the given hours", async () => {
      const e = { ...env, DEVICE_TOKEN_SECRET: "s" } as Env;
      const a = memoryStore({ grant: { code: CODE, who: "friend", seconds: 3600 } });
      expect(await yiddishCheck(e, a.store, device, null, now, "k7qm-4xpa-9trw")).toEqual({ ok: true });
      await yiddishCharge(e, a.store, device, 30, now, CODE);
      expect(a.s.grant!.used).toBe(60);
      expect(a.s.free).toBe(0);
      // Used up: without Google Play's word, the phone's free minutes don't count.
      const b = memoryStore({ grant: { code: CODE, who: "friend", seconds: 3600, used: 3600 } });
      expect(await yiddishCheck(e, b.store, device, null, now, CODE)).toMatchObject({ ok: false, status: 402, code: "given_hours_used" });
      expect(await yiddishCheck(e, b.store, device, null, now, "AAAABBBBCCCC")).toMatchObject({ ok: false, status: 403 });
    });

    it("answers the app links file for Android", async () => {
      const res = await handle(new Request("https://nuchemweber.com/.well-known/assetlinks.json"), env, memoryStore().store, now, ok);
      const links = await res.json() as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
      expect(links[0].target.package_name).toBe("com.isaacweber.wordforword");
      expect(links[0].target.sha256_cert_fingerprints).toHaveLength(2);
    });
  });

  describe("Play Integrity", () => {
    const secret = "s3cret";
    const strict = { ...env, REQUIRE_INTEGRITY: "true", DEVICE_TOKEN_SECRET: secret } as Env;
    const good = {
      requestDetails: { requestPackageName: "com.isaacweber.wordforword", requestHash: device, timestampMillis: "1" },
      appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.isaacweber.wordforword" },
      deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] },
    };

    async function serviceAccount() {
      const { generateKeyPairSync } = await import("node:crypto");
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      return JSON.stringify({ client_email: "x@y", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    }
    const google = (payload: unknown, status = 200) => (async (u: string) => u.includes("oauth2")
      ? Response.json({ access_token: "a", expires_in: 3600 })
      : Response.json(status === 200 ? { tokenPayloadExternal: payload } : { error: {} }, { status })) as unknown as typeof fetch;
    const phone = { model: "OnePlus IN2023", android: "13", app_version: "0.9.17" };
    const register = (body: Record<string, unknown> = { integrity_token: "itok", ...phone }) =>
      new Request("https://example.com/v1/register", { method: "POST", headers: { "X-Device-Id": device }, body: JSON.stringify(body) });

    it("accepts the Play app on a phone with basic integrity, and not less", () => {
      expect(integrityProblem(good, device)).toBeNull();
      expect(integrityProblem({ ...good, deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] } }, device)).toBeNull();
      expect(integrityProblem({ ...good, deviceIntegrity: {} }, device)).toBe("device none");
      expect(integrityProblem({ ...good, appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }, device)).toMatch(/^app /);
      expect(integrityProblem({ ...good, requestDetails: { ...good.requestDetails, requestHash: "b".repeat(64) } }, device))
        .toBe("request hash doesn't match");
      expect(integrityProblem({ ...good, requestDetails: { ...good.requestDetails, requestPackageName: "evil" } }, device)).toBe("package evil");
      expect(integrityProblem(null, device)).toBe("token not readable");
    });

    it("gives a vouched-for phone its device token", async () => {
      const sa = await serviceAccount();
      const res = await handle(register(), { ...strict, GOOGLE_SERVICE_ACCOUNT: sa }, memoryStore().store, now, google(good));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ device_token: await deviceToken(secret, device) });
    });

    it("refuses a phone Google doesn't vouch for, or a token Google can't read", async () => {
      const sa = await serviceAccount();
      const e = { ...strict, GOOGLE_SERVICE_ACCOUNT: sa };
      const refused = await handle(register(), e, memoryStore().store, now, google({ ...good, deviceIntegrity: {} }));
      expect(refused.status).toBe(403);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("device_unverified");
      expect((await handle(register(), e, memoryStore().store, now, google(null, 400))).status).toBe(403);
      // Google refusing this server is not the phone's fault: try again later.
      expect((await handle(register(), e, memoryStore().store, now, google(null, 403))).status).toBe(503);
    });

    it("lists a phone that got no token from Google, or that Google didn't vouch for, and drops it once it passes", async () => {
      const m = memoryStore();
      const none = await handle(register({ integrity_error: -12, ...phone }), strict, m.store, now, ok);
      expect(none.status).toBe(400);
      await handle(register({ integrity_error: "timeout", ...phone }), strict, m.store, now, ok);
      expect(m.s.failed.get(device)).toEqual({ ...phone, reason: "timeout", count: 2 });
      expect((await handle(register({ integrity_error: -12, ...phone }), strict, m.store, now, ok)).status).toBe(400);
      expect(m.s.failed.get(device)!.reason).toBe("google:-12");
      const sa = await serviceAccount();
      const e = { ...strict, GOOGLE_SERVICE_ACCOUNT: sa };
      await handle(register(), e, m.store, now, google({ ...good, deviceIntegrity: {} }));
      expect(m.s.failed.get(device)).toMatchObject({ reason: "refused:device none", count: 4 });
      expect((await handle(register(), e, m.store, now, google(good))).status).toBe(200);
      expect(m.s.failed.has(device)).toBe(false);
      // A register call with neither a token nor a reason lists nothing.
      await handle(register({}), strict, m.store, now, ok);
      expect(m.s.failed.size).toBe(0);
    });

    it("serves a phone given hours without a device token, only from those hours, Yiddish twice", async () => {
      const m = memoryStore({ free: 0, grant: { code: "XXXXXXXXXXXX", who: "Phone", seconds: 1800, device } });
      expect((await handle(transcribe(10), strict, m.store, now, ok)).status).toBe(200);
      expect(m.s.grant!.used).toBeCloseTo(10, 5);
      expect(m.s.free).toBe(0);
      const usage = await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }), strict, m.store, now, ok);
      expect(await usage.json()).toMatchObject({ out: false, access: null });
      expect(await yiddishCheck(strict, m.store, device, null, now)).toEqual({ ok: true });
      await yiddishCharge(strict, m.store, device, 30, now);
      expect(m.s.grant!.used).toBeCloseTo(70, 5);
      // Another phone gets nothing from it.
      expect((await handle(transcribe(5, {}, { "X-Device-Id": "b".repeat(64) }), strict, m.store, now, ok)).status).toBe(426);
      // Used up: the free minutes don't take over without Google Play's word.
      m.s.grant!.used = 1800;
      const out = await handle(transcribe(5), strict, m.store, now, ok);
      expect(out.status).toBe(402);
      expect((await out.json() as { error: { code: string } }).error.code).toBe("given_hours_used");
      expect(m.s.free).toBe(0);
    });

    it("refuses calls without a valid device token once required", async () => {
      const none = await handle(transcribe(5), strict, memoryStore().store, now, ok);
      expect(none.status).toBe(426);
      expect((await none.json() as { error: { code: string } }).error.code).toBe("device_unverified");
      const fake = await handle(transcribe(5, {}, { "X-Device-Id": device, "X-Device-Token": "0".repeat(64) }),
        strict, memoryStore().store, now, ok);
      expect(fake.status).toBe(403);
      // Another phone's token doesn't work for this device ID.
      const other = await deviceToken(secret, "b".repeat(64));
      expect((await handle(transcribe(5, {}, { "X-Device-Id": device, "X-Device-Token": other }),
        strict, memoryStore().store, now, ok)).status).toBe(403);
      const usage = await handle(new Request("https://example.com/v1/usage", { headers: { "X-Device-Id": device } }),
        strict, memoryStore().store, now, ok);
      expect(usage.status).toBe(426);
    });

    it("serves a call with this phone's token, and any call while not required", async () => {
      const token = await deviceToken(secret, device);
      expect((await handle(transcribe(5, {}, { "X-Device-Id": device, "X-Device-Token": token }),
        strict, memoryStore().store, now, ok)).status).toBe(200);
      expect((await handle(transcribe(5), { ...strict, REQUIRE_INTEGRITY: "false" }, memoryStore().store, now, ok)).status).toBe(200);
    });
  });
});
