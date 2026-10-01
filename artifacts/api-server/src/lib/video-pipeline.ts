import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { ReplitConnectors } from "@replit/connectors-sdk";
import OpenAI from "openai";
import { z } from "zod";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import {
  assertVideoFileWithinLimit,
  createVideoWorkDir,
  ingestVideoSource,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  persistPrivateVideo,
  removeVideoWorkDir,
} from "./video-ingest";
import { createAssCaptions, type TimedWord } from "./video-captions";
import { completeJob, refundJob, reserveCredits } from "./clipwise-store";

const MAX_TRANSCRIPTION_CHUNK_BYTES = 24 * 1024 * 1024;
const MAX_TRANSCRIPTION_WORDS = 100_000;
const SCRIBE_REQUEST_TIMEOUT_MS = 180_000;
const SCRIBE_MAX_ATTEMPTS = 2;
const SCORE_MODEL = "gpt-5.4-mini";
export const LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS = ["-protocol_whitelist", "file,pipe"] as const;
const WORKER_POLL_MS = 2_000;
const elevenLabs = new ReplitConnectors();

interface VideoJob {
  id: string;
  user_id: string;
  title: string | null;
  source_url: string | null;
  object_path: string | null;
  number_of_clips: number;
  caption_style: string;
  duration_seconds: number;
  watermarked: boolean;
}

interface VideoDbClient {
  query<T = unknown>(...args: any[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
  release(): void;
}

interface ProbeResult {
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number;
  height: number;
}

export interface ScoredCandidate {
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
  title: string;
  viralityScore: number | null;
  hookScore: number | null;
  storyScore: number | null;
  payoffScore: number | null;
  reason: string | null;
  hookReason: string | null;
  storyReason: string | null;
  payoffReason: string | null;
}

export interface ClipDurationBounds {
  minimumSeconds: number;
  maximumSeconds: number;
}

const scoreAssessmentSchema = z.object({
  title: z.string().min(1).max(120),
  viralityScore: z.number().finite().min(0).max(100),
  hookScore: z.number().finite().min(0).max(100),
  storyScore: z.number().finite().min(0).max(100),
  payoffScore: z.number().finite().min(0).max(100),
  reason: z.string().min(1).max(1_000),
  hookReason: z.string().min(1).max(400),
  storyReason: z.string().min(1).max(400),
  payoffReason: z.string().min(1).max(400),
});

const scoredCandidateSchema = scoreAssessmentSchema.extend({
  startSeconds: z.number().finite(),
  endSeconds: z.number().finite(),
  excerpt: z.string().min(1).max(1_000),
});

const scoredResponseSchema = z.object({
  candidates: z.array(scoredCandidateSchema).max(10),
});

const shortScoredResponseSchema = z.object({
  assessment: scoreAssessmentSchema,
});

let workerStarted = false;
let workerBusy = false;
let pollTimer: NodeJS.Timeout | undefined;
let dejavuFontDiscovery: Promise<{ directory: string; file: string }> | undefined;

export async function withJobAdvisoryLock<T>(
  client: VideoDbClient,
  jobId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const lock = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
    [jobId],
  );
  if (!lock.rows[0]?.locked) return { acquired: false };
  try {
    return { acquired: true, result: await operation() };
  } finally {
    await client.query(
      `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
      [jobId],
    ).catch(() => undefined);
  }
}

/**
 * Validates and persists a source before the queued job becomes worker-eligible.
 * Credits are reserved only after the media duration is known; duration_seconds
 * is deliberately written last so the persistent queue cannot claim early.
 */
export async function prepareVideo(jobId: string): Promise<void> {
  const lockClient = await pool.connect();
  try {
    const lease = await withJobAdvisoryLock(lockClient, jobId, async () => {
      let workDir: string | undefined;
      let stage = "loading";
      try {
        const result = await pool.query<VideoJob>(
          `SELECT id, user_id, title, source_url, object_path, number_of_clips,
                  caption_style, duration_seconds, watermarked
             FROM cw_jobs
            WHERE id = $1
            LIMIT 1`,
          [jobId],
        );
        const job = result.rows[0];
        if (!job) throw new Error("The video job could not be found.");
        if (job.duration_seconds != null) {
          throw new Error("This video job has already been prepared.");
        }
        workDir = await createVideoWorkDir();
        stage = "ingesting";
        const source = await ingestVideoSource({
          userId: job.user_id,
          sourceUrl: job.source_url,
          objectPath: job.object_path,
          workDir,
        });
        await assertVideoFileWithinLimit(source.localPath);
        stage = "probing";
        const probe = await probeVideo(source.localPath);
        validateProbe(probe);
        stage = "reserving";
        const storedSource = await pool.query(
          `UPDATE cw_jobs
              SET object_path = $2
            WHERE id = $1
              AND duration_seconds IS NULL
              AND status = 'queued'`,
          [jobId, source.objectPath],
        );
        if (storedSource.rowCount !== 1) {
          throw new Error("The video job changed while it was being prepared.");
        }
        await reserveCredits(jobId, probe.duration);
        // reserveCredits commits duration_seconds with its atomic reservation.
        // This final write makes the queued job eligible for the worker.
      } catch (error) {
        const message = safeFailureMessage(error);
        logger.warn({ jobId, stage, error: message }, "Clipwise video preparation failed");
        throw new Error(message);
      } finally {
        if (workDir) await removeVideoWorkDir(workDir).catch(() => undefined);
      }
    });
    // A concurrent submit/retry can observe the active preparation. Treat that
    // as already accepted; do not refund or fail the job being prepared.
    if (!lease.acquired) return;
  } finally {
    lockClient.release();
  }
}

/**
 * Starts a single-concurrency database-backed queue poller. A per-job
 * PostgreSQL advisory lock doubles as a lease: a dead process releases it, so
 * stale processing rows can safely be returned to the queue.
 */
export function startVideoWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  pollTimer = setInterval(() => {
    void pollVideoQueue();
  }, WORKER_POLL_MS);
  pollTimer.unref();
  void pollVideoQueue();
}

/**
 * Reports local integration prerequisites without issuing provider requests on
 * every system-status request. The ElevenLabs connector is authenticated by
 * ReplitConnectors and was capability-checked during setup.
 */
export function isVideoPipelineReady(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY &&
      process.env.AI_INTEGRATIONS_OPENAI_BASE_URL &&
      process.env.PRIVATE_OBJECT_DIR &&
      typeof globalThis.fetch === "function" &&
      typeof globalThis.FormData === "function" &&
      typeof globalThis.Blob === "function",
  );
}

async function pollVideoQueue(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await recoverOrphanedJobs();
    const claimed = await claimNextJob();
    if (claimed) await processClaimedJob(claimed.client, claimed.job);
  } catch (error) {
    logger.error(
      { error: safeFailureMessage(error) },
      "Clipwise worker poll failed",
    );
  } finally {
    workerBusy = false;
  }
}

async function recoverOrphanedJobs(): Promise<void> {
  const stale = await pool.query<{ id: string }>(
    `SELECT id FROM cw_jobs WHERE status = 'processing'`,
  );
  for (const { id } of stale.rows) {
    const client = await pool.connect();
    let lockAcquired = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
        [id],
      );
      if (!lock.rows[0]?.locked) continue;
      lockAcquired = true;
      await client.query(
        `UPDATE cw_jobs
            SET status = 'queued', stage = 'queued', progress = 0
          WHERE id = $1 AND status = 'processing'`,
        [id],
      );
    } finally {
      if (lockAcquired) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [id],
        ).catch(() => undefined);
      }
      client.release();
    }
  }

  const abandonedPreparations = await pool.query<{ id: string }>(
    `SELECT id
       FROM cw_jobs
      WHERE status = 'queued'
        AND duration_seconds IS NULL
        AND created_at < now() - interval '1 minute'`,
  );
  for (const { id } of abandonedPreparations.rows) {
    const client = await pool.connect();
    try {
      await withJobAdvisoryLock(client, id, async () => {
        const stillAbandoned = await pool.query<{ id: string }>(
          `SELECT id
             FROM cw_jobs
            WHERE id = $1
              AND status = 'queued'
              AND duration_seconds IS NULL
              AND created_at < now() - interval '1 minute'`,
          [id],
        );
        if (stillAbandoned.rows.length) {
          await refundJob(
            id,
            "Video preparation was interrupted. Please submit the video again to retry.",
          );
        }
      });
    } finally {
      client.release();
    }
  }
}

async function claimNextJob(): Promise<{ client: VideoDbClient; job: VideoJob } | null> {
  const client = await pool.connect();
  let lockAcquired = false;
  let lockedJobId: string | undefined;
  try {
    await client.query("BEGIN");
    const selected = await client.query<VideoJob>(
      `SELECT id, user_id, title, source_url, object_path, number_of_clips,
              caption_style, duration_seconds, watermarked
         FROM cw_jobs
        WHERE status = 'queued'
          AND duration_seconds IS NOT NULL
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const job = selected.rows[0];
    if (!job) {
      await client.query("COMMIT");
      client.release();
      return null;
    }
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [job.id],
    );
    if (!lock.rows[0]?.locked) {
      await client.query("ROLLBACK");
      client.release();
      return null;
    }
    lockAcquired = true;
    lockedJobId = job.id;
    await client.query(
      `UPDATE cw_jobs
          SET status = 'processing', stage = 'starting', progress = 1
        WHERE id = $1`,
      [job.id],
    );
    await client.query("COMMIT");
    return { client: client as unknown as VideoDbClient, job };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (lockAcquired && lockedJobId) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [lockedJobId],
        ).catch(() => undefined);
    }
    client.release();
    throw error;
  }
}

