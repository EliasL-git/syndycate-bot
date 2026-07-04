/**
 * Simple per-user rate limiter.
 * Tracks requests with a sliding window — max N requests per window.
 */

export class RateLimiter {
  private users = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 5, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a user is allowed to make a request.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  check(userId: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const timestamps = this.users.get(userId) ?? [];

    // Remove expired timestamps
    const valid = timestamps.filter(t => now - t < this.windowMs);
    this.users.set(userId, valid);

    if (valid.length >= this.maxRequests) {
      const oldest = valid[0];
      const retryAfterMs = this.windowMs - (now - oldest);
      return { allowed: false, retryAfterMs };
    }

    // Record this request
    valid.push(now);
    return { allowed: true };
  }

  /** Get current usage for a user */
  getUsage(userId: string): { used: number; max: number } {
    const now = Date.now();
    const timestamps = this.users.get(userId) ?? [];
    const valid = timestamps.filter(t => now - t < this.windowMs);
    return { used: valid.length, max: this.maxRequests };
  }

  /** Cleanup old entries periodically */
  cleanup(): void {
    const now = Date.now();
    for (const [userId, timestamps] of this.users) {
      const valid = timestamps.filter(t => now - t < this.windowMs);
      if (valid.length === 0) {
        this.users.delete(userId);
      } else {
        this.users.set(userId, valid);
      }
    }
  }
}

// Global instance: 5 requests per minute
export const rateLimiter = new RateLimiter(5, 60_000);

// Cleanup every 5 minutes
setInterval(() => rateLimiter.cleanup(), 300_000);
