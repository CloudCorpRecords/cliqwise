import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  ClipwiseError,
  completeJob,
  ensureAccount,
  refundJob,
} from "./clipwise-store";
import { prepareVideo } from "./video-pipeline";
import { clipContentUrl } from "./clip-links";

const ACTIVE_STATUSES = ["queued", "processing"];
const PREPARE_TIMEOUT_MS = 22 * 60_000;

export type SubmitJobInput = {
  title?: string;
  videoUrl?: string;
  objectPath?: string;
  numberOfClips: number;
  captionStyle: "bold" | "minimal" | "karaoke";
  creditSource: "auto" | "free" | "paid";
};

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getAccountSummary(
  userId: string,
): Promise<Record<string, unknown>> {
  await ensureAccount(userId);
  const [accountResult, usageResult] = await Promise.all([
    pool.query<{
      free_credits: string;
      paid_credits: string;
      period_start: Date;
    }>(
      `SELECT free_credits, paid_credits, period_start
       FROM cw_accounts WHERE id = $1`,
      [userId],
    ),
    pool.query<{
      minutes_processed: string;
      clips_created: string;
      jobs_count: string;
      active_jobs: string;
    }>(
      `SELECT
         COALESCE((SELECT SUM(duration_seconds) / 60
                   FROM cw_jobs WHERE user_id = $1 AND status = 'completed'), 0) AS minutes_processed,
         (SELECT COUNT(*) FROM cw_clips c
          JOIN cw_jobs j ON j.id = c.job_id
          WHERE j.user_id = $1) AS clips_created,
         (SELECT COUNT(*) FROM cw_jobs WHERE user_id = $1) AS jobs_count,
         (SELECT COUNT(*) FROM cw_jobs
          WHERE user_id = $1 AND status = ANY($2::text[])) AS active_jobs`,
      [userId, ACTIVE_STATUSES],
    ),
  ]);
  const account = accountResult.rows[0];
  const usage = usageResult.rows[0];
  if (!account || !usage) {
    throw new Error("Could not retrieve Clipwise account summary");
  }
  const freeCredits = numberValue(account.free_credits);
  const paidCredits = numberValue(account.paid_credits);
  const nextReset = new Date(account.period_start);
  nextReset.setUTCMonth(nextReset.getUTCMonth() + 1);
  return {
    id: userId,
    freeCredits,
    paidCredits,
    totalCredits: freeCredits + paidCredits,
    monthlyAllowance: 60,
    resetsAt: nextReset.toISOString(),
    minutesProcessed: numberValue(usage.minutes_processed),
    clipsCreated: Number(usage.clips_created),
    jobsCount: Number(usage.jobs_count),
    activeJobs: Number(usage.active_jobs),
  };
}

function serializeClip(row: {
  id: string;
  title: string;
  duration_seconds: string | number;
  virality_score: string | number;
  hook_score: string | number;
  story_score: string | number;
  payoff_score: string | number;
  transcript: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    durationSeconds: numberValue(row.duration_seconds),
    viralityScore: numberValue(row.virality_score),
    hookScore: numberValue(row.hook_score),
    storyScore: numberValue(row.story_score),
    payoffScore: numberValue(row.payoff_score),
    transcript: row.transcript,
    downloadUrl: clipContentUrl(row.id, true),
    previewUrl: clipContentUrl(row.id),
  };
}

function serializeJob(
  row: {
    id: string;
    title: string;
    status: string;
    progress: number;
    stage: string;
    created_at: Date;
    completed_at: Date | null;
    duration_seconds: string | number | null;
    number_of_clips: number;
    caption_style: string;
    credits_reserved: string | number;
    watermarked: boolean;
    error: string | null;
  },
  clips: Parameters<typeof serializeClip>[0][],
): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : null,
    durationSeconds:
      row.duration_seconds == null ? null : numberValue(row.duration_seconds),
    numberOfClips: row.number_of_clips,
    captionStyle: row.caption_style,
    creditsReserved: numberValue(row.credits_reserved),
    watermarked: row.watermarked,
    error: row.error,
    clips: clips.map(serializeClip),
  };
}

