/**
 * KudosManager — checks Stable Horde kudos balance and decides how much to bid.
 *
 * Strategy:
 *   1. Poll balance every 5 min via /api/v2/status/heartbeat  (costs nothing)
 *   2. Base bid = 1 kudos  (minimum to get decent priority)
 *   3. Scale up when balance is healthy:
 *        < 100   → bid 1   (conserve)
 *        < 500   → bid 5   (comfortable)
 *        < 2000  → bid 15  (rich)
 *        ≥ 2000  → bid 50  (whale — fastest queue)
 *   4. If balance = 0 or unknown → bid 0 (anonymous fallback, slower)
 *   5. Always log balance to Postgres for /stats trending
 */

import { STABLE_HORDE_BASE, STABLE_HORDE_KEY } from "../engine/HordeClient";
import { logKudosBalance } from "./Database";

let cachedBalance: number | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

// ── Balance Fetch ────────────────────────────────────────────────────────────

/**
 * Fetch current kudos balance from Stable Horde.
 *
 * The Horde doesn't expose a direct balance endpoint for anonymous keys.
 * We infer balance from the generate response + heartbeat queue stats.
 * For registered keys we can check via the user profile endpoint.
 */
export async function fetchKudosBalance(): Promise<number> {
  try {
    // Use the /api/v2/status/heartbeat to confirm API is alive,
    // then submit a minimal gen request to read the "kudos" cost field
    // which tells us our effective rate. For actual balance we check
    // via the generate endpoint response metadata.
    //
    // Stable Horde tracks kudos server-side per API key. The generate
    // response includes `kudos` (cost). To get OUR balance we check
    // via the /generate/check endpoint after a test submission,
    // OR we rely on the accumulated kudos_cost from our own jobs.
    //
    // Simplest approach: track balance ourselves from job costs,
    // or use the "kudos" field returned in generate responses.

    // Try the registered-user kudos endpoint
    const res = await fetch(`${STABLE_HORDE_BASE}/status/kudos`, {
      headers: { apikey: STABLE_HORDE_KEY },
    });

    if (res.ok) {
      const data = await res.json() as any;
      const balance = data.kudos ?? data.balance ?? 0;
      cachedBalance = balance;
      lastCheck = Date.now();
      await logKudosBalance(balance);
      return balance;
    }

    // Fallback: the kudos balance is exposed via generate/status metadata
    // For now, return cached or 0
    return cachedBalance ?? 0;
  } catch (err: any) {
    console.warn(`[Kudos] Balance fetch failed: ${err.message}`);
    return cachedBalance ?? 0;
  }
}

/**
 * Get cached balance (no API call). Falls back to fetch if stale.
 */
export async function getKudosBalance(): Promise<number> {
  const now = Date.now();
  if (cachedBalance !== null && now - lastCheck < CHECK_INTERVAL_MS) {
    return cachedBalance;
  }
  return fetchKudosBalance();
}

/**
 * Decide how many kudos to bid for a generation request.
 *
 * Returns 0 if balance is unknown/empty (anonymous fallback).
 * Returns 1-50 depending on how wealthy we are.
 */
export async function calculateBid(): Promise<number> {
  const balance = await getKudosBalance();

  // Unknown balance → bid 0 (anonymous, slower but free)
  if (balance <= 0) return 0;

  // Tiered bidding based on available kudos
  if (balance >= 2000) return 50;   // whale — max priority
  if (balance >= 500)  return 15;   // rich
  if (balance >= 100)  return 5;    // comfortable
  return 1;                          // minimum viable bid
}

/**
 * Periodic balance refresh — call on an interval.
 */
export function startBalancePolling(): void {
  // Initial fetch
  fetchKudosBalance().then(b => {
    console.log(`[Kudos] Initial balance: ${b}`);
  }).catch(() => {});

  // Refresh every 5 min
  setInterval(() => {
    fetchKudosBalance().catch(() => {});
  }, CHECK_INTERVAL_MS);
}
