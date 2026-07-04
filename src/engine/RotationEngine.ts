/**
 * RotationEngine
 *
 * Owns the key pool. Keys are tagged by provider label ("groq" | "openrouter" | "openai" | "horde").
 * On each request the LRU (least-recently-used) healthy key is picked.
 * Rate-limited keys are cooldowned — 429 is honoured exactly, other failures use
 * exponential back-off; dead keys (401/403) are removed.
 */

export type ProviderLabel = "groq" | "openrouter" | "openai" | "horde" | "fal";

export interface ApiKeyEntry {
  key: string;
  provider: ProviderLabel;
  /** Optional custom base URL — set for groq / openrouter / horde so we don't hardcode them */
  baseURL?: string;
  /** Default model hint — used in /models fallback guidance, not enforced at runtime */
  model?: string;
  cooldownUntil: number;
  failures: number;
  lastUsed: number;
}

export interface RotationStats {
  totalKeys: number;
  healthyKeys: number;
  cooldownKeys: number;
  providerBreakdown: {
    groq:       { total: number; healthy: number };
    openrouter: { total: number; healthy: number };
    openai:     { total: number; healthy: number };
    horde:      { total: number; healthy: number };
    fal:        { total: number; healthy: number };
  };
}

export class KeyRotationEngine {
  private keys = new Map<string, ApiKeyEntry>();
  private readonly DEFAULT_BACKOFF_MS = 60_000;
  private readonly MAX_BACKOFF_MS    = 1_200_000;

  /**
   * Register a batch of keys for a given provider.
   *
   * @param raw        raw env string — comma or newline separated
   * @param provider   "groq" | "openrouter" | "openai"
   * @param baseURL    override API base (else uses provider default in the client)
   * @param model      preferred model for this key's provider
   */
  loadKeys(
    raw: string,
    provider: ApiKeyEntry["provider"],
    baseURL?: string,
    model?: string,
  ): number {
    const tokens = raw.split(/[,\n\r]+/).map(k => k.trim()).filter(k => k.length > 0);
    for (const key of tokens) {
      this.keys.set(key, {
        key,
        provider,
        baseURL,
        model,
        cooldownUntil: 0,
        failures: 0,
        lastUsed: 0,
      });
    }
    return tokens.length;
  }

  removeKey(key: string): boolean {
    return this.keys.delete(key);
  }

  acquire(provider?: ApiKeyEntry["provider"]): ApiKeyEntry | null {
    if (this.keys.size === 0) return null;

    const now = Date.now();

    // Expire stale cooldowns, lightly penalise consecutive failures
    for (const [, e] of this.keys) {
      if (e.cooldownUntil > 0 && now >= e.cooldownUntil) {
        e.cooldownUntil = 0;
        e.failures = Math.max(0, e.failures - 1);
      }
    }

    // Build healthy pool, prefer matching provider
    const pool    = [...this.keys.values()].filter(e => e.cooldownUntil <= now);
    const match   = provider ? pool.filter(e => e.provider === provider) : pool;
    const cands   = match.length > 0 ? match : pool;

    if (cands.length === 0) return null; // everything on cooldown

    // LRU — spread load evenly so no single key hot-spots
    cands.sort((a, b) => a.lastUsed - b.lastUsed);
    const chosen = cands[0];
    chosen.lastUsed = now;
    return chosen;
  }

  recordFailure(entry: ApiKeyEntry, retryAfterSeconds?: number): void {
    entry.failures += 1;
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      entry.cooldownUntil = Date.now() + retryAfterSeconds * 1_000;
    } else {
      const backoff = Math.min(
        this.DEFAULT_BACKOFF_MS * 2 ** (entry.failures - 1),
        this.MAX_BACKOFF_MS,
      );
      entry.cooldownUntil = Date.now() + backoff;
    }
  }

  /** Reset failure count on successful call. */
  recordSuccess(entry: ApiKeyEntry): void {
    entry.failures = 0;
    entry.cooldownUntil = 0;
  }

  /** Find and record failure by key string (for clients that only have the key). */
  recordFailureByKey(key: string, retryAfterSeconds?: number): boolean {
    const entry = this.keys.get(key);
    if (!entry) return false;
    this.recordFailure(entry, retryAfterSeconds);
    return true;
  }

  /** Find and record success by key string. */
  recordSuccessByKey(key: string): boolean {
    const entry = this.keys.get(key);
    if (!entry) return false;
    this.recordSuccess(entry);
    return true;
  }

  stats(): RotationStats {
    const now = Date.now();
    let healthy = 0, cooldown = 0;
    const groq       = { total: 0, healthy: 0 };
    const openrouter = { total: 0, healthy: 0 };
    const openai     = { total: 0, healthy: 0 };
    const horde      = { total: 0, healthy: 0 };
    const fal        = { total: 0, healthy: 0 };

    for (const [, e] of this.keys) {
      const h = e.cooldownUntil <= now;
      h ? healthy++ : cooldown++;
      if (e.provider === "groq")       { groq.total++;       if (h) groq.healthy++; }
      else if (e.provider === "openrouter") { openrouter.total++; if (h) openrouter.healthy++; }
      else if (e.provider === "openai")     { openai.total++;     if (h) openai.healthy++; }
      else if (e.provider === "horde")      { horde.total++;      if (h) horde.healthy++; }
      else if (e.provider === "fal")        { fal.total++;        if (h) fal.healthy++; }
    }

    return {
      totalKeys: this.keys.size,
      healthyKeys: healthy,
      cooldownKeys: cooldown,
      providerBreakdown: { groq, openrouter, openai, horde, fal },
    };
  }
}

export const keyEngine = new KeyRotationEngine();
