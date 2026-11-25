/**
 * Attacks on a local run of the server (local-run.ts): the real Worker and a local D1 database, with
 * stand-ins for Google and OpenRouter. Review of 2026-11-25; each test failed before its fix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deviceId, phone, recording, startLocal, type LocalServer } from "./local-run";

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

    it("gives back what a recording held when no model typed it", async () => {
      const d = deviceId(2);
      server.stand.openrouter = () => Response.json({ error: { message: "busy" } }, { status: 503 });
      expect((await server.fetch("/v1/transcriptions", { method: "POST", headers: phone(d), body: recording(30) })).status).toBe(503);
      const used = await server.eventually(async () => (await server.db.prepare("SELECT seconds FROM usage WHERE device = ?")
        .bind(d).first<{ seconds: number }>())?.seconds ?? 0, (s) => s === 0);
      expect(used).toBe(0);
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
