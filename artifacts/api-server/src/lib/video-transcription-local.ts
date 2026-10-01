import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  statSync,
} from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TimedWord } from "./video-captions";

const MODEL_RELATIVE_PATH = join(".cache", "clipwise-transcription", "base");
const TRANSCRIBER_RELATIVE_PATH = join(
  "artifacts",
  "api-server",
  "scripts",
  "transcribe-local.py",
);
const SETUP_COMMAND =
  "python3 artifacts/api-server/scripts/setup-transcription.py";
const REQUIRED_MODEL_FILES = ["config.json", "model.bin", "tokenizer.json"];
const MIN_MODEL_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_WORDS = 100_000;
const MAX_WORD_TEXT_LENGTH = 4_000;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const GCC_RUNTIME_LOOKUP_TIMEOUT_MS = 5_000;
const GCC_RUNTIME_LIBRARY_NAME = "libstdc++.so.6";

export interface LocalTranscriptionOptions {
  timeoutMs?: number;
}

function findWorkspaceRoot(): string | undefined {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let directory = resolve(start);
    while (true) {
      if (existsSync(join(directory, TRANSCRIBER_RELATIVE_PATH))) return directory;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

function getModelDirectory(): string | undefined {
  const root = findWorkspaceRoot();
  return root ? join(root, MODEL_RELATIVE_PATH) : undefined;
}

function isNonEmptyFile(path: string): boolean {
  try {
    const file = statSync(path);
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

export function resolveLocalTranscriptionLibraryPath(): string {
  const lookup = spawnSync(
    "g++",
    [`-print-file-name=${GCC_RUNTIME_LIBRARY_NAME}`],
    {
      encoding: "utf8",
      timeout: GCC_RUNTIME_LOOKUP_TIMEOUT_MS,
      maxBuffer: 4 * 1024,
      windowsHide: true,
      // The compiler lookup needs only executable search paths, not API secrets.
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  if ((lookup.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error("Resolving the native C++ runtime timed out; check the GCC toolchain.");
  }
  if (lookup.error || lookup.status !== 0) {
    throw new Error("Could not resolve the native C++ runtime using g++.");
  }

  const libraryPath = lookup.stdout.trim();
  if (
    !isAbsolute(libraryPath)
    || basename(libraryPath) !== GCC_RUNTIME_LIBRARY_NAME
    || !isNonEmptyFile(libraryPath)
  ) {
    throw new Error(
      "g++ could not locate libstdc++.so.6; configure the native GCC runtime dependency.",
    );
  }
  return libraryPath;
}

export function prependLocalTranscriptionLibraryPath(
  libraryPath: string,
  existingLibraryPath = process.env.LD_LIBRARY_PATH,
): string {
  const libraryDirectory = dirname(libraryPath);
  return existingLibraryPath
    ? `${libraryDirectory}${delimiter}${existingLibraryPath}`
    : libraryDirectory;
}

function createTranscriberEnvironment(): NodeJS.ProcessEnv {
  const runtimeLibraryPath = resolveLocalTranscriptionLibraryPath();
  return {
    ...process.env,
    LD_LIBRARY_PATH: prependLocalTranscriptionLibraryPath(runtimeLibraryPath),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    CUDA_VISIBLE_DEVICES: "",
  };
}

export function isLocalTranscriptionReady(): boolean {
  const modelDirectory = getModelDirectory();
  if (!modelDirectory) return false;
  const requiredFilesReady = REQUIRED_MODEL_FILES.every((filename) =>
    isNonEmptyFile(join(modelDirectory, filename)),
  );
  return requiredFilesReady
    && statSync(join(modelDirectory, "model.bin")).size >= MIN_MODEL_BYTES
    && ["vocabulary.json", "vocabulary.txt"].some((filename) =>
      isNonEmptyFile(join(modelDirectory, filename)),
    );
}

function validateTimedWords(value: unknown): TimedWord[] {
  if (!value || typeof value !== "object" || !("words" in value)) {
    throw new Error("Local transcription returned an invalid result.");
  }
  const words = (value as { words?: unknown }).words;
  if (!Array.isArray(words) || words.length > MAX_WORDS) {
    throw new Error("Local transcription returned an invalid or oversized word list.");
  }

  return words.map((word, index) => {
    if (!word || typeof word !== "object") {
      throw new Error(`Local transcription returned an invalid word at index ${index}.`);
    }
    const candidate = word as { text?: unknown; start?: unknown; end?: unknown };
    if (
      typeof candidate.text !== "string"
      || candidate.text.trim().length === 0
      || candidate.text.length > MAX_WORD_TEXT_LENGTH
      || !Number.isFinite(candidate.start)
      || !Number.isFinite(candidate.end)
    ) {
      throw new Error(`Local transcription returned invalid word data at index ${index}.`);
    }
    const text = candidate.text.trim();
    const start = candidate.start as number;
    const end = candidate.end as number;
    if (start < 0 || end <= start) {
      throw new Error(`Local transcription returned invalid word timing at index ${index}.`);
    }
    return { text, start, end };
  });
}

function errorText(stderr: Buffer): string {
  return stderr.toString("utf8").trim().slice(0, 2_000);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      // The process may already have exited; the close event remains authoritative.
    }
  }
}

function runTranscriber(
  python: string,
  scriptPath: string,
  audioPath: string,
  outputPath: string,
  workspacePath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, [scriptPath, audioPath, outputPath], {
      cwd: workspacePath,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      env: createTranscriberEnvironment(),
    });
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let exceededStderrLimit = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid!, "SIGTERM");
      killTimer = setTimeout(
        () => killProcessGroup(child.pid!, "SIGKILL"),
        2_000,
      );
      killTimer.unref();
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += data.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        exceededStderrLimit = true;
        killProcessGroup(child.pid!, "SIGKILL");
        return;
      }
      stderrChunks.push(data);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      rejectPromise(
        new Error(
          `Could not start the local transcription Python runtime (${error.message}).`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        rejectPromise(
          new Error(`Local transcription exceeded its ${Math.round(timeoutMs / 60_000)} minute timeout.`),
        );
        return;
      }
      if (exceededStderrLimit) {
        rejectPromise(new Error("Local transcription exceeded its diagnostic output limit."));
        return;
      }
      if (code !== 0) {
        const details = errorText(Buffer.concat(stderrChunks));
        rejectPromise(
          new Error(
            details || `Local transcription failed${signal ? ` (${signal})` : ""}.`,
          ),
        );
        return;
      }
      resolvePromise();
    });
  });
}

