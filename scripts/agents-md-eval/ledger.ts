// The one persistent spend ledger (${OUT}/ledger.jsonl) shared by preflight, run and retries.
//   {kind:"reserve", rid, usd}            written before a call is spawned
//   {kind:"settle", rid, cost_usd, ...}   written by runClaude when the call ends (claude.ts)
//   {cost_usd, ...} without kind          legacy settled entries (early preflight runs)
// A reservation counts as its full $1 until a settle with a numeric cost_usd replaces it, so a
// killed, timed-out or cost-less call never releases its reservation.
import { appendFileSync, existsSync, readFileSync } from "fs";
import { parseEvents } from "./claude";

export const RESERVE_USD = 1;

export function spend(ledger: string): { settled: number; open: number; total: number } {
  const ev = existsSync(ledger) ? parseEvents(readFileSync(ledger, "utf8")) : [];
  const reserved = new Set(ev.filter((e) => e.kind === "reserve").map((e) => e.rid));
  const cost = new Map(ev.filter((e) => e.kind === "settle").map((e) => [e.rid, e.cost_usd]));
  let settled = 0, open = 0;
  for (const e of ev) if (e.kind === undefined) settled += typeof e.cost_usd === "number" ? e.cost_usd : RESERVE_USD;
  for (const rid of reserved) {
    const c = cost.get(rid);
    if (typeof c === "number") settled += c;
    else open += RESERVE_USD;
  }
  return { settled, open, total: settled + open };
}

let seq = 0;
/** Reserves $1 if settled + open + $1 <= cap; returns the reservation id, or null when the cap would be exceeded. */
export function reserve(ledger: string, cap: number, meta: Record<string, unknown>): string | null {
  // Synchronous read-check-append: atomic within this process (all jobs share one event loop).
  // shortcut: no cross-process lock, so two concurrent harness processes on one OUT could overshoot; add a lockfile if that ever happens.
  if (spend(ledger).total + RESERVE_USD > cap + 1e-9) return null;
  const rid = `${process.pid}-${Date.now()}-${seq++}`;
  appendFileSync(ledger, JSON.stringify({ kind: "reserve", rid, usd: RESERVE_USD, ...meta, ts: new Date().toISOString() }) + "\n");
  return rid;
}

/** Releases a reservation whose call was provably never spawned (worktree setup failed). */
export const settleUnlaunched = (ledger: string, rid: string, meta: Record<string, unknown>) =>
  appendFileSync(ledger, JSON.stringify({ kind: "settle", rid, ...meta, cost_usd: 0, launched: false, ts: new Date().toISOString() }) + "\n");
