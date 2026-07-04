/**
 * Fal.ai Client
 *
 * Fast image generation via fal.ai REST API.
 * Uses the same key rotation engine as text providers.
 * Default model: fal-ai/flux-pro/v1.1 (Flux 1.1 Pro)
 */

import { keyEngine, type ApiKeyEntry } from "./RotationEngine";

export const FAL_BASE = "https://fal.run";

export interface FalGenerateInput {
  prompt: string;
  image_size?: "square_hd" | "square" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9";
  num_inference_steps?: number;
  guidance_scale?: number;
  num_images?: number;
  enable_safety_checker?: boolean;
  format?: "jpeg" | "png";
  seed?: number;
}

export interface FalGenerateOutput {
  images: Array<{
    url: string;
    width: number;
    height: number;
    content_type: string;
  }>;
  timings?: Record<string, number>;
  seed?: number;
  has_nsfw_concepts?: boolean[];
}

export interface FalQueueResponse {
  request_id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  response_url?: string;
}

/** Acquire the next healthy Fal API key from the rotation engine. */
export async function acquireFalKey(): Promise<string | null> {
  const entry = keyEngine.acquire("fal");
  if (entry) return entry.key;
  return null;
}

/** Record a Fal API failure so the key gets cooled down. */
export function recordFalFailure(key: string, retryAfterSeconds?: number): void {
  keyEngine.recordFailureByKey(key, retryAfterSeconds);
}

/** Record a successful Fal API call (resets failure count). */
export function recordFalSuccess(key: string): void {
  keyEngine.recordSuccessByKey(key);
}

/**
 * Submit a generation request to fal.ai.
 * Uses the queue-based async pattern: POST -> poll -> GET result.
 */
export async function falGenerate(
  key: string,
  input: FalGenerateInput,
  model: string = "fal-ai/flux-pro/v1.1",
  onProgress?: (status: string) => void,
): Promise<FalGenerateOutput> {
  const submitUrl = `${FAL_BASE}/${model}`;

  // 1. Submit job
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    let retryAfter: number | undefined;
    const ra = submitRes.headers.get("retry-after");
    if (ra) retryAfter = parseInt(ra, 10);

    const err = new Error(`Fal submit failed: ${submitRes.status} ${errText}`);
    (err as any).status = submitRes.status;
    (err as any).retryAfter = retryAfter;
    throw err;
  }

  const submitData = await submitRes.json() as FalQueueResponse;

  // If completed immediately (rare), return directly
  if (submitData.status === "COMPLETED" && submitData.response_url) {
    const resultRes = await fetch(submitData.response_url);
    return resultRes.json() as Promise<FalGenerateOutput>;
  }

  // 2. Poll for completion
  const requestId = submitData.request_id;
  const statusUrl = `${FAL_BASE}/${model}/requests/${requestId}`;

  const maxPolls = 120; // 2 minutes max (1s intervals)
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 1000));

    const statusRes = await fetch(statusUrl, {
      headers: {
        "Authorization": `Key ${key}`,
        "Accept": "application/json",
      },
    });

    if (!statusRes.ok) {
      const errText = await statusRes.text();
      const err = new Error(`Fal status check failed: ${statusRes.status} ${errText}`);
      (err as any).status = statusRes.status;
      throw err;
    }

    const statusData = await statusRes.json() as FalQueueResponse;

    if (onProgress) {
      onProgress(statusData.status);
    }

    if (statusData.status === "COMPLETED" && statusData.response_url) {
      const resultRes = await fetch(statusData.response_url);
      return resultRes.json() as Promise<FalGenerateOutput>;
    }

    if (statusData.status === "FAILED") {
      throw new Error("Fal generation failed");
    }
    // IN_QUEUE or IN_PROGRESS -> continue polling
  }

  throw new Error("Fal generation timed out");
}

/** Quick health check */
export async function falHealth(key: string): Promise<{ ok: boolean; models: string[] }> {
  try {
    const res = await fetch(`${FAL_BASE}/models`, {
      headers: { "Authorization": `Key ${key}` },
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json() as { models?: Array<{ id: string }> };
    return { ok: true, models: data.models?.map((m) => m.id) ?? [] };
  } catch {
    return { ok: false, models: [] };
  }
}