export async function transcribeLocalAudio(
  audioPath: string,
  options: LocalTranscriptionOptions = {},
): Promise<TimedWord[]> {
  if (!audioPath || typeof audioPath !== "string") {
    throw new Error("A prepared local MP3 audio path is required.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs)
    || timeoutMs < 1_000
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(`Local transcription timeout must be between 1,000 and ${MAX_TIMEOUT_MS} ms.`);
  }

  const resolvedAudioPath = resolve(audioPath);
  if (!resolvedAudioPath.toLowerCase().endsWith(".mp3")) {
    throw new Error("Local transcription accepts prepared MP3 audio only.");
  }
  let audioStats;
  try {
    audioStats = await stat(resolvedAudioPath);
  } catch {
    throw new Error("The prepared local MP3 audio file could not be found.");
  }
  if (!audioStats.isFile() || audioStats.size <= 0) {
    throw new Error("The prepared local MP3 audio file is empty or invalid.");
  }
  if (audioStats.size > MAX_AUDIO_BYTES) {
    throw new Error("The prepared MP3 exceeds the 24 MB local transcription limit.");
  }

  const workspacePath = findWorkspaceRoot();
  if (!workspacePath) {
    throw new Error("Could not locate the workspace local transcription helper.");
  }
  const modelDirectory = join(workspacePath, MODEL_RELATIVE_PATH);
  if (!isLocalTranscriptionReady()) {
    throw new Error(
      `The local transcription model is not installed. Run ${SETUP_COMMAND} before processing jobs.`,
    );
  }

  const workspacePython = join(workspacePath, ".pythonlibs", "bin", "python");
  const python =
    process.env.PYTHON?.trim()
    || (existsSync(workspacePython) ? workspacePython : "python3");
  const scriptPath = join(workspacePath, TRANSCRIBER_RELATIVE_PATH);
  if (!isAbsolute(scriptPath) || !existsSync(scriptPath)) {
    throw new Error("The local transcription helper script is missing from the workspace.");
  }
  const outputPath = join(
    dirname(resolvedAudioPath),
    `.local-transcription-${process.pid}-${randomUUID()}.json`,
  );

  try {
    await runTranscriber(
      python,
      scriptPath,
      resolvedAudioPath,
      outputPath,
      workspacePath,
      timeoutMs,
    );
    const outputStats = await stat(outputPath).catch(() => undefined);
    if (!outputStats?.isFile() || outputStats.size <= 0) {
      throw new Error("Local transcription did not produce a result file.");
    }
    if (outputStats.size > MAX_OUTPUT_BYTES) {
      throw new Error("The local transcription result exceeds the 10 MB safety limit.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(outputPath, "utf8"));
    } catch {
      throw new Error("Local transcription produced invalid JSON.");
    }
    return validateTimedWords(parsed);
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}