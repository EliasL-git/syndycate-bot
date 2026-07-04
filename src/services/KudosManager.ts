/**
 * KudosManager — tracks Stable Horde kudos balance and decides bid amount.
 *
 * Stable Horde doesn't expose a balance endpoint. We track it by:
 *   1. Reading `kudos` field from generate/check responses (what we earned/spent)
 *   2. Persisting balance in Postgres kudos_log
 *   3. Starting balance from last known value
 *
 * Bid strategy (scales with wealth):
 *   0 kudos  → bid 0 (anonymous, slower)
 *   1-99     → bid 1 (minimum)
 *   100-499  → bid 5
 *   500-1999 → bid 15
 *   2000+    → bid 50 (whale)
 */

import { logKudosBalance, getLatestKudosBalance } from "./Database";

let cachedBalance: number | null = null;
let initialised = false;

// ── Init from DB ─────────────────────────────────────────────────────────────

export async function initKudos(): Promise<void> {
  if (initialised) return;
  const stored = await getLatestKudosBalance();
  if (stored !== null) {
    cachedBalance = stored;
    console.log(`[Kudos] Loaded balance from DB: ${stored}`);
  } else {
    // No history — assume 0 until first generation tells us otherwise
    cachedBalance = 0;
    console.log("[Kudos] No balance history, starting at 0");
  }
  initialised = true;
}

// ── Balance Get/Set ──────────────────────────────────────────────────────────

export function getKudosBalance(): number {
  return cachedBalance ?? 0;
}

/**
 * Update balance after a generation completes.
 * The `kudos` field in generate/check response = kudos we earned for that job.
 * We ADD it (workers pay us kudos for completing work on our behalf).
 */
export async function recordGeneration(kudosEarned: number): Promise<void> {
  if (cachedBalance === null) cachedBalance = 0;
  cachedBalance += kudosEarned;
  await logKudosBalance(cachedBalance);
  console.log(`[Kudos] +${kudosEarned} → balance: ${cachedBalance}`);
}

/**
 * Record kudos spent on a bid.
 */
export async function recordBid(kudosSpent: number): Promise<void> {
  if (cachedBalance === null) cachedBalance = 0;
  cachedBalance = Math.max(0, cachedBalance - kudosSpent);
  await logKudosBalance(cachedBalance);
  console.log(`[Kudos] -${kudosSpent} → balance: ${cachedBalance}`);
}

// ── Bid Calculator ───────────────────────────────────────────────────────────

export function calculateBid(): number {
  const balance = cachedBalance ?? 0;
  // Key is registered — always bid at least 1 kudos for priority
  // (anonymous "0000000000" gets no priority, our key does)
  if (balance <= 0) return 1;
  if (balance >= 2000) return 50;
  if (balance >= 500)  return 15;
  if (balance >= 100)  return 5;
  return 1;
}