async function processClaimedJob(
  lockClient: VideoDbClient,
  job: VideoJob,
): Promise<void> {
  let workDir: string | undefined;
  let stage = "starting";
  try {
    if (!job.object_path?.startsWith("/objects/")) {
      throw new Error("The stored source video is unavailable.");
    }
    workDir = await createVideoWorkDir();
    const sourceFile = await new ObjectStorageService().getObjectEntityFile(job.object_path);
    const sourceLocalPath = join(workDir, "source-video");
    await pipelineToFile(
      sourceFile.createReadStream(),
      sourceLocalPath,
      MAX_VIDEO_BYTES,
      20 * 60 * 1000,
    );
    await assertVideoFileWithinLimit(sourceLocalPath);
    const probe = await probeVideo(sourceLocalPath);
    validateProbe(probe);

    await updateProgress(job.id, "transcribing", 15);
    stage = "transcribing";
    const words = await transcribeVideoAudio(sourceLocalPath, workDir, probe.duration);

    const desiredCount = Math.max(1, Math.min(10, Math.floor(job.number_of_clips || 1)));
    let candidates: ScoredCandidate[] = [];
    if (words.length) {
      await updateProgress(job.id, "scoring", 45);
      stage = "scoring";
      candidates = await scoreTranscript(words, probe.duration);
    }
    const chosen = selectCandidatesForProcessing(
      words,
      probe.duration,
      job.title,
      candidates,
      desiredCount,
    );
    if (!chosen.length) {
      throw new Error("The source did not contain enough verifiable clip moments. Try another video.");
    }

    await pool.query(`DELETE FROM cw_clips WHERE job_id = $1`, [job.id]);
    const outputRows: Array<{
      title: string;
      duration: number;
      transcript: string;
      objectPath: string;
      candidate: ScoredCandidate;
      localPath: string;
    }> = [];
    for (let index = 0; index < chosen.length; index += 1) {
      const candidate = chosen[index];
      if (!candidate) continue;
      stage = "rendering";
      const progress = 55 + Math.floor((index / chosen.length) * 32);
      await updateProgress(job.id, "rendering", progress);
      const clipDuration = candidate.endSeconds - candidate.startSeconds;
      const selectedWords = words
        .filter((word) => word.end > candidate.startSeconds && word.start < candidate.endSeconds)
        .map((word) => ({
          text: word.text,
          start: Math.max(0, word.start - candidate.startSeconds),
          end: Math.min(clipDuration, word.end - candidate.startSeconds),
        }))
        .filter((word) => word.end > word.start);
      const transcript = selectedWords.map((word) => word.text).join(" ").trim();
      if (!transcript && candidate.viralityScore !== null) {
        throw new Error("A selected clip did not have usable transcript text.");
      }
      const captionsPath = join(workDir, `captions-${index}.ass`);
      await writeFile(captionsPath, createAssCaptions(selectedWords, job.caption_style, clipDuration), "utf8");
      const outputPath = join(workDir, `clip-${index}.mp4`);
      await renderVerticalClip({
        sourcePath: sourceLocalPath,
        outputPath,
        captionsPath,
        startSeconds: candidate.startSeconds,
        durationSeconds: clipDuration,
        watermark: job.watermarked,
      });
      outputRows.push({
        title: candidate.title,
        duration: clipDuration,
        transcript,
        objectPath: "",
        candidate,
        localPath: outputPath,
      });
    }

    stage = "uploading";
    await updateProgress(job.id, "uploading", 90);
    const stableJobHash = createHash("sha256").update(job.id).digest("hex").slice(0, 24);
    for (let index = 0; index < outputRows.length; index += 1) {
      const row = outputRows[index];
      if (!row) continue;
      row.objectPath = await persistPrivateVideo(
        row.localPath,
        "clips",
        `clip-${stableJobHash}-${index + 1}.mp4`,
      );
    }

    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await transaction.query(`DELETE FROM cw_clips WHERE job_id = $1`, [job.id]);
      for (const row of outputRows) {
        await transaction.query(
          `INSERT INTO cw_clips
            (job_id, title, duration_seconds, virality_score, hook_score,
             story_score, payoff_score, transcript, object_path, score_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            job.id,
            row.title,
            row.duration,
            row.candidate.viralityScore === null
              ? null
              : Math.round(row.candidate.viralityScore),
            row.candidate.hookScore === null
              ? null
              : Math.round(row.candidate.hookScore),
            row.candidate.storyScore === null
              ? null
              : Math.round(row.candidate.storyScore),
            row.candidate.payoffScore === null
              ? null
              : Math.round(row.candidate.payoffScore),
            row.transcript,
            row.objectPath,
            createScoreReason(row.candidate),
          ],
        );
      }
      await transaction.query(
        `UPDATE cw_jobs SET stage = 'finishing', progress = 98 WHERE id = $1 AND status = 'processing'`,
        [job.id],
      );
      await transaction.query("COMMIT");
    } catch (error) {
      await transaction.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      transaction.release();
    }
    await completeJob(job.id);
    logger.info(
      { jobId: job.id, clips: outputRows.length },
      "Clipwise video job completed",
    );
  } catch (error) {
    const message = safeFailureMessage(error);
    await pool.query(`DELETE FROM cw_clips WHERE job_id = $1`, [job.id]).catch(() => undefined);
    try {
      await refundJob(job.id, message);
    } catch (refundError) {
      logger.error(
        { jobId: job.id, stage, error: safeFailureMessage(refundError) },
        "Clipwise processing refund failed",
      );
    }
    logger.warn({ jobId: job.id, stage, error: message }, "Clipwise video job failed");
  } finally {
    if (workDir) await removeVideoWorkDir(workDir).catch(() => undefined);
    try {
      await lockClient.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
        [job.id],
      );
    } catch {
      // A disconnected client releases its advisory lock automatically.
    }
    lockClient.release();
  }
}

async function updateProgress(jobId: string, stage: string, progress: number): Promise<void> {
  await pool.query(
    `UPDATE cw_jobs SET stage = $2, progress = $3 WHERE id = $1 AND status = 'processing'`,
    [jobId, stage, progress],
  );
}

export function validateProbe(probe: ProbeResult): void {
  if (!probe.hasVideo) throw new Error("The source file does not contain a video track.");
  if (!probe.hasAudio) throw new Error("The source file does not contain an audio track.");
  if (
    !Number.isInteger(probe.width) ||
    !Number.isInteger(probe.height) ||
    probe.width <= 0 ||
    probe.height <= 0 ||
    probe.width > 16_384 ||
    probe.height > 16_384 ||
    probe.width * probe.height > 100_000_000
  ) {
    throw new Error("The source video dimensions exceed the processing limit.");
  }
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new Error("The source video has an invalid duration.");
  }
  if (probe.duration > MAX_VIDEO_SECONDS) {
    throw new Error("Videos must be no longer than 3 hours.");
  }
}

async function probeVideo(path: string): Promise<ProbeResult> {
  const output = await runProcess(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      ...LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS,
      path,
    ],
    { timeoutMs: 60_000, stdoutLimit: 2 * 1024 * 1024 },
  );
  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  try {
    parsed = JSON.parse(output.stdout) as typeof parsed;
  } catch {
    throw new Error("The source file could not be validated as a video.");
  }
  return {
    duration: Number(parsed.format?.duration),
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
    hasVideo: parsed.streams?.some((stream) => stream.codec_type === "video") ?? false,
    width: parsed.streams?.find((stream) => stream.codec_type === "video")?.width ?? 0,
    height: parsed.streams?.find((stream) => stream.codec_type === "video")?.height ?? 0,
  };
}

async function transcribeVideoAudio(
  sourcePath: string,
  workDir: string,
  videoDuration: number,
): Promise<TimedWord[]> {
  await runProcess(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-threads", "2",
      ...LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS,
      "-i", sourcePath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libmp3lame", "-b:a", "32k",
      "-f", "segment", "-segment_time", "600", "-reset_timestamps", "1",
      join(workDir, "audio-%03d.mp3"),
    ],
    { timeoutMs: 60 * 60 * 1000, stderrLimit: 3_000 },
  );
  const chunks = (await readdir(workDir))
    .filter((name) => /^audio-\d{3}\.mp3$/.test(name))
    .sort();
  if (!chunks.length) throw new Error("Audio could not be extracted from the source video.");

  const allWords: TimedWord[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunkName = chunks[index];
    if (!chunkName) continue;
    const chunkPath = join(workDir, chunkName);
    const size = (await readFileStats(chunkPath)).size;
    if (size > MAX_TRANSCRIPTION_CHUNK_BYTES) {
      throw new Error("An audio segment exceeded the 25 MB transcription limit.");
    }
    const audioBytes = await readFile(chunkPath);
    let attempts = 0;
    let transcription: TimedWord[];
    try {
      transcription = await transcribeScribeWords(
        audioBytes,
        undefined,
        SCRIBE_REQUEST_TIMEOUT_MS,
        (failure) => {
          attempts += 1;
          logger.warn(
            {
              chunk: index + 1,
              attempt: attempts,
              category: failure.scribeCategory,
              ...(failure.status ? { status: failure.status } : {}),
              ...(failure.diagnosticCategory
                ? { diagnosticCategory: failure.diagnosticCategory }
                : {}),
              ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
            },
            "ElevenLabs Scribe attempt failed",
          );
        },
      );
    } catch (error) {
      throw new Error(formatScribeFailureForUser(asScribeFailure(error)));
    }
    const offset = index * 600;
    for (const word of transcription) {
      const start = Math.max(0, Math.min(videoDuration, offset + word.start));
      const end = Math.max(start, Math.min(videoDuration, offset + word.end));
      if (end > start) allWords.push({ text: word.text, start, end });
      if (allWords.length > MAX_TRANSCRIPTION_WORDS) {
        throw new Error("The transcript is too large to process safely.");
      }
    }
  }
  return allWords.sort((left, right) => left.start - right.start);
}

const scribeResponseSchema = z.object({
  words: z.array(
    z.object({
      text: z.string().nullable().optional(),
      start: z.number().finite().nullable().optional(),
      end: z.number().finite().nullable().optional(),
      type: z.string().nullable().optional(),
    }).passthrough(),
  ),
});

type ScribeResponse = z.infer<typeof scribeResponseSchema>;
type ScribeFailureCategory =
  | "http_status"
  | "timeout"
  | "network"
  | "invalid_json"
  | "invalid_response"
  | "invalid_word_timestamps";
type ScribeDiagnosticCategory =
  | "provider_invalid_api_key"
  | "provider_missing_permissions"
  | "provider_quota"
  | "provider_insufficient_credits"
  | "provider_free_tier_disabled"
  | "provider_activity_restriction"
  | "provider_rate_limit"
  | "proxy_identity_unauthorized"
  | "unauthorized_unknown"
  | "provider_error_unknown";
type ScribeProviderCode =
  | "invalid_api_key"
  | "missing_permissions"
  | "insufficient_permissions"
  | "permission_denied"
  | "quota_exceeded"
  | "insufficient_quota"
  | "insufficient_credits"
  | "free_tier_disabled"
  | "free_tier_contention"
  | "free_tier_restricted"
  | "rate_limit_exceeded"
  | "unusual_activity"
  | "suspicious_activity"
  | "automated_activity"
  | "invalid_replit_token"
  | "replit_identity_unauthorized"
  | "identity_token_invalid";
type ScribeFailure = Error & {
  scribeCategory: ScribeFailureCategory;
  status?: number;
  diagnosticCategory?: ScribeDiagnosticCategory;
  providerCode?: ScribeProviderCode;
  retryable: boolean;
};

export async function transcribeScribeChunk(
  audioBytes: Buffer,
  proxyFetch: typeof fetch = elevenLabs.createProxyFetch("elevenlabs"),
  timeoutMs = SCRIBE_REQUEST_TIMEOUT_MS,
): Promise<ScribeResponse> {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("timestamps_granularity", "word");
  form.append(
    "file",
    new Blob([Uint8Array.from(audioBytes)], { type: "audio/mpeg" }),
    "audio.mp3",
  );

  const controller = new AbortController();
  let rejectDeadline!: (error: ScribeFailure) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const failure = createScribeFailure("timeout", undefined, true);
    controller.abort(failure);
    rejectDeadline(failure);
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await Promise.race([
        proxyFetch("/v1/speech-to-text", {
          method: "POST",
          body: form,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      if (isScribeFailure(error)) throw error;
      throw createScribeFailure("network", undefined, true);
    }
    if (!response.ok) {
      const errorPayload = await readScribeErrorPayload(response, deadline);
      const diagnostic = classifyScribeErrorPayloadDetails(errorPayload, response.status);
      throw createScribeFailure(
        "http_status",
        response.status,
        response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
        diagnostic.category,
        diagnostic.providerCode,
      );
    }
    let payload: unknown;
    try {
      payload = await Promise.race([response.json(), deadline]);
    } catch (error) {
      if (isScribeFailure(error)) throw error;
      throw createScribeFailure("invalid_json", undefined, true);
    }
    const parsed = scribeResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw createScribeFailure("invalid_response", undefined, true);
    }
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeScribeWords(
  audioBytes: Buffer,
  proxyFetch: typeof fetch = elevenLabs.createProxyFetch("elevenlabs"),
  timeoutMs = SCRIBE_REQUEST_TIMEOUT_MS,
  onAttemptFailure?: (failure: ScribeFailure) => void,
): Promise<TimedWord[]> {
  return withRetries(async () => {
    try {
      return extractTimedScribeWords(
        await transcribeScribeChunk(audioBytes, proxyFetch, timeoutMs),
      );
    } catch (error) {
      const failure = asScribeFailure(error);
      onAttemptFailure?.(failure);
      throw failure;
    }
  }, SCRIBE_MAX_ATTEMPTS);
}

const SCRIBE_ERROR_BODY_LIMIT_BYTES = 16 * 1024;

async function readScribeErrorPayload(
  response: Response,
  deadline: Promise<never>,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (bytesRead < SCRIBE_ERROR_BODY_LIMIT_BYTES) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        text += decoder.decode();
        break;
      }
      if (!value) continue;
      const remaining = SCRIBE_ERROR_BODY_LIMIT_BYTES - bytesRead;
      const boundedChunk = value.subarray(0, remaining);
      text += decoder.decode(boundedChunk, { stream: true });
      bytesRead += boundedChunk.byteLength;
    }
  } catch (error) {
    if (isScribeFailure(error)) throw error;
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function classifyScribeErrorPayload(
  payload: unknown,
  httpStatus: number,
): ScribeDiagnosticCategory {
  return classifyScribeErrorPayloadDetails(payload, httpStatus).category;
}

function classifyScribeErrorPayloadDetails(
  payload: unknown,
  httpStatus: number,
): {
  category: ScribeDiagnosticCategory;
  providerCode?: ScribeProviderCode;
} {
  const codes: string[] = [];
  const messages: string[] = [];
  const codeKeys = new Set(["code", "status", "error_code", "type"]);
  const messageKeys = new Set(["error", "message", "detail", "description", "msg"]);
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 5) return;
    if (typeof value === "string") {
      const normalizedKey = key.toLowerCase();
      if (codeKeys.has(normalizedKey)) {
        codes.push(value.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
      }
      if (messageKeys.has(normalizedKey)) messages.push(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 12)) visit(item, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value).slice(0, 32)) {
        if (
          codeKeys.has(childKey.toLowerCase()) ||
          messageKeys.has(childKey.toLowerCase())
        ) {
          visit(child, childKey, depth + 1);
        }
      }
    }
  };
  visit(payload, "", 0);
  const knownCodes: ScribeProviderCode[] = [
    "invalid_api_key",
    "missing_permissions",
    "insufficient_permissions",
    "permission_denied",
    "quota_exceeded",
    "insufficient_quota",
    "insufficient_credits",
    "free_tier_disabled",
    "free_tier_contention",
    "free_tier_restricted",
    "rate_limit_exceeded",
    "unusual_activity",
    "suspicious_activity",
    "automated_activity",
    "invalid_replit_token",
    "replit_identity_unauthorized",
    "identity_token_invalid",
  ];
  const providerCode = knownCodes.find((knownCode) => codes.includes(knownCode));
  const code = providerCode ?? codes.join(" ");
  const message = messages.join(" ");
  if (
    /invalid_?api_?key|api_?key_?invalid/.test(code) ||
    /invalid[_ ]api[_ ]key/.test(message)
  ) {
    return { category: "provider_invalid_api_key", providerCode };
  }
  if (
    /missing_?permissions?|insufficient_?permissions?|permission_?denied/.test(code) ||
    /missing[_ ]permissions?|insufficient[_ ]permissions?|permission denied/.test(message)
  ) {
    return { category: "provider_missing_permissions", providerCode };
  }
  if (code === "free_tier_disabled" || code === "free_tier_restricted") {
    return { category: "provider_free_tier_disabled", providerCode };
  }
  if (
    /free_?tier_?contention|unusual_?activity|suspicious_?activity|automated_?activity/.test(code) ||
    /unusual activity|suspicious activity|automated (?:traffic|activity|requests?)/.test(message)
  ) {
    return { category: "provider_activity_restriction", providerCode };
  }
  if (
    /free[- ]tier.{0,48}(disabled|not allowed|restricted|not enabled)|(?:disabled|restricted).{0,48}free[- ]tier/.test(message)
  ) {
    return { category: "provider_free_tier_disabled", providerCode };
  }
  if (
    /insufficient_credits/.test(code) ||
    /insufficient credits|not enough credits/.test(message)
  ) {
    return { category: "provider_insufficient_credits", providerCode };
  }
  if (
    /quota_exceeded|insufficient_quota/.test(code) ||
    /(?:quota|subscription limit|character limit|credits?).{0,40}(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|reached).{0,40}(?:quota|subscription limit|character limit|credits?)/.test(message)
  ) {
    return { category: "provider_quota", providerCode };
  }
  if (/rate_?limit/.test(code) || /rate limit/.test(message) || httpStatus === 429) {
    return { category: "provider_rate_limit", providerCode };
  }
  if (
    /invalid_?replit_?token|replit_?identity_?unauthorized|identity_?token_?invalid/.test(code) ||
    /replit.{0,32}(identity|token)|(identity|token).{0,32}(unauthorized|invalid|expired)|invalid (bearer )?token|token (is )?(invalid|expired)/.test(message)
  ) {
    return { category: "proxy_identity_unauthorized", providerCode };
  }
  if (httpStatus === 401) {
    return { category: "unauthorized_unknown", providerCode };
  }
  return { category: "provider_error_unknown", providerCode };
}

export function extractTimedScribeWords(response: ScribeResponse): TimedWord[] {
  const timedWords: TimedWord[] = [];
  for (const event of response.words) {
    if (event.type && event.type !== "word") continue;
    const text = event.text?.trim();
    if (!text) {
      if (event.type === "word") {
        throw createScribeFailure("invalid_response", undefined, true);
      }
      continue;
    }
    if (
      typeof event.start !== "number" ||
      typeof event.end !== "number" ||
      !Number.isFinite(event.start) ||
      !Number.isFinite(event.end) ||
      event.end <= event.start
    ) {
      throw createScribeFailure("invalid_word_timestamps", undefined, true);
    }
    timedWords.push({ text, start: event.start, end: event.end });
  }
  return timedWords;
}

function createScribeFailure(
  scribeCategory: ScribeFailureCategory,
  status?: number,
  retryable = false,
  diagnosticCategory?: ScribeDiagnosticCategory,
  providerCode?: ScribeProviderCode,
): ScribeFailure {
  const messages: Record<ScribeFailureCategory, string> = {
    http_status: "Scribe returned an HTTP error.",
    timeout: "Scribe transcription exceeded its request deadline.",
    network: "Scribe proxy request failed.",
    invalid_json: "Scribe returned invalid JSON.",
    invalid_response: "Scribe returned an unexpected response shape.",
    invalid_word_timestamps: "Scribe returned a speech word without valid timestamps.",
  };
  return Object.assign(new Error(messages[scribeCategory]), {
    scribeCategory,
    ...(status === undefined ? {} : { status }),
    ...(diagnosticCategory === undefined ? {} : { diagnosticCategory }),
    ...(providerCode === undefined ? {} : { providerCode }),
    retryable,
  });
}

function isScribeFailure(error: unknown): error is ScribeFailure {
  return (
    error instanceof Error &&
    "scribeCategory" in error &&
    typeof error.scribeCategory === "string"
  );
}

function asScribeFailure(error: unknown): ScribeFailure {
  if (isScribeFailure(error)) return error;
  return createScribeFailure("network", undefined, false);
}

export function formatScribeFailureForUser(error: ScribeFailure): string {
  if (error.scribeCategory === "http_status") {
    if (error.providerCode === "free_tier_disabled") {
      return "ElevenLabs returned free_tier_disabled: Scribe is unavailable for this free-tier account. Review account eligibility or contact ElevenLabs support; this is not a usage-quota diagnosis.";
    }
    if (error.providerCode === "free_tier_contention") {
      return "ElevenLabs restricted this free-tier request because of activity or network limits. Wait and retry later, or ask ElevenLabs support to review the restriction.";
    }
    if (error.providerCode === "quota_exceeded") {
      return "ElevenLabs returned quota_exceeded for Scribe. Check Scribe-specific or free-tier limits and account access with ElevenLabs before changing plans or buying credits; this code alone does not prove the overall account quota is exhausted.";
    }
    if (error.providerCode === "insufficient_quota") {
      return "ElevenLabs returned insufficient_quota for Scribe. Check Scribe-specific limits and account access with ElevenLabs before changing plans or buying credits.";
    }
    if (error.providerCode === "insufficient_credits") {
      return "ElevenLabs returned insufficient_credits for Scribe. Check the Scribe-specific credit balance and account eligibility with ElevenLabs before purchasing more credits.";
    }
    if (error.diagnosticCategory === "provider_free_tier_disabled") {
      return "ElevenLabs reports that Scribe is unavailable or restricted for this free-tier account. Review account eligibility or contact support.";
    }
    if (error.diagnosticCategory === "provider_activity_restriction") {
      return "ElevenLabs restricted this request because of activity or network limits. Wait and retry later, or ask support to review the restriction.";
    }
    if (error.diagnosticCategory === "provider_invalid_api_key") {
      return "ElevenLabs rejected the configured API key (invalid_api_key). Verify its key and account access.";
    }
    if (error.diagnosticCategory === "provider_missing_permissions") {
      return "ElevenLabs denied Scribe access (missing_permissions). Verify the key includes Scribe v1 permissions.";
    }
    if (error.diagnosticCategory === "provider_quota") {
      return "ElevenLabs reported an account usage or subscription limit. Check plan, usage, and account eligibility; the exact provider code was not available.";
    }
    if (error.diagnosticCategory === "provider_rate_limit") {
      return "ElevenLabs is rate-limiting transcription. Please retry in a few minutes.";
    }
    if (error.diagnosticCategory === "proxy_identity_unauthorized") {
      return "Replit connector identity was denied before ElevenLabs authorization. Verify the connector proxy identity.";
    }
    if (error.status === 401 || error.status === 403) {
      return `ElevenLabs Scribe access was denied (HTTP ${error.status}). Verify the configured connector and Scribe v1 access.`;
    }
    if (error.status === 429) {
      return "ElevenLabs Scribe is rate-limiting requests (HTTP 429). Please retry in a few minutes.";
    }
    if (error.status === 408 || error.status === 425) {
      return `ElevenLabs Scribe request timed out or was not ready (HTTP ${error.status}). Please retry.`;
    }
    if (error.status && error.status >= 500) {
      return `ElevenLabs Scribe returned HTTP ${error.status}. Please retry; if it continues, verify provider availability.`;
    }
    return `ElevenLabs Scribe rejected the transcription request (HTTP ${error.status ?? "unknown"}). Verify Scribe v1 access and the audio format.`;
  }
  if (error.scribeCategory === "timeout") {
    return "ElevenLabs Scribe did not respond within 180 seconds. The request was canceled; please retry.";
  }
  if (error.scribeCategory === "network") {
    return "The ElevenLabs Scribe connector could not complete the request. Verify connector availability and retry.";
  }
  return `ElevenLabs Scribe returned an unexpected word-timestamp response (${error.scribeCategory}). Please retry; if it persists, verify Scribe v1 access.`;
}

async function readFileStats(path: string): Promise<{ size: number }> {
  return stat(path);
}

function getOpenAiClient(): OpenAI {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error("OpenAI transcription and scoring are not configured on this server.");
  }
  return new OpenAI({ apiKey, baseURL });
}

export async function scoreTranscript(
  words: TimedWord[],
  duration: number,
): Promise<ScoredCandidate[]> {
  const client = getOpenAiClient();
  if (duration < 20 && words.length) {
    return [await scoreShortTranscript(client, words, duration)];
  }
  const segments = makeTranscriptSegments(words);
  const durationBounds = getClipDurationBounds(duration);
  const results: ScoredCandidate[][] = new Array(segments.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(2, segments.length) }, async () => {
    while (next < segments.length) {
      const index = next;
      next += 1;
      const segment = segments[index];
      if (!segment) continue;
      results[index] = await withRetries(() =>
        scoreTranscriptSegment(client, segment, duration, durationBounds),
      );
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.flat();
}

export async function scoreShortTranscript(
  client: OpenAI,
  words: TimedWord[],
  duration: number,
): Promise<ScoredCandidate> {
  if (!words.length) {
    throw new Error("A short-source assessment requires timed transcript words.");
  }
  if (duration <= 0 || duration >= 20 || !Number.isFinite(duration)) {
    throw new Error("Short-source scoring requires a valid duration below 20 seconds.");
  }
  const transcript = words
    .map((word) => `${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.text}`)
    .join("\n");
  let response;
  try {
    response = await withRetries(
      () =>
        client.chat.completions.create({
          model: SCORE_MODEL,
          max_completion_tokens: 2_048,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are carefully assessing one short-form video excerpt. Evaluate the entire supplied spoken or sung passage as ONE clip; do not search for or return multiple moments. It may begin or end mid-sentence or mid-lyric. Do not penalize it merely for being incomplete; instead honestly give low hook, story, payoff, or virality ratings when the passage is genuinely incomplete or weak. Do not invent or rewrite any words. Always return one assessment with a concise title, numeric virality, hook, story, and payoff scores from 0 to 100, plus a brief evidence-based overall reason and a brief reason for each score. Return only JSON matching {assessment:{title,viralityScore,hookScore,storyScore,payoffScore,reason,hookReason,storyReason,payoffReason}}.",
            },
            {
              role: "user",
              content: `The source is ${duration.toFixed(3)} seconds long. Assess the full timed-word passage:\n${transcript}`,
            },
          ],
        }),
      2,
    );
  } catch {
    throw new Error("Clip scoring is temporarily unavailable from the configured OpenAI integration.");
  }

  const content = response.choices[0]?.message.content;
  if (!content) throw new Error("Clip scoring returned no usable results.");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    throw new Error("Clip scoring returned an invalid response.");
  }
  const parsed = shortScoredResponseSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("Clip scoring returned invalid short-source assessment data.");
  return createShortSourceCandidate(words, duration, parsed.data.assessment);
}

export function createShortSourceCandidate(
  words: TimedWord[],
  duration: number,
  assessment: z.infer<typeof scoreAssessmentSchema>,
): ScoredCandidate {
  if (!words.length) {
    throw new Error("A short-source candidate requires actual timed transcript words.");
  }
  if (duration <= 0 || duration >= 20 || !Number.isFinite(duration)) {
    throw new Error("A short-source candidate requires a valid duration below 20 seconds.");
  }
  return {
    startSeconds: 0,
    endSeconds: duration,
    excerpt: words.map((word) => word.text).join(" "),
    ...assessment,
  };
}

function makeTranscriptSegments(words: TimedWord[]): TimedWord[][] {
  const segments: TimedWord[][] = [];
  let current: TimedWord[] = [];
  let currentChars = 0;
  for (const word of words) {
    const size = word.text.length + 24;
    if (current.length && currentChars + size > 12_000) {
      segments.push(current);
      // Include a small temporal overlap so a strong moment across a boundary
      // can still be assessed in both local narrative contexts.
      const boundary = current.at(-1)?.end ?? word.start;
      current = current.filter((entry) => entry.end >= boundary - 20);
      currentChars = current.reduce((sum, entry) => sum + entry.text.length + 24, 0);
    }
    current.push(word);
    currentChars += size;
  }
  if (current.length) segments.push(current);
  return segments;
}

async function scoreTranscriptSegment(
  client: OpenAI,
  words: TimedWord[],
  duration: number,
  durationBounds: ClipDurationBounds,
): Promise<ScoredCandidate[]> {
  const start = words[0]?.start ?? 0;
  const end = words.at(-1)?.end ?? start;
  const transcript = words
    .map((word) => `${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.text}`)
    .join("\n");
  let response;
  try {
    response = await client.chat.completions.create({
      model: SCORE_MODEL,
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You are a careful short-form video editor. Find up to 3 compelling, self-contained spoken moments with a hook, coherent story, and payoff. Each must be ${durationBounds.minimumSeconds.toFixed(3)}–${durationBounds.maximumSeconds.toFixed(3)} seconds, use timestamps within this provided transcript window and video duration, and provide an exact verbatim excerpt copied from the timestamped words (punctuation may vary but words may not). Do not invent speech. Score virality, hook, story, and payoff from 0–100. Give a brief evidence-based reason for each dimension. Return only JSON matching {candidates:[{startSeconds,endSeconds,excerpt,title,viralityScore,hookScore,storyScore,payoffScore,reason,hookReason,storyReason,payoffReason}]}. Titles and reasons must be concise.`,
        },
        {
          role: "user",
          content: `Video duration: ${duration.toFixed(2)} seconds. Transcript window: ${start.toFixed(2)} to ${end.toFixed(2)} seconds.\nTimestamped transcript:\n${transcript}`,
        },
      ],
    });
  } catch {
    throw new Error("Clip scoring is temporarily unavailable from the configured OpenAI integration.");
  }
  const content = response.choices[0]?.message.content;
  if (!content) throw new Error("Clip scoring returned no usable results.");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    throw new Error("Clip scoring returned an invalid response.");
  }
  const parsed = scoredResponseSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("Clip scoring returned invalid candidate data.");
  return parsed.data.candidates
    .map((candidate) =>
      validateCandidate(candidate, words, start, end, duration, durationBounds),
    )
    .filter((candidate): candidate is ScoredCandidate => candidate !== null);
}

