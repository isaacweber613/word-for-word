/**
 * The Worker's entry: the HTTP server in index.ts, plus the Yiddish entrypoint that only another
 * Worker with a service binding to it can call (the yiddishtry Worker in front of the Yiddish
 * model, yiddish-stt repo tryout/worker). Kept apart from index.ts so the tests run in Node.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import server, { yiddishCharge, yiddishCheck, type CheckAnswer, type Env } from "./index";
import { d1Store } from "./store";

export class Yiddish extends WorkerEntrypoint<Env> {
  /** Whether this phone may send a Yiddish take now. [token] is its X-Device-Token, [code] its X-Access-Code. */
  check(device: string, token: string | null, code?: string | null): Promise<CheckAnswer> {
    return yiddishCheck(this.env, d1Store(this.env.DB), device, token, new Date(), code);
  }

  /** Counts a Yiddish take of [seconds] that came back as text. */
  charge(device: string, seconds: number, code?: string | null): Promise<void> {
    return yiddishCharge(this.env, d1Store(this.env.DB), device, seconds, new Date(), code);
  }
}

export default server;
