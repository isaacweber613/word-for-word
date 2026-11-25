/**
 * Attacks on a local run of the server (local-run.ts): the real Worker and a local D1 database, with
 * stand-ins for Google and OpenRouter. Review of 2026-11-25; each test failed before its fix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { d1Store } from "../src/store";
import { deviceId, deviceToken, phone, recording, startLocal, type LocalServer } from "./local-run";

const month = () => new Date().toISOString().slice(0, 7);
const DAY = 24 * 3600_000;

describe("a local run of the server", () => {
  let server: LocalServer;
  beforeAll(async () => { server = await startLocal(); }, 120_000);
  afterAll(async () => { await server?.dispose(); });
  beforeEach(async () => { await server.reset(); });

  const openrouterCalls = () => server.calls.filter((c) => c.host === "openrouter.ai");
  /** OpenRouter holding every answer until release(), so requests overlap like a burst from many phones. */
  function holdOpenRouter(seconds: number) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server.stand.openrouter = async () => { await gate; return Response.json({ text: "hi", usage: { seconds, cost: seconds * 0.1 / 3600 } }); };
    return () => release();
  }
  /** Sends [requests] at once; lets OpenRouter answer once each has either reached it or been answered. */
  async function burst(requests: (() => Promise<Response>)[], release: () => void): Promise<number[]> {
    let answered = 0;
    const all = requests.map((send) => send().then((r) => { answered++; return r; }));
    await server.eventually(async () => openrouterCalls().length + answered, (n) => n >= requests.length);
    release();
    return (await Promise.all(all)).map((r) => r.status).sort();
  }

  describe("someone who wants free dictation", () => {
    it("can't send many recordings at once on the last second of a phone's free minutes", async () => {
      const d = deviceId(1);
      await server.db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, 1799)").bind(d, month()).run();
      const release = holdOpenRouter(60);
      const statuses = await burst(Array.from({ length: 5 }, () => () =>
        server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(60) })), release);
      expect(openrouterCalls()).toHaveLength(1);
      expect(statuses).toEqual([200, 402, 402, 402, 402]);
      const used = await server.eventually(async () => (await server.db.prepare("SELECT seconds FROM usage WHERE device = ?")
        .bind(d).first<{ seconds: number }>())!.seconds, (s) => Math.abs(s - 1859) < 1e-6);
      expect(used).toBeCloseTo(1859, 6); // the one recording, as OpenRouter measured it
    });

    it("can't use one access code's last minute on many phones at once", async () => {
      await server.db.prepare("INSERT INTO grants (id, who, code, seconds, created_at) VALUES (1, 'Friend', 'K7QM4XPA9TRW', 3600, 0)").run();
      await server.db.prepare("INSERT INTO grant_usage (grant_id, month, seconds) VALUES (1, ?, 3599)").bind(month()).run();
      const release = holdOpenRouter(60);
      // Five phones that Google Play never vouched for, all with the code.
      const statuses = await burst(Array.from({ length: 5 }, (_, i) => () => server.fetch("/v1/transcriptions",
        { method: "POST", headers: phone(deviceId(100 + i), { token: false, code: "K7QM-4XPA-9TRW" }), body: recording(60) })), release);
      expect(openrouterCalls()).toHaveLength(1);
      expect(statuses).toEqual([200, 402, 402, 402, 402]);
    });

    // Not fixed by this server alone: the yiddishtry Worker (yiddish-stt tryout/worker) asks check once before a take
    // and calls charge after it, and has no way to hold time and give it back. This test fails, as it.fails expects,
    // until that Worker holds and settles each take the way recordings now do.
    it.fails("can't start many Yiddish takes on the last second of a phone's free minutes", async () => {
      const d = deviceId(30);
      await server.db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, 1799)").bind(d, month()).run();
      const answers = await Promise.all(Array.from({ length: 5 }, () => server.yiddish("check", d, deviceToken(d), null)));
      expect(answers.filter((x) => (x as { ok: boolean }).ok)).toHaveLength(1);
    });

    it("gives back what a recording held when no model typed it", async () => {
      const d = deviceId(2);
      server.stand.openrouter = () => Response.json({ error: { message: "busy" } }, { status: 503 });
      expect((await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(30) })).status).toBe(503);
      const used = await server.eventually(async () => (await server.db.prepare("SELECT seconds FROM usage WHERE device = ?")
        .bind(d).first<{ seconds: number }>())?.seconds ?? 0, (s) => s === 0);
      expect(used).toBe(0);
    });
  });

  describe("money already paid", () => {
    /** The local database, failing once on the first statement matching [pattern], as a lost connection would. */
    function failingOnce(db: D1Database, pattern: RegExp): D1Database {
      let failed = false;
      const check = (sql: string) => {
        if (!failed && pattern.test(sql)) { failed = true; throw new Error("D1_ERROR: Network connection lost."); }
      };
      type Wrapped = D1PreparedStatement & { sql: string; real: D1PreparedStatement };
      const wrap = (real: D1PreparedStatement, sql: string): Wrapped => Object.assign(Object.create(real) as D1PreparedStatement, {
        sql, real,
        bind: (...v: unknown[]) => wrap(real.bind(...v), sql),
        run: async () => { check(sql); return real.run(); },
      }) as Wrapped;
      return Object.assign(Object.create(db) as D1Database, {
        prepare: (sql: string) => wrap(db.prepare(sql), sql),
        batch: async (statements: Wrapped[]) => { statements.forEach((s) => check(s.sql)); return db.batch(statements.map((s) => s.real)); },
      });
    }

    it("never counts a bought top-up without adding its hours, even when the database fails in between", async () => {
      const d = deviceId(20);
      const store = d1Store(failingOnce(server.db, /^INSERT INTO credit/));
      await expect(store.addTopup("tok", d, 4 * 3600, Date.now())).rejects.toThrow("Network connection lost");
      // The app sends the purchase again on its next start.
      await store.addTopup("tok", d, 4 * 3600, Date.now());
      const credit = await server.db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(d).first<{ seconds: number }>();
      expect(credit?.seconds).toBe(4 * 3600);
      // And once only.
      expect(await store.addTopup("tok", d, 4 * 3600, Date.now())).toBe(false);
      expect((await server.db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(d).first<{ seconds: number }>())!.seconds)
        .toBe(4 * 3600);
    });

    /** A phone that has used this month's 10 subscription hours, with one 4-hour top-up bought [ago] ms ago. */
    async function subscriberWithTopup(d: string, token: string, ago: number) {
      const now = Date.now();
      await server.db.batch([
        server.db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES (?, 'monthly', ?, 'ACTIVE', ?, ?)")
          .bind("sub-" + d, now + 20 * DAY, now, now + 20 * DAY),
        server.db.prepare("INSERT INTO subscription_devices (device, token) VALUES (?, ?)").bind(d, "sub-" + d),
        server.db.prepare("INSERT INTO subscription_usage (token, period, seconds) VALUES (?, ?, 36000)").bind("sub-" + d, now + 20 * DAY),
        server.db.prepare("INSERT INTO topups (token, device, seconds, created_at) VALUES (?, ?, 14400, ?)").bind(token, d, now - ago),
        server.db.prepare("INSERT INTO credit (device, seconds) VALUES (?, 14400) ON CONFLICT (device) DO UPDATE SET seconds = seconds + 14400").bind(d),
      ]);
    }
    const creditOf = (d: string) => server.db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(d).first<{ seconds: number }>()
      .then((r) => r?.seconds ?? 0);

    it("takes back a top-up refunded longer ago than Google's 30-day refund list goes", async () => {
      const d = deviceId(21);
      await subscriberWithTopup(d, "old-topup", 40 * DAY);
      // Refunded 35 days ago: no longer on Google's list, but Google still knows the purchase as canceled.
      server.stand.voided = () => Response.json({});
      server.stand.product = (_p, token) => Response.json({ purchaseState: token === "old-topup" ? 1 : 0 });
      expect((await server.fetch("/v1/usage", { headers: phone(d) })).status).toBe(200);
      expect(await server.eventually(() => creditOf(d), (c) => c === 0)).toBe(0);
    });

    it("keeps an old top-up that wasn't refunded, and leaves another phone's old top-up to that phone's own check", async () => {
      const a = deviceId(22), b = deviceId(23);
      await subscriberWithTopup(a, "kept", 40 * DAY);
      await subscriberWithTopup(b, "other", 40 * DAY);
      server.stand.voided = () => Response.json({});
      server.stand.product = () => Response.json({ purchaseState: 0 });
      await server.fetch("/v1/usage", { headers: phone(a) });
      const checked = (t: string) => server.db.prepare("SELECT checked FROM topups WHERE token = ?").bind(t).first<{ checked: number | null }>()
        .then((r) => r?.checked ?? null);
      expect(await server.eventually(() => checked("kept"), (c) => c != null)).not.toBeNull();
      expect(await creditOf(a)).toBe(14400);
      expect(await checked("other")).toBeNull();
      const asked = () => server.calls.filter((c) => c.path.includes("/purchases/products/")).map((c) => decodeURIComponent(c.path).split("/").pop());
      expect(asked()).toEqual(["kept"]);
      await server.fetch("/v1/usage", { headers: phone(b) });
      expect(await server.eventually(async () => asked(), (x) => x.length === 2)).toEqual(["kept", "other"]);
    });
  });

  describe("someone who wants to cost Isaac money", () => {
    it("sends OpenRouter only what the app itself sends, whatever else a phone puts in the body", async () => {
      const d = deviceId(3);
      const body = recording(5, {
        language: "en", diarize: true, keyterms: ["x"], response_format: "verbose_json", timestamp_granularities: ["word"],
        temperature: 1, prompt: "p", session_id: "s", trace: { trace_id: "t" }, user: "u", models: ["openai/gpt-transcribe"],
        provider: { order: ["some-provider"], allow_fallbacks: false, data_collection: "allow", zdr: false, options: {
          azure: { enhancedMode: { modelOptions: { transcribeStyle: "clean" } } },
          elevenlabs: { no_verbatim: true, diarize: true }, deepgram: { filler_words: false, extra: 1 }, assemblyai: { disfluencies: false },
          openai: { anything: 1 } } },
      });
      (body.input_audio as Record<string, unknown>).url = "https://example.com/ten-hours.mp3";
      expect((await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body })).status).toBe(200);
      expect(openrouterCalls()[0].body).toEqual({
        model: "microsoft/mai-transcribe-2", language: "en",
        input_audio: { data: (body.input_audio as { data: string }).data, format: "ogg" },
        provider: { options: { azure: { enhancedMode: { modelOptions: { transcribeStyle: "clean" } } },
          elevenlabs: { no_verbatim: true }, deepgram: { filler_words: false }, assemblyai: { disfluencies: false } } },
      });
    });

    it("refuses audio formats the app never sends", async () => {
      const res = await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(deviceId(4)),
        body: { input_audio: { data: "AAAA", format: "amr" } } });
      expect(res.status).toBe(400);
      expect(openrouterCalls()).toHaveLength(0);
    });
  });
});

