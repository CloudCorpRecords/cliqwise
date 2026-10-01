import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

type DbClient = { query: typeof pool.query };

export class ClipwiseError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ClipwiseError";
    this.statusCode = statusCode;
  }
}

function utcMonthStart(date = new Date()): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

function amount(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export async function ensureAccount(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cw_accounts (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    const account = await client.query<{ period_start: Date }>(
      `SELECT period_start FROM cw_accounts WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const periodStart = account.rows[0]?.period_start;
    if (!periodStart) {
      throw new Error("Could not initialize Clipwise account");
    }
    const thisMonth = utcMonthStart();
    if (new Date(periodStart) < thisMonth) {
      await client.query(
        `UPDATE cw_accounts SET free_credits = 60, period_start = $2 WHERE id = $1`,
        [userId, thisMonth],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockAccount(
  client: DbClient,
  userId: string,
): Promise<{ freeCredits: number; paidCredits: number; periodStart: Date }> {
  await client.query(
    `INSERT INTO cw_accounts (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
  let result = await client.query<{
    free_credits: string;
    paid_credits: string;
    period_start: Date;
  }>(
    `SELECT free_credits, paid_credits, period_start
     FROM cw_accounts WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  const account = result.rows[0];
  if (!account) {
    throw new Error("Could not load Clipwise account");
  }

  const thisMonth = utcMonthStart();
  const periodStart = new Date(account.period_start);
  if (periodStart < thisMonth) {
    result = await client.query<{
      free_credits: string;
      paid_credits: string;
      period_start: Date;
    }>(
      `UPDATE cw_accounts
       SET free_credits = 60, period_start = $2
       WHERE id = $1
       RETURNING free_credits, paid_credits, period_start`,
      [userId, thisMonth],
    );
    const resetAccount = result.rows[0];
    if (!resetAccount) {
      throw new Error("Could not reset monthly Clipwise credits");
    }
    return {
      freeCredits: amount(resetAccount.free_credits),
      paidCredits: amount(resetAccount.paid_credits),
      periodStart: new Date(resetAccount.period_start),
    };
  }

  return {
    freeCredits: amount(account.free_credits),
    paidCredits: amount(account.paid_credits),
    periodStart,
  };
}

export async function reserveCredits(
  jobId: string,
  durationSeconds: number,
): Promise<{ watermarked: boolean }> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ClipwiseError("Video duration must be greater than zero", 422);
  }
  const credits = Math.ceil((durationSeconds / 60) * 1000) / 1000;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      id: string;
      user_id: string;
      credit_source: string;
      credits_reserved: string;
      free_reserved: string;
      paid_reserved: string;
      watermarked: boolean;
      reservation_period: Date | null;
      status: string;
    }>(
      `SELECT id, user_id, credit_source, credits_reserved, free_reserved,
              paid_reserved, watermarked, reservation_period, status
       FROM cw_jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const job = selected.rows[0];
    if (!job) {
      throw new ClipwiseError("Job not found", 404);
    }
    if (amount(job.credits_reserved) > 0) {
      await client.query("COMMIT");
      return { watermarked: job.watermarked };
    }
    if (job.status !== "queued" && job.status !== "processing") {
      throw new ClipwiseError("Credits cannot be reserved for this job", 409);
    }

    const account = await lockAccount(client, job.user_id);
    let freeReserved = 0;
    let paidReserved = 0;
    if (job.credit_source === "free") {
      if (account.freeCredits < credits) {
        throw new ClipwiseError("Not enough free credits", 402);
      }
      freeReserved = credits;
    } else if (job.credit_source === "paid") {
      if (account.paidCredits < credits) {
        throw new ClipwiseError("Not enough paid credits", 402);
      }
      paidReserved = credits;
    } else if (job.credit_source === "auto") {
      paidReserved = Math.min(account.paidCredits, credits);
      freeReserved = credits - paidReserved;
      if (account.freeCredits < freeReserved) {
        throw new ClipwiseError("Not enough credits", 402);
      }
    } else {
      throw new ClipwiseError("Invalid credit source configured for job", 500);
    }

    const watermarked = freeReserved > 0;
    await client.query(
      `UPDATE cw_accounts
       SET free_credits = free_credits - $2,
           paid_credits = paid_credits - $3
       WHERE id = $1`,
      [job.user_id, freeReserved, paidReserved],
    );
    await client.query(
      `UPDATE cw_jobs
       SET credits_reserved = $2,
           free_reserved = $3,
           paid_reserved = $4,
           reservation_period = $5,
           watermarked = $6,
           credit_source = CASE WHEN $3 > 0 THEN 'free' ELSE 'paid' END
       WHERE id = $1`,
      [
        jobId,
        credits,
        freeReserved,
        paidReserved,
        account.periodStart,
        watermarked,
      ],
    );
    await client.query(
      `INSERT INTO cw_ledger (id, user_id, type, description, credits, job_id)
       VALUES ($1, $2, 'reserved', $3, $4, $5)`,
      [
        randomUUID(),
        job.user_id,
        `Reserved ${credits.toFixed(3)} credits for video job`,
        -credits,
        jobId,
      ],
    );
    await client.query("COMMIT");
    return { watermarked };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function refundJob(jobId: string, error: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      id: string;
      user_id: string;
      status: string;
      credits_reserved: string;
      free_reserved: string;
      paid_reserved: string;
      reservation_period: Date | null;
    }>(
      `SELECT id, user_id, status, credits_reserved, free_reserved,
              paid_reserved, reservation_period
       FROM cw_jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const job = selected.rows[0];
    if (!job) {
      throw new ClipwiseError("Job not found", 404);
    }
    if (job.status === "completed") {
      await client.query("COMMIT");
      return;
    }
    if (job.status === "failed") {
      await client.query("COMMIT");
      return;
    }

    const account = await lockAccount(client, job.user_id);
    const freeReserved = amount(job.free_reserved);
    const paidReserved = amount(job.paid_reserved);
    const reservationPeriod = job.reservation_period
      ? new Date(job.reservation_period)
      : null;
    const freeRefund =
      reservationPeriod &&
      reservationPeriod.getTime() === account.periodStart.getTime()
        ? freeReserved
        : 0;
    const paidRefund = paidReserved;
    if (freeRefund > 0 || paidRefund > 0) {
      await client.query(
        `UPDATE cw_accounts
         SET free_credits = free_credits + $2,
             paid_credits = paid_credits + $3
         WHERE id = $1`,
        [job.user_id, freeRefund, paidRefund],
      );
      await client.query(
        `INSERT INTO cw_ledger (id, user_id, type, description, credits, job_id)
         VALUES ($1, $2, 'refund', $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          job.user_id,
          "Credits refunded for failed video job",
          freeRefund + paidRefund,
          jobId,
        ],
      );
    }
    await client.query(
      `UPDATE cw_jobs
       SET status = 'failed', stage = 'failed', error = $2, completed_at = now()
       WHERE id = $1`,
      [jobId, error.slice(0, 2000)],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

export async function completeJob(jobId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      status: string;
      credits_reserved: string;
    }>(`SELECT status, credits_reserved FROM cw_jobs WHERE id = $1 FOR UPDATE`, [
      jobId,
    ]);
    const job = selected.rows[0];
    if (!job) {
      throw new ClipwiseError("Job not found", 404);
    }
    if (job.status === "completed") {
      await client.query("COMMIT");
      return;
    }
    if (job.status === "failed") {
      throw new ClipwiseError("A failed job cannot be completed", 409);
    }
    if (amount(job.credits_reserved) <= 0) {
      throw new ClipwiseError("Cannot complete a job without reserved credits", 409);
    }
    await client.query(
      `UPDATE cw_jobs
       SET status = 'completed', stage = 'completed', progress = 100,
           completed_at = COALESCE(completed_at, now()), error = NULL
       WHERE id = $1`,
      [jobId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createApiKey(
  userId: string,
  name: string,
): Promise<{ key: string; apiKey: Record<string, unknown> }> {
  const secret = `cw_live_${randomBytes(32).toString("base64url")}`;
  const prefix = secret.slice(0, 16);
  const id = randomUUID();
  const result = await pool.query<{
    id: string;
    name: string;
    prefix: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `INSERT INTO cw_keys (id, user_id, name, prefix, key_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, created_at, last_used_at, revoked_at`,
    [id, userId, name, prefix, createHash("sha256").update(secret).digest("hex")],
  );
  return { key: secret, apiKey: serializeKey(result.rows[0]) };
}

function serializeKey(row: {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at
      ? new Date(row.last_used_at).toISOString()
      : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

export async function listApiKeys(userId: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    prefix: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at
     FROM cw_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(serializeKey);
}

export async function revokeApiKey(
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE cw_keys SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function authenticateApiKey(
  token: string,
): Promise<string | null> {
  if (!token.startsWith("cw_live_") || token.length > 128) {
    return null;
  }
  const keyHash = createHash("sha256").update(token).digest("hex");
  const result = await pool.query<{ user_id: string }>(
    `UPDATE cw_keys
     SET last_used_at = now()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING user_id`,
    [keyHash],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function listActivity(
  userId: string,
): Promise<Record<string, unknown>[]> {
  const result = await pool.query<{
    id: string;
    description: string;
    credits: string;
    created_at: Date;
    type: string;
  }>(
    `SELECT id, description, credits, created_at, type
     FROM cw_ledger WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    description: row.description,
    credits: amount(row.credits),
    createdAt: new Date(row.created_at).toISOString(),
    type: row.type,
  }));
}

export async function listJobsForUser(userId: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id FROM cw_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows.map((row: { id: string }) => row);
}