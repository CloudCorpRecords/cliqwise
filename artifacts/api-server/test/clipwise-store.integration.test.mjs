import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  completeJob,
  refundJob,
  reserveCredits,
} from "../src/lib/clipwise-store.ts";

if (process.env.NODE_ENV !== "development") {
  throw new Error(
    "Clipwise store integration tests must run with NODE_ENV=development.",
  );
}

const fixtureUserIds = [];

async function createJob(freeCredits = "10") {
  const userId = `clipwise-integration-${randomUUID()}`;
  const jobId = `clipwise-integration-${randomUUID()}`;
  fixtureUserIds.push(userId);
  await pool.query(
    `INSERT INTO cw_accounts (id, free_credits, paid_credits)
     VALUES ($1, $2, 0)`,
    [userId, freeCredits],
  );
  await pool.query(
    `INSERT INTO cw_jobs
       (id, user_id, title, credit_source, status, stage)
     VALUES ($1, $2, 'Isolated store integration test', 'free', 'queued', 'validating')`,
    [jobId, userId],
  );
  return { userId, jobId };
}

async function getAccountBalance(userId) {
  const result = await pool.query(
    `SELECT free_credits::text AS free_credits,
            paid_credits::text AS paid_credits
       FROM cw_accounts WHERE id = $1`,
    [userId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function getJob(jobId) {
  const result = await pool.query(
    `SELECT status, stage, duration_seconds::text AS duration_seconds,
            credits_reserved::text AS credits_reserved
       FROM cw_jobs WHERE id = $1`,
    [jobId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function getLedger(jobId) {
  const result = await pool.query(
    `SELECT type, COUNT(*)::int AS count, SUM(credits)::text AS credits
       FROM cw_ledger WHERE job_id = $1
      GROUP BY type`,
    [jobId],
  );
  return new Map(result.rows.map((row) => [row.type, row]));
}

after(async () => {
  try {
    const cleanupResults = await Promise.allSettled(
      fixtureUserIds.map((userId) =>
        pool.query(`DELETE FROM cw_accounts WHERE id = $1`, [userId]),
      ),
    );
    const cleanupFailure = cleanupResults.find(
      (result) => result.status === "rejected",
    );
    if (cleanupFailure?.status === "rejected") {
      throw cleanupFailure.reason;
    }
  } finally {
    await pool.end();
  }
});

test("concurrent reservation charges once and publishes duration-ready queued job", async () => {
  const { userId, jobId } = await createJob();
  const initialJob = await getJob(jobId);
  assert.equal(initialJob.duration_seconds, null);

  const notReady = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM cw_jobs
        WHERE id = $1 AND status = 'queued' AND duration_seconds IS NOT NULL
     ) AS ready`,
    [jobId],
  );
  assert.equal(notReady.rows[0].ready, false);

  const reservations = await Promise.all(
    Array.from({ length: 16 }, () => reserveCredits(jobId, 61)),
  );
  assert.ok(reservations.every((reservation) => reservation.watermarked));

  const job = await getJob(jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.stage, "queued");
  assert.equal(Number(job.duration_seconds), 61);
  assert.equal(job.credits_reserved, "1.017");

  const ready = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM cw_jobs
        WHERE id = $1 AND status = 'queued' AND duration_seconds IS NOT NULL
     ) AS ready`,
    [jobId],
  );
  assert.equal(ready.rows[0].ready, true);
  assert.deepEqual(await getAccountBalance(userId), {
    free_credits: "8.983",
    paid_credits: "0.000",
  });

  const ledger = await getLedger(jobId);
  assert.equal(ledger.get("reserved")?.count, 1);
  assert.equal(ledger.get("reserved")?.credits, "-1.017");
});

test("concurrent refunds restore reserved credits exactly once", async () => {
  const { userId, jobId } = await createJob("4");
  await reserveCredits(jobId, 60);

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      refundJob(jobId, `isolated integration failure ${index}`),
    ),
  );

  const job = await getJob(jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.stage, "failed");
  assert.deepEqual(await getAccountBalance(userId), {
    free_credits: "4.000",
    paid_credits: "0.000",
  });
  const ledger = await getLedger(jobId);
  assert.equal(ledger.get("reserved")?.count, 1);
  assert.equal(ledger.get("refund")?.count, 1);
  assert.equal(ledger.get("refund")?.credits, "1.000");
});

test("completed jobs are not refunded", async () => {
  const { userId, jobId } = await createJob("4");
  await reserveCredits(jobId, 60);
  await completeJob(jobId);
  await refundJob(jobId, "completed jobs must remain charged");

  const job = await getJob(jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.stage, "completed");
  assert.deepEqual(await getAccountBalance(userId), {
    free_credits: "3.000",
    paid_credits: "0.000",
  });
  const ledger = await getLedger(jobId);
  assert.equal(ledger.get("reserved")?.count, 1);
  assert.equal(ledger.has("refund"), false);
});