export async function getJobForUser(
  userId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{
    id: string;
    title: string;
    status: string;
    progress: number;
    stage: string;
    created_at: Date;
    completed_at: Date | null;
    duration_seconds: string | number | null;
    number_of_clips: number;
    caption_style: string;
    credits_reserved: string | number;
    watermarked: boolean;
    error: string | null;
  }>(
    `SELECT id, title, status, progress, stage, created_at, completed_at,
            duration_seconds, number_of_clips, caption_style,
            credits_reserved, watermarked, error
     FROM cw_jobs WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const job = result.rows[0];
  if (!job) {
    return null;
  }
  const clips = await pool.query<{
    id: string;
    title: string;
    duration_seconds: string | number;
    virality_score: string | number;
    hook_score: string | number;
    story_score: string | number;
    payoff_score: string | number;
    transcript: string;
  }>(
    `SELECT id, title, duration_seconds, virality_score, hook_score,
            story_score, payoff_score, transcript
     FROM cw_clips WHERE job_id = $1 ORDER BY virality_score DESC, id`,
    [id],
  );
  return serializeJob(job, clips.rows);
}

export async function listJobsForUser(
  userId: string,
): Promise<Record<string, unknown>[]> {
  const ids = await pool.query<{ id: string }>(
    `SELECT id FROM cw_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  const jobs = await Promise.all(
    ids.rows.map(({ id }) => getJobForUser(userId, id)),
  );
  return jobs.filter((job): job is Record<string, unknown> => job !== null);
}

function inferTitle(input: SubmitJobInput): string {
  if (input.title?.trim()) {
    return input.title.trim();
  }
  if (input.objectPath) {
    const basename = input.objectPath.split("/").pop();
    return basename || "Uploaded video";
  }
  if (input.videoUrl) {
    try {
      const url = new URL(input.videoUrl);
      return url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    } catch {
      return "Video";
    }
  }
  return "Video";
}

function prepareWithTimeout(jobId: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new ClipwiseError("Video preparation timed out", 504)),
      PREPARE_TIMEOUT_MS,
    );
    timeout.unref?.();
  });
  return Promise.race([prepareVideo(jobId), deadline]).finally(() =>
    clearTimeout(timeout),
  );
}

export async function submitJob(
  userId: string,
  input: SubmitJobInput,
): Promise<Record<string, unknown>> {
  if (Boolean(input.videoUrl) === Boolean(input.objectPath)) {
    throw new ClipwiseError("Provide exactly one of videoUrl or objectPath", 400);
  }
  if (input.videoUrl) {
    let source: URL;
    try {
      source = new URL(input.videoUrl);
    } catch {
      throw new ClipwiseError("videoUrl must be a valid HTTP or HTTPS URL", 400);
    }
    if (
      !/^https?:\/\//i.test(input.videoUrl) ||
      !["http:", "https:"].includes(source.protocol)
    ) {
      throw new ClipwiseError("videoUrl must be a valid HTTP or HTTPS URL", 400);
    }
  }

  await ensureAccount(userId);
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM cw_accounts WHERE id = $1 FOR UPDATE`, [
      userId,
    ]);
    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM cw_jobs
       WHERE user_id = $1 AND status = ANY($2::text[])`,
      [userId, ACTIVE_STATUSES],
    );
    if (Number(active.rows[0]?.count ?? 0) >= 3) {
      throw new ClipwiseError("You already have 3 active video jobs", 429);
    }
    await client.query(
      `INSERT INTO cw_jobs
       (id, user_id, title, source_url, object_path, number_of_clips,
        caption_style, credit_source, status, stage, progress)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'validating', 0)`,
      [
        id,
        userId,
        inferTitle(input).slice(0, 200),
        input.videoUrl ?? null,
        input.objectPath ?? null,
        input.numberOfClips,
        input.captionStyle,
        input.creditSource,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  try {
    await prepareWithTimeout(id);
    const job = await getJobForUser(userId, id);
    if (!job) {
      throw new Error("Video preparation completed but the job could not be loaded");
    }
    return job;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Video preparation failed";
    await refundJob(id, message);
    if (error instanceof ClipwiseError) {
      throw error;
    }
    throw new ClipwiseError(message, 422);
  }
}

export { completeJob, ensureAccount, refundJob };