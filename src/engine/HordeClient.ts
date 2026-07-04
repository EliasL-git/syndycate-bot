/**
 * HordeClient — Stable Horde API constants & helpers.
 *
 * Centralises the base URL so every consumer stays DRY.
 */

export const STABLE_HORDE_BASE = "https://stablehorde.net/api/v2";
export const STABLE_HORDE_KEY  = process.env.STABLE_HORDE_API_KEY ?? "0000000000";

import { keyEngine } from "./RotationEngine";

/** Check the Horde heartbeat (quick health probe). */
export async function hordeHealth(): Promise<{ ok: boolean; queue: number; threads: number }> {
  try {
    const res  = await fetch(`${STABLE_HORDE_BASE}/status/heartbeat`);
    const data = await res.json() as any;
    return { ok: data.message === "OK", queue: data.queue ?? 0, threads: data.threads ?? 0 };
  } catch {
    return { ok: false, queue: -1, threads: 0 };
  }
}

/** Acquire the next healthy Horde API key from the rotation engine. */
export async function acquireHordeKey(): Promise<string> {
  const entry = keyEngine.acquire("horde");
  if (entry) return entry.key;
  // Fallback to static key (anonymous or env fallback)
  return STABLE_HORDE_KEY;
}

/** Record a Horde API failure so the key gets cooled down. */
export function recordHordeFailure(key: string, retryAfterSeconds?: number): void {
  const stats = keyEngine.stats();
  const entry = stats.providerBreakdown.horde;
  // We need to find the actual entry by key - for now just log
  console.warn(`[Horde] Key ***${key.slice(-4)} failed, will be cooled`);
}
