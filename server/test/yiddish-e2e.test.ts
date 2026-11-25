/**
 * Word for Word's Yiddish takes from end to end (review, 2026-11-25). The app sends a Yiddish take to the yiddishtry
 * Worker (yiddish-stt tryout/worker), which asks this server whether the phone may have it typed, sends it to the PC
 * or to the paid cloud copy, and has it counted here. This runs the real yiddishtry Worker and this server together in
 * Miniflare, joined by their service binding, in front of two stand-in model servers that run a real server.py's own
 * request handling with fixed text and no model (yiddishvoicetotext site/tools/e2e/fake_model_server.py; it prints
 * "typed <seconds>" each time it types). One stands in for the cloud copy, one for the PC. Nothing live is reached.
 *
 * Runs only when the other two projects are checked out:
 *   YIDDISHTRY_WORKER  yiddish-stt's tryout/worker folder (the Worker under test)
 *   YIDDISH_STANDIN    yiddishvoicetotext's site/tools/e2e/fake_model_server.py
 *   YIDDISH_CLOUD_PY   the cloud copy's server.py (yiddishvoicetotext runpod/app/tryout/server.py)
 *   YIDDISH_PC_PY      the PC's server.py (yiddish-stt tryout/server.py)
 * and Python with numpy, and ffmpeg, on PATH. `npx vitest run test/yiddish-e2e.test.ts`.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Response as MfResponse } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deviceId, deviceToken, startLocal, type LocalServer } from "./local-run";

const WORKER = process.env.YIDDISHTRY_WORKER, STANDIN = process.env.YIDDISH_STANDIN;
const CLOUD_PY = process.env.YIDDISH_CLOUD_PY, PC_PY = process.env.YIDDISH_PC_PY;
const SERVER = fileURLToPath(new URL("..", import.meta.url));
const month = () => new Date().toISOString().slice(0, 7);

/** The yiddishtry Worker bundled the way `wrangler deploy` bundles it: its script and the pages it imports as text. */
function bundleWorker(dir: string) {
  const out = join(SERVER, ".wrangler", "yiddishtry-test");
  rmSync(out, { recursive: true, force: true });
  execFileSync(process.execPath, [join(SERVER, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", out],
    { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
  return [{ type: "ESModule", path: join(out, "index.js"), contents: readFileSync(join(out, "index.js"), "utf8") },
    ...readdirSync(out).filter((f) => f.endsWith(".html"))
      .map((f) => ({ type: "Text", path: join(out, f), contents: readFileSync(join(out, f), "utf8") }))];
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

interface StandIn { proc: ChildProcess; port: number; typed: number[]; knowsLimit: boolean }
/** A stand-in model server running [serverPy]'s request handling; resolves once it listens. */
async function startStandIn(serverPy: string, secretFile: string): Promise<StandIn> {
  const port = await freePort();
  const proc = spawn("python", ["-P", STANDIN!, serverPy, String(port), secretFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const typed: number[] = [];
  let out = "", err = "";
  proc.stderr!.on("data", (d) => { err += d; });
  return new Promise((resolve, reject) => {
    proc.stdout!.on("data", (d) => {
      out += d;
      for (let i = out.indexOf("\n"); i >= 0; i = out.indexOf("\n")) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        const m = line.match(/^typed ([\d.]+)/);
        if (m) typed.push(Number(m[1]));
        if (line.startsWith("stand-in model server on")) resolve({ proc, port, typed, knowsLimit: line.includes("x-max-seconds known: True") });
      }
    });
    proc.on("exit", (code) => reject(new Error(`stand-in model server ended (${code}): ${err.slice(-500)}`)));
  });
}

/**
 * A 16-bit mono WAV of a tone, as the app records it (16 kHz). [rate]: another sample rate in the header, so the file
 * holds more or less time than its size says at the app's rate; [byteRate]: a made-up byte rate in the header.
 */
function wav(seconds: number, opts: { rate?: number; byteRate?: number } = {}): Uint8Array {
  const rate = opts.rate ?? 16000, n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(opts.byteRate ?? rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return new Uint8Array(b);
}

interface Sent { to: "pc" | "cloud"; path: string; limit: string | null }

describe.skipIf(!WORKER || !STANDIN || !CLOUD_PY || !PC_PY)("Yiddish takes through the real yiddishtry Worker", () => {
  let server: LocalServer, cloud: StandIn, pc: StandIn;
  const sent: Sent[] = [];
  let ip = 0;
  const secret = "e2e-" + Math.random().toString(36).slice(2);

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "yiddish-e2e-"));
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, secret);
    [cloud, pc] = await Promise.all([startStandIn(CLOUD_PY!, secretFile), startStandIn(PC_PY!, secretFile)]);
    const toStandIn = new Map([[`127.0.0.1:${cloud.port}`, "cloud"], [`127.0.0.1:${pc.port}`, "pc"]] as const);
    server = await startLocal({}, {}, [{
      name: "yiddishtry",
      modules: bundleWorker(WORKER!),
      compatibilityDate: "2026-11-01",
      durableObjects: { PC: { className: "PcState", useSQLite: true }, JUDGE: { className: "Judge", useSQLite: true } },
      r2Buckets: ["CLIPS"],
      ratelimits: { TRY_LIMIT: { namespace_id: "7303", simple: { limit: 60, period: 60 } } },
      serviceBindings: { WFW: { name: "word-for-word", entrypoint: "Yiddish" } },
      bindings: { SHARED: secret, CLOUD_SHARED: secret, TUNNEL_URL: `http://127.0.0.1:${pc.port}`, CLOUD_URL: `http://127.0.0.1:${cloud.port}` },
      // Only the two stand-ins can be reached; each call is listed with the length limit it carried.
      outboundService: async (request: Request) => {
        const url = new URL(request.url), to = toStandIn.get(url.host);
        if (!to) return new MfResponse("blocked: no stand-in for " + url.host, { status: 599 });
        if (url.pathname !== "/status") sent.push({ to, path: url.pathname, limit: request.headers.get("x-max-seconds") });
        const headers = Object.fromEntries([...request.headers].filter(([k]) => !["content-length", "host"].includes(k)));
        const res = await fetch(request.url, { method: request.method, headers,
          body: request.method === "GET" ? undefined : await request.arrayBuffer() });
        return new MfResponse(await res.arrayBuffer(), { status: res.status, headers: Object.fromEntries(res.headers) });
      },
    }]);
  }, 180_000);
  afterAll(async () => {
    await server?.dispose();
    cloud?.proc.kill();
    pc?.proc.kill();
  });
  beforeEach(async () => {
    await server.reset();
    sent.length = 0;
    cloud.typed.length = 0;
    pc.typed.length = 0;
    await pcFree(false);
  });

  /** The PC's state as tryout/status_push.py sends it: free, or busy (then everything goes to the cloud copy). */
  async function pcFree(free: boolean) {
    const res = await worker("/api/pc-status", { "x-shared": secret, "content-type": "application/json" },
      JSON.stringify({ busy: !free, busy_job: !free, slow_dictation: false, slow_public: false }));
    expect(res.status).toBe(200);
  }
  async function worker(path: string, headers: Record<string, string>, body: BodyInit) {
    const w = await server.mf.getWorker("yiddishtry");
    const res = await w.fetch("https://yiddishtry.local" + path, { method: "POST", headers, body });
    return new Response(await res.text(), { status: res.status, headers: Object.fromEntries(res.headers) });
  }
  /** A Yiddish take (or, with "/api/job", a shared file) as the app sends it, from a phone Google Play vouched for. */
  const take = (d: string, body: Uint8Array, path = "/api/transcribe") => worker(path, {
    "x-client": path === "/api/job" ? "app-share" : "app", "X-Device-Id": d, "X-Device-Token": deviceToken(d),
    "content-type": "audio/wav", "x-app-version": "e2e", "x-install": "e2e", "CF-Connecting-IP": `198.51.100.${++ip % 250}`,
  }, body);
  const jobStatus = (job: string) => worker("/api/job/status", { "content-type": "application/json", "CF-Connecting-IP": `198.51.100.${++ip % 250}` },
    JSON.stringify({ job }));
  const used = (d: string) => server.db.prepare("SELECT seconds FROM usage WHERE device = ? AND month = ?").bind(d, month())
    .first<{ seconds: number }>().then((r) => r?.seconds ?? 0);
  const freeLeft = (d: string, seconds: number) =>
    server.db.prepare("INSERT INTO usage (device, month, seconds) VALUES (?, ?, ?)").bind(d, month(), 1800 - seconds).run();
  /** The phone's usage once it stops changing (the Worker counts a take after answering, so a test waits for it). */
  const settled = async (d: string) => {
    let last = -1, same = 0;
    for (let i = 0; i < 100 && same < 5; i++) {
      const u = await used(d);
      same = u === last ? same + 1 : 0;
      last = u;
      await new Promise((r) => setTimeout(r, 50));
    }
    return last;
  };

  it("a phone with one second left starts four Yiddish takes at once: none is typed, nothing is counted", async () => {
    const d = deviceId(1);
    await freeLeft(d, 1);
    // Four: what one container of the cloud copy takes at once (backup/modal_app.py), and the stand-in's slots.
    const answers = await Promise.all(Array.from({ length: 4 }, () => take(d, wav(10))));
    console.log("one second left, four 10 s takes at once:", answers.map((r) => r.status), "typed on the cloud:", cloud.typed.length);
    expect(cloud.typed).toHaveLength(0);
    expect(answers.map((r) => r.status)).toEqual([402, 402, 402, 402]);
    expect((await answers[0].json() as { code: string }).code).toBe("free_minutes_used");
    expect(await settled(d)).toBe(1799);
  });

  it("room for one take: four at once, one is typed and counted its measured length, twice over", async () => {
    const d = deviceId(2);
    await freeLeft(d, 25);   // a 10 s take holds 22 plan seconds: 11 s of sound, twice
    const answers = await Promise.all(Array.from({ length: 4 }, () => take(d, wav(10))));
    console.log("25 plan seconds left, four 10 s takes at once:", answers.map((r) => r.status).sort(), "typed:", cloud.typed);
    expect(cloud.typed).toEqual([10]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 402, 402, 402]);
    expect(sent.every((s) => s.limit === "11")).toBe(true);
    expect(await settled(d)).toBe(1795);
  });

  it("a take whose header says it is a hundred times shorter is counted the length the model server measured", async () => {
    const d = deviceId(3);
    await freeLeft(d, 1800);
    expect((await take(d, wav(10, { byteRate: 3_200_000 }))).status).toBe(200);
    expect(cloud.typed).toEqual([10]);
    expect(await settled(d)).toBe(20);
  });

  it("a take longer than its size says is refused by the cloud copy before it is typed, and gives its hold back", async () => {
    const d = deviceId(4);
    await freeLeft(d, 1800);
    // 8 kHz: 10 s of sound in the size of 5 s at the app's 16 kHz, so the hold covers 6 s.
    const res = await take(d, wav(10, { rate: 8000 }));
    expect(cloud.knowsLimit).toBe(true);
    expect(res.status).toBe(402);
    expect(cloud.typed).toHaveLength(0);
    expect(sent.map((s) => s.limit)).toEqual(["6"]);
    expect(await settled(d)).toBe(0);
  });

  it("a take the model fails on gives its hold back, once", async () => {
    const d = deviceId(5);
    await freeLeft(d, 1800);
    expect((await take(d, wav(7))).status).toBe(500);   // the stand-in fails a 7 s take while typing it
    expect(await settled(d)).toBe(0);
  });

  it("a shared file is counted its measured length when its job starts, and given back once if the job fails later", async () => {
    const d = deviceId(6);
    await freeLeft(d, 1800);
    const ok = await take(d, wav(5), "/api/job");
    expect(ok.status).toBe(200);
    const good = (await ok.json() as { job: string }).job;
    expect(await settled(d)).toBe(10);
    const bad = await take(d, wav(7), "/api/job");
    const job = (await bad.json() as { job: string }).job;
    expect(job).toMatch(/^cloud-/);
    expect(await settled(d)).toBe(24);
    let status: { done?: boolean; error?: string } = {};
    for (let i = 0; i < 20 && !status.done; i++) {
      status = await (await jobStatus(job)).json();
      if (!status.done) await new Promise((r) => setTimeout(r, 100));
    }
    expect(status.error).toBeTruthy();
    for (let i = 0; i < 3; i++) await jobStatus(job);   // the app asks again; the Worker sees the failure each time
    for (let i = 0; i < 3; i++) await jobStatus(good);
    expect(await settled(d)).toBe(10);
  });

  it("the PC gets the same limit, and a take it types is counted its measured length", async () => {
    const d = deviceId(7);
    await freeLeft(d, 1800);
    await pcFree(true);
    expect((await take(d, wav(10))).status).toBe(200);
    expect(sent).toEqual([{ to: "pc", path: "/", limit: "11" }]);
    expect(pc.typed).toEqual([10]);
    expect(await settled(d)).toBe(20);
    // A take longer than its size says: the PC's server.py refuses it once it knows x-max-seconds (yiddish-stt PR 2);
    // before that it types it, and it is counted all of what the PC measured.
    const res = await take(d, wav(10, { rate: 8000 }));
    if (pc.knowsLimit) {
      expect(res.status).toBe(402);
      expect(await settled(d)).toBe(20);
    } else {
      expect(res.status).toBe(200);
      expect(await settled(d)).toBe(40);
    }
  });
});
