/**
 * D1's statements over a local SQLite database in memory (Node's own node:sqlite), made from schema.sql, so a test
 * runs the store's real SQL (store.ts d1Store) without Cloudflare: batch() runs its statements in one transaction and
 * rolls all of them back when one fails, as D1 does.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Result = { results: unknown[]; meta: { changes: number }; success: true };

export function sqliteD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => {
    const exec = (): Result => {
      const s = db.prepare(sql);
      if (/^\s*SELECT/i.test(sql)) return { results: s.all(...(params as never[])), meta: { changes: 0 }, success: true };
      return { results: [], meta: { changes: Number(s.run(...(params as never[])).changes) }, success: true };
    };
    return {
      exec,
      bind: (...p: unknown[]) => statement(sql, p),
      run: async () => exec(),
      all: async () => exec(),
      first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { exec: () => Result }[]) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