export function getClipDurationBounds(sourceDuration: number): ClipDurationBounds {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error("The source video has an invalid duration.");
  }
  const maximumSeconds = Math.min(90, sourceDuration);
  return {
    minimumSeconds: sourceDuration < 20 ? sourceDuration * 0.5 : 20,
    maximumSeconds,
  };
}

export function createNoSpeechCandidate(
  sourceDuration: number,
  sourceTitle: string | null,
): ScoredCandidate {
  const duration = getClipDurationBounds(sourceDuration).maximumSeconds;
  return {
    startSeconds: 0,
    endSeconds: duration,
    excerpt: "",
    title: sourceTitle?.trim() || "Source clip",
    viralityScore: null,
    hookScore: null,
    storyScore: null,
    payoffScore: null,
    reason: null,
    hookReason: null,
    storyReason: null,
    payoffReason: null,
  };
}

export function selectClipCandidates(
  words: TimedWord[],
  sourceDuration: number,
  sourceTitle: string | null,
  scoredCandidates: ScoredCandidate[],
  requestedMaximum: number,
): ScoredCandidate[] {
  if (!words.length) {
    return [createNoSpeechCandidate(sourceDuration, sourceTitle)];
  }
  return chooseNonOverlapping(scoredCandidates, requestedMaximum);
}