describe("a local run with the optional limits set", () => {
  let server: LocalServer;
  beforeAll(async () => {
    server = await startLocal({ OPENROUTER_PAID_KEY: "paid-key", MAX_RECORDING_SECONDS: "300" }, {
      ratelimits: {
        DEVICE_LIMITER: { namespace_id: "1001", simple: { limit: 3, period: 60 } },
        ADDRESS_LIMITER: { namespace_id: "1002", simple: { limit: 2, period: 60 } },
      },
    });
  }, 120_000);
  afterAll(async () => { await server?.dispose(); });
  beforeEach(async () => { await server.reset(); });

  const openrouterCalls = () => server.calls.filter((c) => c.host === "openrouter.ai");

  it("keeps paying phones on their own OpenRouter key, so free use that spends the free key's limit doesn't stop them", async () => {
    const payer = deviceId(10), free = deviceId(11);
    const now = Date.now();
    await server.db.batch([
      server.db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES ('sub', 'monthly', ?, 'ACTIVE', ?, ?)")
        .bind(now + 20 * DAY, now, now + 20 * DAY),
      server.db.prepare("INSERT INTO subscription_devices (device, token) VALUES (?, 'sub')").bind(payer),
    ]);
    // The free key has reached its limit on openrouter.ai.
    server.stand.openrouter = (_b, key) => key === "free-key"
      ? Response.json({ error: { code: 402, message: "Key limit exceeded", metadata: { limit_source: "openrouter_key_limit" } } }, { status: 402 })
      : Response.json({ text: "hi", usage: { seconds: 10, cost: 10 * 0.1 / 3600 } });
    expect((await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(payer), body: recording(10) })).status).toBe(200);
    expect((await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(free), body: recording(10) })).status).toBe(402);
    expect(openrouterCalls().map((c) => c.key)).toEqual(["paid-key", "free-key"]);
  });

  it("refuses a recording longer than MAX_RECORDING_SECONDS before sending it anywhere", async () => {
    const d = deviceId(12);
    const res = await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(301) });
    expect(res.status).toBe(413);
    expect(openrouterCalls()).toHaveLength(0);
    expect((await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(299) })).status).toBe(200);
  });

  it("answers 429 past DEVICE_LIMITER's limit for one phone, and other phones go on", async () => {
    const d = deviceId(13);
    const send = (device: string) => server.fetch("/v1/transcriptions", { method: "POST", headers: phone(device), body: recording(1) });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await send(d)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await send(deviceId(14))).status).toBe(200);
    expect(openrouterCalls()).toHaveLength(4);
  });

  it("answers 429 past ADDRESS_LIMITER's limit on the unauthenticated phone check, before asking Google", async () => {
    const register = (n: number) => server.fetch("/v1/register", { method: "POST",
      headers: { "X-Device-Id": deviceId(200 + n), "CF-Connecting-IP": "203.0.113.7", "Content-Type": "application/json" },
      body: { integrity_token: "junk-" + n, model: "x", android: "1", app_version: "0" } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await register(i)).status);
    expect(statuses).toEqual([403, 403, 429]);
    expect(server.calls.filter((c) => c.host === "playintegrity.googleapis.com")).toHaveLength(2);
    const listed = await server.db.prepare("SELECT count(*) AS n FROM failed_checks").first<{ n: number }>();
    expect(listed!.n).toBe(2);
  });
});
