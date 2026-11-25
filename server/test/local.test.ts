/**
 * Attacks on a local run of the server (local-run.ts): the real Worker and a local D1 database, with
 * stand-ins for Google and OpenRouter. Review of 2026-11-25; each test failed before its fix.
 */
import { readFileSync } from "node:fs";
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

    it("can't send many recordings at once on a subscription's last second, or on the last second of bought hours", async () => {
      const now = Date.now();
      for (const [n, subUsed, credit] of [[40, 35_999, 0], [41, 36_000, 1]] as const) {
        await server.reset();
        const d = deviceId(n);
        await server.db.batch([
          server.db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, 1800)").bind(d, month()),
          server.db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES ('s', 'monthly', ?, 'ACTIVE', ?, ?)")
            .bind(now + 20 * DAY, now, now + 20 * DAY),
          server.db.prepare("INSERT INTO subscription_devices (device, token) VALUES (?, 's')").bind(d),
          server.db.prepare("INSERT INTO subscription_usage (token, period, seconds) VALUES ('s', ?, ?)").bind(now + 20 * DAY, subUsed),
          server.db.prepare("INSERT INTO credit (device, seconds) VALUES (?, ?)").bind(d, credit),
        ]);
        const release = holdOpenRouter(60);
        const statuses = await burst(Array.from({ length: 5 }, () => () =>
          server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(60) })), release);
        expect(statuses).toEqual([200, 402, 402, 402, 402]);
        expect(openrouterCalls()).toHaveLength(1);
      }
      // The one recording ran 59 s over the last bought second. That is never a debt: the next top-up adds all its
      // 4 hours (the balance stays below zero until then, so another recording's hold in it can't be clipped away).
      const credit = () => server.db.prepare("SELECT seconds FROM credit").first<{ seconds: number }>().then((r) => r!.seconds);
      expect(await server.eventually(credit, (s) => s === -59)).toBe(-59);
      await d1Store(server.db).addTopup("next-topup", deviceId(41), 4 * 3600, Date.now());
      expect(await credit()).toBe(4 * 3600);
    });

    it("makes no bought hours from two recordings at once on them, whichever starts or answers first", async () => {
      // Codex's review of 52c15aa: 100 s left, two 60 s recordings held (-20), the first typed and settled (clipped to
      // 0), the second not typed and given back: 60 s left instead of 40.
      const now = Date.now(), period = now + 20 * DAY;
      const credit = (d: string) => server.db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(d).first<{ seconds: number }>()
        .then((r) => r!.seconds);
      for (const [n, typedFirst] of [[44, true], [45, false]] as const) {
        const d = deviceId(n);
        await server.db.batch([
          server.db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, 1800)").bind(d, month()),
          server.db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES (?, 'monthly', ?, 'ACTIVE', ?, ?)")
            .bind("s" + n, period, now, period),
          server.db.prepare("INSERT INTO subscription_devices (device, token) VALUES (?, ?)").bind(d, "s" + n),
          server.db.prepare("INSERT INTO subscription_usage (token, period, seconds) VALUES (?, ?, 36000)").bind("s" + n, period),
          server.db.prepare("INSERT INTO credit (device, seconds) VALUES (?, 100)").bind(d),
        ]);
        // Both are held before either answers. The 60 s one is typed and settled first; the 61 s one is not typed (every
        // model busy) and is given back last.
        let typedGo!: () => void, failedGo!: () => void;
        const typedGate = new Promise<void>((r) => { typedGo = r; }), failedGate = new Promise<void>((r) => { failedGo = r; });
        server.stand.openrouter = async (body) => {
          if (Buffer.from((body.input_audio as { data: string }).data, "base64").length > 60.5 * 3000) {
            await failedGate;
            return Response.json({ error: { message: "busy" } }, { status: 503 });
          }
          await typedGate;
          return Response.json({ text: "hi", usage: { seconds: 60, cost: 60 * 0.15 / 3600 } });
        };
        const send = (seconds: number) => server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(seconds) });
        const first = send(typedFirst ? 60 : 61);
        await server.eventually(async () => openrouterCalls().length, (c) => c >= 1);
        const second = send(typedFirst ? 61 : 60);
        await server.eventually(async () => openrouterCalls().length, (c) => c >= 2);
        const [typed, failed] = typedFirst ? [first, second] : [second, first];
        typedGo();
        expect((await typed).status).toBe(200);
        await new Promise((r) => setTimeout(r, 200));   // its count, which the server makes after answering
        failedGo();
        expect((await failed).status).toBe(503);
        expect(await server.eventually(() => credit(d), (c) => c === 40)).toBe(40);
        server.calls.length = 0;
      }
    }, 30_000);

    it("never refuses unlimited given hours", async () => {
      await server.db.prepare("INSERT INTO grants (id, who, code, seconds, created_at) VALUES (1, 'Me', 'K7QM4XPA9TRW', NULL, 0)").run();
      await server.db.prepare("INSERT INTO grant_usage (grant_id, month, seconds) VALUES (1, ?, 1e9)").bind(month()).run();
      const res = await server.fetch("/v1/transcriptions", { method: "POST",
        headers: phone(deviceId(42), { token: false, code: "K7QM4XPA9TRW" }), body: recording(5) });
      expect(res.status).toBe(200);
    });

    describe("Yiddish takes, held before they are sent (the yiddishtry Worker's calls)", () => {
      let n = 0;
      const takeId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const freeUsed = (d: string) => server.db.prepare("SELECT seconds FROM usage WHERE device = ? AND month = ?").bind(d, month())
        .first<{ seconds: number }>().then((r) => r?.seconds ?? 0);
      const used = (d: string, seconds: number) =>
        server.db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, ?)").bind(d, month(), seconds).run();
      const check = (d: string, take: string, seconds: number) =>
        server.yiddish("check", d, deviceToken(d), null, take, seconds) as Promise<{ ok: boolean; held?: number; code?: string }>;

      it("lets no take through when several start at once on a phone's last second", async () => {
        const d = deviceId(30);
        await used(d, 1799);
        const answers = await Promise.all(Array.from({ length: 5 }, () => check(d, takeId(), 10)));
        expect(answers.map((x) => x.ok)).toEqual([false, false, false, false, false]);
        expect(answers[0]).toMatchObject({ status: 402, code: "free_minutes_used" });
        expect(await freeUsed(d)).toBe(1799);
      });

      it("holds one take of several at once when there is room for one, and counts what the model server measured, once", async () => {
        const d = deviceId(31);
        await used(d, 1775);   // 25 plan seconds left; a 10 s take holds 11 s of sound, 22 plan seconds
        const takes = Array.from({ length: 5 }, takeId);
        const answers = await Promise.all(takes.map((t) => check(d, t, 10)));
        expect(answers.filter((x) => x.ok)).toEqual([{ ok: true, held: 11 }]);
        expect(await freeUsed(d)).toBe(1797);
        const held = takes[answers.findIndex((x) => x.ok)];
        await server.yiddish("charge", d, 10, null, held);
        expect(await freeUsed(d)).toBe(1795);
        // Counted once: the same call again, or a give-back after it, changes nothing.
        await server.yiddish("charge", d, 10, null, held);
        await server.yiddish("release", held);
        expect(await freeUsed(d)).toBe(1795);
      });

      it("gives a hold back once when the take wasn't typed", async () => {
        const d = deviceId(32);
        const t = takeId();
        expect(await check(d, t, 10)).toEqual({ ok: true, held: 11 });
        expect(await freeUsed(d)).toBe(22);
        await server.yiddish("release", t);
        await server.yiddish("release", t);
        await server.yiddish("charge", d, 10, null, t);
        expect(await freeUsed(d)).toBe(0);
      });

      it("holds a take whole on the next hours when the free minutes can't hold all of it", async () => {
        const d = deviceId(33), now = Date.now(), period = now + 20 * DAY;
        await used(d, 1790);
        await server.db.batch([
          server.db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES ('s33', 'monthly', ?, 'ACTIVE', ?, ?)")
            .bind(period, now, period),
          server.db.prepare("INSERT INTO subscription_devices (device, token) VALUES (?, 's33')").bind(d),
        ]);
        const t = takeId();
        expect(await check(d, t, 10)).toEqual({ ok: true, held: 11 });
        await server.yiddish("charge", d, 10, null, t);
        expect(await freeUsed(d)).toBe(1790);
        expect((await server.db.prepare("SELECT seconds FROM subscription_usage WHERE token = 's33'").first<{ seconds: number }>())!.seconds).toBe(20);
      });

      it("counts bought hours down to zero, never below, even for a take longer than its hold", async () => {
        const d = deviceId(34), now = Date.now(), period = now + 20 * DAY;
        await used(d, 1800);
        await server.db.batch([
          server.db.prepare("INSERT INTO subscriptions (token, product, expiry, state, checked, period) VALUES ('s34', 'monthly', ?, 'ACTIVE', ?, ?)")
            .bind(period, now, period),
          server.db.prepare("INSERT INTO subscription_devices (device, token) VALUES (?, 's34')").bind(d),
          server.db.prepare("INSERT INTO subscription_usage (token, period, seconds) VALUES ('s34', ?, 36000)").bind(period),
          server.db.prepare("INSERT INTO credit (device, seconds) VALUES (?, 30)").bind(d),
        ]);
        const credit = () => server.db.prepare("SELECT seconds FROM credit WHERE device = ?").bind(d).first<{ seconds: number }>().then((r) => r!.seconds);
        expect(await check(d, takeId(), 20)).toMatchObject({ ok: false, code: "hours_used" });   // 42 plan seconds don't fit in 30
        const t = takeId();
        expect(await check(d, t, 10)).toEqual({ ok: true, held: 11 });
        expect(await credit()).toBe(8);
        // A PC whose server.py doesn't know x-max-seconds typed 20 s: all that is left goes, and no more.
        await server.yiddish("charge", d, 20, null, t, "j34");
        expect(await credit()).toBe(0);
        await server.yiddish("refund", "j34");
        expect(await credit()).toBe(30);
      });

      it("gives a shared file back once when its job fails after it was counted", async () => {
        const d = deviceId(35);
        const t = takeId();
        expect(await check(d, t, 5)).toEqual({ ok: true, held: 6 });
        await server.yiddish("charge", d, 5, null, t, "cloud-job35");
        expect(await freeUsed(d)).toBe(10);
        for (let i = 0; i < 3; i++) await server.yiddish("refund", "cloud-job35");
        await server.yiddish("refund", "cloud-someone-else");
        expect(await freeUsed(d)).toBe(0);
        // A take that was only held, never counted, has nothing to give back through refund.
        const u = takeId();
        await check(d, u, 5);
        await server.yiddish("refund", "cloud-job35");
        expect(await freeUsed(d)).toBe(12);
      });

      it("lets the given hours of a code hold a take for a phone Google Play never vouched for", async () => {
        await server.db.prepare("INSERT INTO grants (id, who, code, seconds, created_at) VALUES (1, 'Friend', 'K7QM4XPA9TRW', 3600, 0)").run();
        await server.db.prepare("INSERT INTO grant_usage (grant_id, month, seconds) VALUES (1, ?, 3590)").bind(month()).run();
        const phoneWithCode = (n: number, take: string) =>
          server.yiddish("check", deviceId(n), null, "K7QM-4XPA-9TRW", take, 4) as Promise<{ ok: boolean; held?: number }>;
        const answers = await Promise.all([phoneWithCode(36, takeId()), phoneWithCode(37, takeId()), phoneWithCode(38, takeId())]);
        expect(answers.filter((x) => x.ok)).toEqual([{ ok: true, held: 5 }]);   // 10 plan seconds left, each holds 10
        expect(await freeUsed(deviceId(36)) + await freeUsed(deviceId(37)) + await freeUsed(deviceId(38))).toBe(0);
      });

      it("still serves a yiddishtry Worker from before holds: it only checks, and counts on what pays after", async () => {
        const d = deviceId(39);
        await used(d, 1799);
        expect(await server.yiddish("check", d, deviceToken(d), null)).toEqual({ ok: true });
        await server.yiddish("charge", d, 30, null);
        expect(await freeUsed(d)).toBe(1859);
      });

      it("checks and counts as before when the yiddish_takes table isn't there yet", async () => {
        const d = deviceId(40);
        await server.db.prepare("DROP TABLE yiddish_takes").run();
        try {
          expect(await check(d, takeId(), 10)).toEqual({ ok: true });
          expect(await freeUsed(d)).toBe(0);
        } finally {
          const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
          for (const s of schema.match(/CREATE (TABLE|INDEX) IF NOT EXISTS yiddish_takes[^;]+/g)!) await server.db.prepare(s).run();
        }
      });
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
