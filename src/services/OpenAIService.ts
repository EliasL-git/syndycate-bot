/**
 * FreeAIProvider
 *
 * Wraps the OpenAI-compatible SDK to hit either:
 *   • Groq       — https://api.groq.com/openai/v1  (free tier, fast)
 *   • OpenRouter — https://openrouter.ai/api/v1    (free tier, many models)
 *
 * The key rotation engine owns the pool; this class just turns a chosen key
 * into a live completion call with the right baseURL + model alias.
 */

import OpenAI from "openai";
import { keyEngine, type ApiKeyEntry } from "../engine/RotationEngine";

const MAX_RETRIES = 3;

// Friendly fallback says what env to set — never leaks a full key
const FALLBACK =
  "No free API keys configured yet.\n" +
  "• Groq:      set `GROQ_API_KEYS` (free at console.groq.com)\n" +
  "• OpenRouter: set `OPENROUTER_API_KEYS` (free at openrouter.ai)\n" +
  "• Fal.ai:    set `FAL_API_KEYS` (free at fal.ai)\n" +
  "Keys are comma or newline separated.\n" +
  "Run `!health` to see pool status.";

export interface ChatOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Preferred provider pool — "groq" | "openrouter" | "openai" */
  provider?: ApiKeyEntry["provider"];
  /** Override the per-key default model */
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface RotatedChatResult {
  content: string;
  keyUsed: string;           // redacted — last 4 chars only
  attempts: number;
  provider: string;          // "groq" | "openrouter" | "openai" | "none"
  fromFallback: boolean;
}

// -------------------------------------------------------------------------
/** Resolve per-provider defaults: baseURL + default model */
// -------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; model: string }> = {
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model:  "llama-3.3-70b-versatile",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    model:  "openrouter/auto",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    model:  "gpt-4o-mini",
  },
  fal: {
    baseURL: "https://fal.run",
    model:  "fal-ai/flux-pro/v1.1",
  },
};

// -------------------------------------------------------------------------

class FreeAIProvider {
  private clients = new Map<string, OpenAI>();

  // -----------------------------------------------------------------------
  /** Load all keys from env into the rotation engine. */
  // -----------------------------------------------------------------------
  bootstrap(): { loaded: number; healthy: number } {
    const groq        = keyEngine.loadKeys(process.env.GROQ_API_KEYS       ?? "", "groq");
    const openrouter  = keyEngine.loadKeys(process.env.OPENROUTER_API_KEYS ?? "", "openrouter");
    const horde       = keyEngine.loadKeys(process.env.HORDE_API_KEYS       ?? "", "horde");
    const fal         = keyEngine.loadKeys(process.env.FAL_API_KEYS         ?? "", "fal");
    // Optional: allow OPENAI_API_KEYS + OPENAI_BASE_URL for paid overflow
    const openai      = keyEngine.loadKeys(
      process.env.OPENAI_API_KEYS    ?? "",
      "openai",
      process.env.OPENAI_BASE_URL,
      process.env.OPENAI_MODEL,
    );
    const loaded = groq + openrouter + horde + fal + openai;
    return { loaded, healthy: keyEngine.stats().healthyKeys };
  }

  // -----------------------------------------------------------------------
  /** Run a chat completion with full rotation + retry. */
  // -----------------------------------------------------------------------
  async chat(opts: ChatOptions): Promise<RotatedChatResult> {
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Try preferred provider order each attempt so we cycle the pool
      const providers: ApiKeyEntry["provider"][] = [
        opts.provider ?? "groq",
        "openrouter",
        "openai",
      ];

      let entry: ApiKeyEntry | null = null;
      for (const prov of providers) {
        entry = keyEngine.acquire(prov);
        if (entry) break;
      }

      if (!entry) {
        return {
          content: FALLBACK,
          keyUsed: "",
          attempts: attempt - 1,
          provider: "none",
          fromFallback: true,
        };
      }

      const client = this.getOrCreateClient(entry);
      const def    = PROVIDER_DEFAULTS[entry.provider] ?? PROVIDER_DEFAULTS.openai;

      try {
        const response = await client.chat.completions.create({
          model: opts.model ?? entry.model ?? def.model,
          messages: [
            ...(opts.systemPrompt
              ? [{ role: "system" as const, content: opts.systemPrompt }]
              : []),
            ...opts.messages,
          ],
          max_tokens: opts.maxTokens ?? 1024,
        });

        const reply =
          response.choices?.[0]?.message?.content?.trim() ??
          "(empty response)";

        return {
          content: reply,
          keyUsed:  "***" + entry.key.slice(-4),
          attempts: attempt,
          provider: entry.provider,
          fromFallback: false,
        };
      } catch (err: any) {
        const status = err.status ?? err.statusCode ?? 0;
        const retryAfter = err.response?.headers?.["retry-after"];

        console.warn(
          `[${entry.provider}] attempt ${attempt} key=***${entry.key.slice(-4)} ` +
          `status=${status} retryAfter=${retryAfter ?? "none"}: ${err.message}`,
        );

        keyEngine.recordFailure(
          entry,
          retryAfter ? parseInt(retryAfter, 10) : undefined,
        );

        lastErr = err;

        // Auth errors = key is dead permanently
        if (status === 401 || status === 403) {
          keyEngine.removeKey(entry.key);
          continue; // loop will pick the next provider
        }
      }
    }

    return {
      content:
        `❌ All providers failed after ${MAX_RETRIES} attempts.\n` +
        (lastErr?.message ?? "Unknown error.") +
        "\n!health for pool status.",
      keyUsed: "",
      attempts: MAX_RETRIES,
      provider: "error",
      fromFallback: false,
    };
  }

  // -----------------------------------------------------------------------
  getStats() {
    return keyEngine.stats();
  }

  // -----------------------------------------------------------------------
  private getOrCreateClient(entry: ApiKeyEntry): OpenAI {
    const def = PROVIDER_DEFAULTS[entry.provider];
    // Cache by (key + baseURL) so different providers share no state
    const cacheKey = `${entry.provider}:${entry.key}`;
    let existing = this.clients.get(cacheKey);
    if (existing) return existing;
    const client = new OpenAI({
      apiKey:     entry.key,
      baseURL:    entry.baseURL ?? def.baseURL,
      // OpenRouter needs an explicit header for the free-tier models
      defaultHeaders: entry.provider === "openrouter"
        ? { "HTTP-Referer": "https://syndycate.dev", "X-Title": "Syndycate Bot" }
        : {},
    });
    this.clients.set(cacheKey, client);
    return client;
  }
}

// Singleton
export const ai = new FreeAIProvider();
