/**
 * The Worker's entry: the HTTP server in index.ts, plus the Yiddish entrypoint that only another
 * Worker with a service binding to it can call (the yiddishtry Worker in front of the Yiddish
 * model, yiddish-stt repo tryout/worker). Kept apart from index.ts so the tests run in Node.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import server, { yiddishCharge, yiddishCheck, yiddishRefund, yiddishRelease, type CheckAnswer, type Env } from "./index";
import { d1Store } from "./store";

export class Yiddish extends WorkerEntrypoint<Env> {
  /**
   * Whether this phone may send a Yiddish take now. [token] is its X-Device-Token, [code] its X-Access-Code. With
   * [take] (the Worker's id for it) and [seconds] (its length from its size), the take's time is also held, and the
   * answer's held is the most the model server may type (yiddishCheck).
   */
  check(device: string, token: string | null, code?: string | null, take?: string, seconds?: number): Promise<CheckAnswer> {
    return yiddishCheck(this.env, d1Store(this.env.DB), device, token, new Date(), code, fetch, (p) => this.ctx.waitUntil(p),
      { take, seconds });
  }

  /** Counts a Yiddish take of [seconds] that came back as text: a held [take] in place of its hold, once. */
  charge(device: string, seconds: number, code?: string | null, take?: string, job?: string | null): Promise<void> {
    return yiddishCharge(this.env, d1Store(this.env.DB), device, seconds, new Date(), code, take, job);
  }

  /** Gives back the hold of a [take] that wasn't typed, once. */
  release(take: string): Promise<void> {
    return yiddishRelease(d1Store(this.env.DB), take);
  }

  /** Gives back what a shared file was counted, once, when its job [job] failed after it started. */
  refund(job: string): Promise<void> {
    return yiddishRefund(d1Store(this.env.DB), job);
  }
}

export default server;
