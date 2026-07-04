/**
 * Database — PostgreSQL connection + schema for Syndycate bot.
 *
 * Tables:
 *   image_jobs   — tracks every Stable Horde generation (survives reboots)
 *   kudos_log    — records kudos balance snapshots for trending
 */

import * as pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // Render managed Postgres requires SSL
  max: 5,
  idleTimeoutMillis: 30_000,
});

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS image_jobs (
  id            SERIAL PRIMARY KEY,
  job_id        TEXT UNIQUE NOT NULL,        -- Stable Horde async job UUID
  user_id       TEXT NOT NULL,               -- Discord user ID
  channel_id    TEXT NOT NULL,               -- Discord channel ID
  prompt        TEXT NOT NULL,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | faulted | timeout
  kudos_cost    INTEGER DEFAULT 0,
  image_url     TEXT,                         -- final R2 URL when done
  eta_unix      BIGINT,                      -- estimated completion (unix ts)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS kudos_log (
  id            SERIAL PRIMARY KEY,
  balance       INTEGER NOT NULL,
  recorded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_jobs(status);
CREATE INDEX IF NOT EXISTS idx_image_jobs_user   ON image_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_kudos_log_time    ON kudos_log(recorded_at);
`;

// ── Init ─────────────────────────────────────────────────────────────────────

let initialised = false;

export async function initDB(): Promise<void> {
  if (initialised) return;
  await pool.query(SCHEMA);
  initialised = true;
  console.log("[DB] Schema ready");
}

// ── Image Jobs ───────────────────────────────────────────────────────────────

export interface ImageJob {
  id: number;
  jobId: string;
  userId: string;
  channelId: string;
  prompt: string;
  model: string | null;
  status: string;
  kudosCost: number;
  imageUrl: string | null;
  etaUnix: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function createJob(params: {
  jobId: string;
  userId: string;
  channelId: string;
  prompt: string;
  model?: string;
  etaUnix?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO image_jobs (job_id, user_id, channel_id, prompt, model, eta_unix)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING`,
    [params.jobId, params.userId, params.channelId, params.prompt, params.model ?? null, params.etaUnix ?? null],
  );
}

export async function updateJobStatus(
  jobId: string,
  status: string,
  extra: { kudosCost?: number; imageUrl?: string; etaUnix?: number } = {},
): Promise<void> {
  const sets = ["status = $2"];
  const vals: any[] = [jobId, status];
  let idx = 3;

  if (extra.kudosCost !== undefined) { sets.push(`kudos_cost = $${idx}`); vals.push(extra.kudosCost); idx++; }
  if (extra.imageUrl  !== undefined) { sets.push(`image_url  = $${idx}`); vals.push(extra.imageUrl);  idx++; }
  if (extra.etaUnix   !== undefined) { sets.push(`eta_unix    = $${idx}`); vals.push(extra.etaUnix);   idx++; }
  if (status === "done" || status === "faulted" || status === "timeout") {
    sets.push(`completed_at = NOW()`);
  }

  await pool.query(`UPDATE image_jobs SET ${sets.join(", ")} WHERE job_id = $1`, vals);
}

export async function getActiveJobs(): Promise<ImageJob[]> {
  const { rows } = await pool.query(
    `SELECT * FROM image_jobs WHERE status IN ('pending','processing') ORDER BY created_at`,
  );
  return rows.map(r => ({
    id: r.id,
    jobId: r.job_id,
    userId: r.user_id,
    channelId: r.channel_id,
    prompt: r.prompt,
    model: r.model,
    status: r.status,
    kudosCost: r.kudos_cost,
    imageUrl: r.image_url,
    etaUnix: r.eta_unix,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}

export async function getJobStats(): Promise<{
  total: number;
  active: number;
  completed: number;
  faulted: number;
  totalKudosSpent: number;
}> {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                       AS total,
      COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS active,
      COUNT(*) FILTER (WHERE status = 'done')::int       AS completed,
      COUNT(*) FILTER (WHERE status IN ('faulted','timeout'))::int   AS faulted,
      COALESCE(SUM(kudos_cost), 0)::int                  AS total_kudos_spent
    FROM image_jobs
  `);
  return rows[0];
}

// ── Kudos Log ────────────────────────────────────────────────────────────────

export async function logKudosBalance(balance: number): Promise<void> {
  await pool.query(`INSERT INTO kudos_log (balance) VALUES ($1)`, [balance]);
}

export async function getLatestKudosBalance(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT balance FROM kudos_log ORDER BY recorded_at DESC LIMIT 1`,
  );
  return rows[0]?.balance ?? null;
}

export async function getKudosTrend(): Promise<{ balance: number; recordedAt: Date }[]> {
  const { rows } = await pool.query(
    `SELECT balance, recorded_at AS "recordedAt" FROM kudos_log ORDER BY recorded_at DESC LIMIT 24`,
  );
  return rows;
}

// ── Pool util ────────────────────────────────────────────────────────────────

export async function closeDB(): Promise<void> {
  await pool.end();
}
