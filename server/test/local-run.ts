/**
 * A local run of the server for tests: the Worker bundled the way `wrangler deploy` bundles it, in
 * Cloudflare's own runtime (Miniflare, workerd), with a local D1 database made from schema.sql. Every
 * request the Worker makes to the internet goes to stand-ins here instead (Google sign-in, Play
 * Integrity, the Play purchases API, OpenRouter); anything else is refused, so a test can never reach
 * a real service.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare, Response as MfResponse } from "miniflare";
import { oggOpus } from "./audio";

export { oggOpus, wav } from "./audio";

const SERVER = fileURLToPath(new URL("..", import.meta.url));

let bundled: string | null = null;
/** src/worker.ts bundled by `wrangler deploy --dry-run`, once per test run, into the ignored .wrangler folder. */
function bundle(): string {
  if (bundled) return bundled;
  const out = join(SERVER, ".wrangler", "local-test");
  execFileSync(process.execPath, [join(SERVER, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", out],
    { cwd: SERVER, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
  return (bundled = join(out, "worker.js"));
}

/** schema.sql as single statements, without its comments. */
function schemaStatements(): string[] {
  return readFileSync(join(SERVER, "schema.sql"), "utf8").replace(/--[^\n]*/g, "").split(";")
    .map((s) => s.trim()).filter(Boolean);
}

export const TABLES = ["usage", "models", "subscriptions", "subscription_devices", "subscription_usage", "credit",
  "topups", "grants", "grant_usage", "failed_checks", "yiddish_takes"];

/** What the stand-ins answer. Each test sets what it needs; the rest answer like a quiet, working service. */
export interface StandIns {
  /** OpenRouter's /api/v1/audio/transcriptions, given the JSON body and the key it was sent with. */
  openrouter: (body: Record<string, unknown>, key: string) => Promise<Response> | Response;
  /** Play's subscriptionsv2.get for a token. */
  subscription: (token: string) => Response;
  /** Play's purchases.products.get for a one-time product. */
  product: (product: string, token: string) => Response;
  /** Play's voidedpurchases.list, given its query. */
  voided: (query: URLSearchParams) => Response;
  /** Play Integrity's decodeIntegrityToken for a token. */
  integrity: (token: string) => Response;
}

export interface Call { host: string; path: string; key?: string; body?: Record<string, unknown> }

export const SECRET = "local-test-secret";
export const deviceToken = (device: string) => createHmac("sha256", SECRET).update(device).digest("hex");
/** A made-up device ID: 64 hex characters, like the app's hashed Android ID. */
export const deviceId = (n: number) => n.toString(16).padStart(64, "0");

function serviceAccount(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({ client_email: "local@test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
}

export interface LocalServer {
  mf: Miniflare;
  db: D1Database;
  stand: StandIns;
  calls: Call[];
  /** A request to the server, as the app sends it. */
  fetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response>;
  /** The Yiddish entrypoint (worker.ts), called the way the yiddishtry Worker calls it through its service binding. */
  yiddish(method: "check" | "charge" | "release" | "refund", ...args: unknown[]): Promise<unknown>;
  /** Empties every table and the list of calls, and puts the stand-ins back to their defaults. */
  reset(): Promise<void>;
  /** Waits for work the Worker does after answering (ctx.waitUntil) until [check] is true. */
  eventually<T>(check: () => Promise<T>, done: (v: T) => boolean): Promise<T>;
  dispose(): Promise<void>;
}

const quiet = (): StandIns => ({
  openrouter: () => Response.json({ text: "hello", usage: { seconds: 10, cost: 10 * 0.1 / 3600 } }),
  subscription: () => new Response("unknown", { status: 410 }),
  product: () => new Response("unknown", { status: 404 }),
  voided: () => Response.json({}),
  integrity: () => Response.json({ error: { message: "bad token" } }, { status: 400 }),
});

/**
 * Starts the server with [vars] on top of the live ones in wrangler.jsonc, plus test secrets. [others]: more Workers
 * in the same run (Miniflare options), such as the real yiddishtry Worker in yiddish-e2e.test.ts.
 */
export async function startLocal(vars: Record<string, string> = {}, extra: Record<string, unknown> = {},
                                 others: Record<string, unknown>[] = []): Promise<LocalServer> {
  const calls: Call[] = [];
  const stand: StandIns = quiet();
  // Miniflare 5 takes its own options shape; convertV4MiniflareOptions reads the documented one.
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "word-for-word",
    modules: true,
    // As text: given as a file path, workerd on Windows fails to start it ("internal error").
    script: readFileSync(bundle(), "utf8"),
    compatibilityDate: "2026-11-01",
    d1Databases: { DB: "wfw-local" },
    bindings: {
      FREE_SECONDS_PER_MONTH: "1800", REQUIRE_INTEGRITY: "true",
      OPENROUTER_KEY: "free-key", DEVICE_TOKEN_SECRET: SECRET, GOOGLE_SERVICE_ACCOUNT: serviceAccount(),
      ...vars,
    },
    ...extra,
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      const call: Call = { host: url.host, path: url.pathname };
      calls.push(call);
      let answer: Response;
      if (url.host === "oauth2.googleapis.com") answer = Response.json({ access_token: "stand-in", expires_in: 3600 });
      else if (url.host === "openrouter.ai" && url.pathname === "/api/v1/audio/transcriptions") {
        call.key = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
        call.body = await request.json() as Record<string, unknown>;
        answer = await stand.openrouter(call.body, call.key);
      } else if (url.host === "androidpublisher.googleapis.com") {
        const p = decodeURIComponent(url.pathname);
        const sub = p.match(/\/purchases\/subscriptionsv2\/tokens\/(.+)$/);
        const product = p.match(/\/purchases\/products\/([^/]+)\/tokens\/(.+)$/);
        answer = sub ? stand.subscription(sub[1]) : product ? stand.product(product[1], product[2])
          : p.endsWith("/purchases/voidedpurchases") ? stand.voided(url.searchParams) : new Response("no stand-in", { status: 599 });
      } else if (url.host === "playintegrity.googleapis.com") {
        answer = stand.integrity(((await request.json()) as { integrity_token: string }).integrity_token);
      } else answer = new Response("blocked: no stand-in for " + url.host, { status: 599 });
      // Miniflare wants its own Response class back.
      return new MfResponse(await answer.text(), { status: answer.status, headers: Object.fromEntries(answer.headers) });
    },
  }, {
    // Stands in for the yiddishtry Worker (yiddish-stt tryout/worker), which reaches the entrypoint by service binding.
    name: "yiddish-caller",
    modules: true,
    compatibilityDate: "2026-11-01",
    serviceBindings: { WFW: { name: "word-for-word", entrypoint: "Yiddish" } },
    script: "export default { async fetch(request, env) { const { method, args } = await request.json(); " +
      "return Response.json((await env.WFW[method](...args)) ?? null); } }",
  }, ...others] } as Parameters<typeof convertV4MiniflareOptions>[0]));
  const db = await mf.getD1Database("DB") as unknown as D1Database;
  for (const s of schemaStatements()) await db.prepare(s).run();
  return {
    mf, db, stand, calls,
    async fetch(path, init = {}) {
      const res = await mf.dispatchFetch("https://word-for-word.local" + path, {
        method: init.method ?? "GET", headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      // Back to Node's own Response, so tests read it like any other.
      return new Response(await res.text(), { status: res.status, headers: Object.fromEntries(res.headers) });
    },
    async yiddish(method, ...args) {
      const caller = await mf.getWorker("yiddish-caller");
      const res = await caller.fetch("https://yiddish-caller.local/", { method: "POST", body: JSON.stringify({ method, args }) });
      return res.json();
    },
    async reset() {
      for (const t of TABLES) await db.prepare("DELETE FROM " + t).run();
      calls.length = 0;
      Object.assign(stand, quiet());
    },
    async eventually(check, done) {
      // A test's own wait, not anything the server does: the Worker's after-answer work takes milliseconds.
      for (let i = 0; i < 100; i++) {
        const v = await check();
        if (done(v)) return v;
        await new Promise((r) => setTimeout(r, 50));
      }
      return check();
    },
    dispose: () => mf.dispose(),
  };
}

/** A phone's headers: its ID, the device token Google Play's check earns it, and an access code if given. */
export function phone(device: string, opts: { token?: boolean; code?: string } = {}): Record<string, string> {
  return { "X-Device-Id": device, "Content-Type": "application/json",
    ...(opts.token === false ? {} : { "X-Device-Token": deviceToken(device) }),
    ...(opts.code ? { "X-Access-Code": opts.code } : {}) };
}

/** A recording as the app sends it: Ogg Opus at the app's 24 kbit/s (about 3,000 bytes a second), base64. */
export function recording(seconds: number, extra: Record<string, unknown> = {}) {
  return { ...recordingOf(oggOpus(seconds)), ...extra };
}

/** A recording of [audio] in [format], base64, as a phone or a hand-made request would send it. */
export function recordingOf(audio: Buffer, format = "ogg") {
  return { model: "microsoft/mai-transcribe-2", input_audio: { data: audio.toString("base64"), format } };
}
