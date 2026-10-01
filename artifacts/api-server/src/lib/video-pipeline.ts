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
const SCORE_MODEL = "gpt-5.4-mini";
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

interface ScoredCandidate {
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
  title: string;
  viralityScore: number;
  hookScore: number;
  storyScore: number;
  payoffScore: number;
  reason: string;
  hookReason: string;
  storyReason: string;
  payoffReason: string;
}

const scoredResponseSchema = z.object({
  candidates: z.array(
    z.object({
      startSeconds: z.number().finite(),
      endSeconds: z.number().finite(),
      excerpt: z.string().min(1).max(1_000),
      title: z.string().min(1).max(120),
      viralityScore: z.number().finite().min(0).max(100),
      hookScore: z.number().finite().min(0).max(100),
      storyScore: z.number().finite().min(0).max(100),
      payoffScore: z.number().finite().min(0).max(100),
      reason: z.string().min(1).max(1_000),
      hookReason: z.string().min(1).max(400),
      storyReason: z.string().min(1).max(400),
      payoffReason: z.string().min(1).max(400),
    }),
  ).max(10),
});

let workerStarted = false;
let workerBusy = false;
let pollTimer: NodeJS.Timeout | undefined;
let dejavuFontDiscovery: Promise<{ directory: string; file: string }> | undefined;

/**
 * Validates and persists a source before the queued job becomes worker-eligible.
 * Credits are reserved only after the media duration is known; duration_seconds
 * is deliberately written last so the persistent queue cannot claim early.
 */
export async function prepareVideo(jobId: string): Promise<void> {
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
    // reserveCredits commits duration_seconds with its atomic reservation. That
    // is the final write that makes the queued job eligible for the worker.
  } catch (error) {
    const message = safeFailureMessage(error);
    logger.warn({ jobId, stage, error: message }, "Clipwise video preparation failed");
    throw new Error(message);
  } finally {
    if (workDir) await removeVideoWorkDir(workDir).catch(() => undefined);
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
    if (!words.length) throw new Error("No speech could be transcribed from the source video.");

    await updateProgress(job.id, "scoring", 45);
    stage = "scoring";
    const candidates = await scoreTranscript(words, probe.duration);
    const desiredCount = Math.max(1, Math.min(10, Math.floor(job.number_of_clips || 1)));
    const chosen = chooseNonOverlapping(candidates, desiredCount);
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
      if (!transcript) throw new Error("A selected clip did not have usable transcript text.");
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
            Math.round(row.candidate.viralityScore),
            Math.round(row.candidate.hookScore),
            Math.round(row.candidate.storyScore),
            Math.round(row.candidate.payoffScore),
            row.transcript,
            row.objectPath,
            `Hook: ${row.candidate.hookReason} Story: ${row.candidate.storyReason} Payoff: ${row.candidate.payoffReason} Overall: ${row.candidate.reason}`.slice(0, 1_500),
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

function validateProbe(probe: ProbeResult): void {
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
    const transcriptionError =
      "ElevenLabs Scribe v1 word-level transcription is unavailable or did not return timestamps. Verify the configured ElevenLabs connector and Scribe access.";
    let transcription: { words: Array<{ text: string; start: number; end: number; type?: string }> };
    try {
      const audioBytes = await readFile(chunkPath);
      transcription = await withRetries(() => transcribeScribeChunk(audioBytes));
    } catch {
      throw new Error(
        transcriptionError,
      );
    }
    const offset = index * 600;
    for (const word of transcription.words) {
      if (
        typeof word.text !== "string" ||
        typeof word.start !== "number" ||
        typeof word.end !== "number" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end)
      ) continue;
      if (word.type && word.type !== "word") continue;
      const start = Math.max(0, Math.min(videoDuration, offset + word.start));
      const end = Math.max(start, Math.min(videoDuration, offset + word.end));
      if (word.text.trim() && end > start) allWords.push({ text: word.text.trim(), start, end });
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
      text: z.string(),
      start: z.number().finite(),
      end: z.number().finite(),
      type: z.string().optional(),
    }),
  ),
});

async function transcribeScribeChunk(
  audioBytes: Buffer,
): Promise<{ words: Array<{ text: string; start: number; end: number; type?: string }> }> {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("timestamps_granularity", "word");
  form.append(
    "file",
    new Blob([Uint8Array.from(audioBytes)], { type: "audio/mpeg" }),
    "audio.mp3",
  );
  const response = await elevenLabs.proxy(
    "elevenlabs",
    "/v1/speech-to-text",
    { method: "POST", body: form },
  );
  if (!response.ok) {
    throw Object.assign(
      new Error(`ElevenLabs Scribe request failed with HTTP ${response.status}.`),
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(
      new Error("ElevenLabs Scribe returned invalid transcription JSON."),
      { retryable: false },
    );
  }
  const parsed = scribeResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw Object.assign(
      new Error("ElevenLabs Scribe did not return word-level timestamps."),
      { retryable: false },
    );
  }
  return parsed.data;
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

async function scoreTranscript(
  words: TimedWord[],
  duration: number,
): Promise<ScoredCandidate[]> {
  const client = getOpenAiClient();
  const segments = makeTranscriptSegments(words);
  const results: ScoredCandidate[][] = new Array(segments.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(2, segments.length) }, async () => {
    while (next < segments.length) {
      const index = next;
      next += 1;
      const segment = segments[index];
      if (!segment) continue;
      results[index] = await withRetries(() => scoreTranscriptSegment(client, segment, duration));
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.flat();
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
            "You are a careful short-form video editor. Find up to 3 compelling, self-contained spoken moments with a hook, coherent story, and payoff. Each must be 20–90 seconds, use timestamps within this provided transcript window and video duration, and provide an exact verbatim excerpt copied from the timestamped words (punctuation may vary but words may not). Do not invent speech. Score virality, hook, story, and payoff from 0–100. Give a brief evidence-based reason for each dimension. Return only JSON matching {candidates:[{startSeconds,endSeconds,excerpt,title,viralityScore,hookScore,storyScore,payoffScore,reason,hookReason,storyReason,payoffReason}]}. Titles and reasons must be concise.",
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
    .map((candidate) => validateCandidate(candidate, words, start, end, duration))
    .filter((candidate): candidate is ScoredCandidate => candidate !== null);
}

function validateCandidate(
  candidate: ScoredCandidate,
  words: TimedWord[],
  windowStart: number,
  windowEnd: number,
  duration: number,
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
  if (clipLength < 20 || clipLength > 90) return null;
  return {
    ...candidate,
    startSeconds: Math.max(0, startSeconds),
    endSeconds: Math.min(duration, endSeconds),
    title: candidate.title.trim().slice(0, 100),
    reason: candidate.reason.trim().slice(0, 1_000),
    hookReason: candidate.hookReason.trim().slice(0, 400),
    storyReason: candidate.storyReason.trim().slice(0, 400),
    payoffReason: candidate.payoffReason.trim().slice(0, 400),
  };
}

function normalizeWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? [];
}

function chooseNonOverlapping(
  candidates: ScoredCandidate[],
  limit: number,
): ScoredCandidate[] {
  const ordered = [...candidates].sort(
    (left, right) =>
      right.viralityScore - left.viralityScore ||
      right.hookScore - left.hookScore ||
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

async function withRetries<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const retryable = (error as { retryable?: boolean } | null)?.retryable;
      if (attempt < 3 && retryable !== false) {
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