export function selectCandidatesForProcessing(
  words: TimedWord[],
  sourceDuration: number,
  sourceTitle: string | null,
  scoredCandidates: ScoredCandidate[],
  requestedMaximum: number,
): ScoredCandidate[] {
  if (words.length && sourceDuration < 20) {
    if (!scoredCandidates.length) {
      throw new Error("Short-source scoring did not return an assessment.");
    }
    // Short sources are scored as one full-source clip; do not filter against
    // AI-generated excerpts or timestamps or require separate story/payoff arcs.
    return scoredCandidates.slice(0, 1);
  }
  return selectClipCandidates(
    words,
    sourceDuration,
    sourceTitle,
    scoredCandidates,
    requestedMaximum,
  );
}

function createScoreReason(candidate: ScoredCandidate): string {
  return [
    candidate.hookReason && `Hook: ${candidate.hookReason}`,
    candidate.storyReason && `Story: ${candidate.storyReason}`,
    candidate.payoffReason && `Payoff: ${candidate.payoffReason}`,
    candidate.reason && `Overall: ${candidate.reason}`,
  ]
    .filter((reason): reason is string => Boolean(reason))
    .join(" ")
    .slice(0, 1_500);
}

export function validateCandidate(
  candidate: ScoredCandidate,
  words: TimedWord[],
  windowStart: number,
  windowEnd: number,
  duration: number,
  durationBounds: ClipDurationBounds,
): ScoredCandidate | null {
  const requestedStart = Math.max(windowStart, 0, candidate.startSeconds);
  const requestedEnd = Math.min(windowEnd, duration, candidate.endSeconds);
  if (
    !Number.isFinite(requestedStart) ||
    !Number.isFinite(requestedEnd) ||
    requestedEnd <= requestedStart ||
    requestedStart < windowStart ||
    requestedEnd > windowEnd
  ) return null;
  const overlapping = words.filter(
    (word) => word.end > requestedStart && word.start < requestedEnd,
  );
  if (!overlapping.length) return null;
  const excerptWords = normalizeWords(candidate.excerpt);
  const actualWords = normalizeWords(overlapping.map((word) => word.text).join(" "));
  if (!excerptWords.length || excerptWords.join(" ") !== actualWords.join(" ")) return null;
  const startSeconds = overlapping[0]?.start ?? requestedStart;
  const endSeconds = overlapping.at(-1)?.end ?? requestedEnd;
  const clipLength = endSeconds - startSeconds;
  if (
    clipLength < durationBounds.minimumSeconds ||
    clipLength > durationBounds.maximumSeconds
  ) return null;
  return {
    ...candidate,
    startSeconds: Math.max(0, startSeconds),
    endSeconds: Math.min(duration, endSeconds),
    title: candidate.title.trim().slice(0, 100),
    reason: candidate.reason?.trim().slice(0, 1_000) ?? null,
    hookReason: candidate.hookReason?.trim().slice(0, 400) ?? null,
    storyReason: candidate.storyReason?.trim().slice(0, 400) ?? null,
    payoffReason: candidate.payoffReason?.trim().slice(0, 400) ?? null,
  };
}

function normalizeWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? [];
}

export function chooseNonOverlapping(
  candidates: ScoredCandidate[],
  limit: number,
): ScoredCandidate[] {
  const ordered = [...candidates].sort(
    (left, right) =>
      (right.viralityScore ?? -1) - (left.viralityScore ?? -1) ||
      (right.hookScore ?? -1) - (left.hookScore ?? -1) ||
      left.startSeconds - right.startSeconds,
  );
  const selected: ScoredCandidate[] = [];
  for (const candidate of ordered) {
    if (selected.every(
      (existing) =>
        candidate.endSeconds <= existing.startSeconds ||
        candidate.startSeconds >= existing.endSeconds,
    )) selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected.sort((left, right) => left.startSeconds - right.startSeconds);
}

async function withRetries<T>(
  task: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const retryable = (error as { retryable?: boolean } | null)?.retryable;
      if (attempt + 1 < maxAttempts && retryable !== false) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      } else {
        break;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Clip scoring failed after multiple attempts.");
}

async function renderVerticalClip({
  sourcePath,
  outputPath,
  captionsPath,
  startSeconds,
  durationSeconds,
  watermark,
}: {
  sourcePath: string;
  outputPath: string;
  captionsPath: string;
  startSeconds: number;
  durationSeconds: number;
  watermark: boolean;
}): Promise<void> {
  const fonts = await findDejaVuFonts();
  const escapedCaptionsPath = escapeFilterPath(captionsPath);
  const filters = [
    "scale=720:1280:force_original_aspect_ratio=increase",
    "crop=720:1280",
    `subtitles='${escapedCaptionsPath}':fontsdir='${escapeFilterPath(fonts.directory)}'`,
  ];
  if (watermark) {
    filters.push(
      `drawtext=text='Clipwise':fontfile='${escapeFilterPath(fonts.file)}':fontsize=23:fontcolor=white@0.68:shadowcolor=black@0.6:shadowx=1:shadowy=1:x=w-tw-22:y=24`,
    );
  }
  await runProcess(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", startSeconds.toFixed(3),
      ...LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS,
      "-i", sourcePath,
      "-t", durationSeconds.toFixed(3),
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-threads", "2", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-movflags", "+faststart",
      outputPath,
    ],
    { timeoutMs: 20 * 60 * 1000, stderrLimit: 4_000 },
  );
}

