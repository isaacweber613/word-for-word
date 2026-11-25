import { describe, expect, it } from "vitest";
import {
  accessCode, audioSeconds, choose, deviceToken, handle, integrityProblem, monthOf, planSeconds, SUB_SECONDS, TOPUP_SECONDS, wavSeconds,
  yiddishCharge, yiddishCheck, type Env,
} from "../src/index";
import { DEFAULT_MODELS, type Account, type Bucket, type Grant, type Models, type Store, type Sub } from "../src/store";

const device = "a".repeat(64);
const env = { OPENROUTER_KEY: "test-key", FREE_SECONDS_PER_MONTH: "1800" } as Env;
const now = new Date("2026-11-06T12:00:00Z");
const later = now.getTime() + 20 * 86400_000;

/** The D1 store in memory. */
function memoryStore(init: Partial<{ free: number; models: Models; sub: Sub | null; subUsed: number; credit: number;
                                    grant: { code: string; who: string; seconds: number | null; used?: number } }> = {}) {
  const s = {
    free: init.free ?? 0, models: init.models ?? DEFAULT_MODELS, sub: init.sub ?? null,
    subUsed: init.subUsed ?? 0, credit: init.credit ?? 0, topups: new Set<string>(),
    grant: init.grant ? { used: 0, ...init.grant } : null,
  };
  const store: Store = {
    async account(_d, _m, code): Promise<Account> {
      const g: Grant | null = s.grant && code === s.grant.code ? { id: 1, who: s.grant.who, seconds: s.grant.seconds, used: s.grant.used } : null;
      return { freeUsed: s.free, grant: g, models: s.models, sub: s.sub ? { ...s.sub, used: s.subUsed } : null, credit: s.credit };
    },
    async charge(_d, _m, bucket: Bucket, seconds) {
      if (bucket === "grant") s.grant!.used += seconds;
      else if (bucket === "free") s.free += seconds;
      else if (bucket === "sub") s.subUsed += seconds;
      else s.credit = Math.max(0, s.credit - seconds);
    },
    async saveSubscription(_d, sub) { s.sub = sub; },
    async addTopup(token, _d, seconds) {
      if (s.topups.has(token)) return false;
      s.topups.add(token); s.credit += seconds; return true;
    },
  };
  return { s, store };
}

/** A base64 WAV body of [seconds] of audio, as the app sends it. */
function audio(seconds: number): string {
  return Buffer.alloc(44 + seconds * 32000).toString("base64");
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
    expect(wavSeconds(audio(10))).toBeCloseTo(10, 5);
  });

  it("counts compressed audio by the seconds OpenRouter reports", () => {
    expect(audioSeconds(JSON.stringify({ text: "hi", usage: { seconds: 13.74 } }), "AAAA", "ogg")).toBe(13.74);
  });

  it("estimates Ogg audio from its size when OpenRouter reports no seconds", () => {
    expect(audioSeconds(JSON.stringify({ text: "hi" }), Buffer.alloc(30000).toString("base64"), "ogg")).toBeCloseTo(10, 5);
  });

  it("counts plan seconds by what OpenRouter charged, at $0.10 an hour", () => {
    // 12 s at $0.10/h costs $0.000333: 12 plan seconds. The same 12 s at $0.54/h: 64.8.
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 12, cost: 12 * 0.1 / 3600 } }), "", "ogg",
      { id: "x", per_hour: 0.1 })).toBeCloseTo(12, 5);
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 12, cost: 12 * 0.54 / 3600 } }), "", "ogg",
      { id: "x", per_hour: 0.54 })).toBeCloseTo(64.8, 5);
  });

  it("counts paid hours 1:1 up to $0.15 an hour, faster above it", () => {
    const at = (perHour: number) => planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 12, cost: 12 * perHour / 3600 } }),
      "", "ogg", { id: "x", per_hour: perHour }, 0.15);
    expect(at(0.06)).toBeCloseTo(12, 5);
    expect(at(0.15)).toBeCloseTo(12, 5);
    expect(at(0.27)).toBeCloseTo(21.6, 5);
  });

  it("uses the model's price when OpenRouter reports no cost, never less than one second a second", () => {
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 10 } }), "", "ogg", { id: "x", per_hour: 0.27 })).toBeCloseTo(27, 5);
    expect(planSeconds(JSON.stringify({ text: "hi", usage: { seconds: 10 } }), "", "ogg", { id: "x", per_hour: 0.06 })).toBeCloseTo(10, 5);
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
    expect(s.sub).toEqual({ token: "sub", product: "monthly", expiry: later });
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
    const register = () => new Request("https://example.com/v1/register", {
      method: "POST", headers: { "X-Device-Id": device }, body: JSON.stringify({ integrity_token: "itok" }),
    });

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
