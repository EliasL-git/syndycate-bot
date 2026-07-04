/**
 * HordeClient — Stable Horde API constants & helpers.
 *
 * Centralises the base URL so every consumer stays DRY.
 */

export const STABLE_HORDE_BASE = "https://stablehorde.net/api/v2";
export const STABLE_HORDE_KEY  = process.env.STABLE_HORDE_API_KEY ?? "0000000000";

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