async function findDejaVuFonts(): Promise<{ directory: string; file: string }> {
  if (!dejavuFontDiscovery) dejavuFontDiscovery = discoverDejaVuFonts();
  return dejavuFontDiscovery;
}

async function discoverDejaVuFonts(): Promise<{ directory: string; file: string }> {
  const fileName = "DejaVuSans.ttf";
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/DejaVuSans.ttf",
    "/run/current-system/sw/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/run/current-system/sw/share/X11/fonts/TTF/DejaVuSans.ttf",
  ];
  for (const file of candidates) {
    if (await fileExists(file)) return { directory: dirname(file), file };
  }

  let storeEntries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    storeEntries = await readdir("/nix/store", { withFileTypes: true });
  } catch {
    // Fall through to the explicit configuration error below.
  }
  for (const entry of storeEntries) {
    if (!entry.isDirectory() || !/(dejavu|fonts?)/i.test(entry.name)) continue;
    const root = join("/nix/store", entry.name, "share", "fonts");
    const found = await findFontFile(root, fileName, 5);
    if (found) return { directory: dirname(found), file: found };
  }
  throw new Error("DejaVu Sans font files are unavailable for caption rendering.");
}

async function findFontFile(
  directory: string,
  fileName: string,
  depth: number,
): Promise<string | null> {
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === fileName && !entry.isDirectory()) {
      const file = join(directory, entry.name);
      if (await fileExists(file)) return file;
    }
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFontFile(join(directory, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function pipelineToFile(
  input: NodeJS.ReadableStream,
  outputPath: string,
  limit: number,
  timeoutMs: number,
): Promise<void> {
  let total = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) callback(new Error("The video exceeds the 4 GiB upload limit."));
      else callback(null, chunk);
    },
  });
  await streamPipeline(
    input,
    bounded,
    createWriteStream(outputPath, { flags: "wx" }),
    { signal: AbortSignal.timeout(timeoutMs) },
  );
}

async function runProcess(
  command: string,
  args: string[],
  {
    timeoutMs,
    stdoutLimit = 0,
    stderrLimit = 0,
  }: { timeoutMs: number; stdoutLimit?: number; stderrLimit?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", stdoutLimit > 0 ? "pipe" : "ignore", stderrLimit > 0 ? "pipe" : "ignore"],
      env: { ...process.env, OMP_NUM_THREADS: "2" },
    });
    let stdout = "";
    let stderr = "";
    let exceededLimit = false;
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > stdoutLimit) {
          exceededLimit = true;
          child.kill("SIGKILL");
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrLimit > 0) {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-stderrLimit);
        }
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`${command} is unavailable on this server.`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} exceeded its processing time limit.`));
      } else if (exceededLimit) {
        reject(new Error(`${command} produced too much output.`));
      } else if (code !== 0) {
        reject(new Error(`${command} could not process the supplied media.`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function safeFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The video could not be processed. Please try again.";
  const message = error.message
    .replace(/https?:\/\/\S+/gi, "[source]")
    .replace(/(?:\/(?:tmp|home|workspace|objects)\/)[^\s"'`]+/gi, "[file]")
    .replace(/(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
  return message || "The video could not be processed. Please try again.";
}