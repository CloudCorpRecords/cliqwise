import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import type { Duplex } from "node:stream";
import {
  DOWNLOAD_TIMEOUT_MS,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  resolveSafeAddress,
} from "./video-ingest-network";
import {
  classifyYtDlpFailure,
  friendlyYtDlpFailure,
} from "./youtube-diagnostics";
import {
  parseYoutubeConnectTarget,
  parseSupportedYoutubeUrl,
} from "./youtube-url";
import {
  YOUTUBE_DOWNLOADER,
  YOUTUBE_FORMAT_SELECTOR,
  YOUTUBE_JS_RUNTIME,
  YOUTUBE_MERGE_OUTPUT_FORMAT,
} from "./youtube-download-policy";

export {
  isAllowedYoutubeEgressHost,
  isYoutubeSourceHost,
  parseYoutubeConnectTarget,
  parseSupportedYoutubeUrl,
} from "./youtube-url";

const MAX_YTDLP_STDERR_BYTES = 64 * 1024;
const MAX_YTDLP_ATTEMPTS = 3;
const YTDLP_SOCKET_TIMEOUT_SECONDS = 30;
const RETRY_BACKOFF_MS = [500, 1_500];

type ProxyOptions = {
  resolve?: typeof resolveSafeAddress;
  maxBytes?: number;
};

type EgressProxy = {
  url: string;
  close: () => Promise<void>;
};

async function startYoutubeEgressProxy(options: ProxyOptions = {}): Promise<EgressProxy> {
  const resolve = options.resolve ?? resolveSafeAddress;
  const maxBytes = options.maxBytes ?? MAX_VIDEO_BYTES;
  let downloadedBytes = 0;
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(405, { connection: "close" }).end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, clientSocket, head) => {
    void (async () => {
      let target: { hostname: string; port: number };
      try {
        target = parseYoutubeConnectTarget(request.url ?? "");
      } catch {
        rejectProxyConnection(clientSocket, 403, "Forbidden");
        return;
      }

      let resolved;
      try {
        resolved = await resolve(target.hostname);
      } catch {
        rejectProxyConnection(clientSocket, 502, "Host resolution failed");
        return;
      }
      const upstream = connect({
        host: resolved.address,
        family: resolved.family,
        port: target.port,
      });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      let tunnelReady = false;
      upstream.setTimeout(
        YTDLP_SOCKET_TIMEOUT_SECONDS * 1000,
        () => upstream.destroy(new Error("Upstream timed out.")),
      );
      if ("setTimeout" in clientSocket && typeof clientSocket.setTimeout === "function") {
        clientSocket.setTimeout(
          YTDLP_SOCKET_TIMEOUT_SECONDS * 1000,
          () => clientSocket.destroy(new Error("Proxy client timed out.")),
        );
      }
      upstream.once("connect", () => {
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        tunnelReady = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxBytes) {
          const error = new Error("YouTube download exceeded the 4 GiB size limit.");
          clientSocket.destroy(error);
          upstream.destroy(error);
        }
      });
      upstream.once("error", () => {
        if (!tunnelReady) rejectProxyConnection(clientSocket, 502, "Upstream unavailable");
        else clientSocket.destroy();
      });
      clientSocket.once("error", () => upstream.destroy());
      clientSocket.once("close", () => upstream.destroy());
    })().catch(() => rejectProxyConnection(clientSocket, 400, "Invalid proxy request"));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The secure YouTube download proxy could not start.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function rejectProxyConnection(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

/**
 * Download only a parsed public single-video YouTube URL. All yt-dlp HTTPS
 * requests are forced through a loopback CONNECT proxy that allowlists domains,
 * resolves every destination, rejects non-global IPs, and connects to the
 * validated IP rather than performing a second DNS lookup.
 */
export async function downloadYoutubeVideo(
  rawUrl: string,
  destination: string,
  ytDlpPath = process.env.YT_DLP_PATH,
): Promise<void> {
  const canonicalUrl = parseSupportedYoutubeUrl(rawUrl);
  const diagnosticDir = await mkdtemp(join(tmpdir(), "clipwise-ytdlp-"));
  const stderrPath = join(diagnosticDir, "stderr.txt");
  const outputPrefix = `${basename(destination)}.youtube.`;
  const outputTemplate = join(dirname(destination), `${outputPrefix}%(ext)s`);
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;

  try {
    for (let attempt = 1; attempt <= MAX_YTDLP_ATTEMPTS; attempt += 1) {
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) throw new Error("The YouTube source download timed out.");
      const proxy = await startYoutubeEgressProxy();
      try {
        await runYtDlp({
          ytDlpPath,
          canonicalUrl,
          outputTemplate,
          proxyUrl: proxy.url,
          stderrPath,
          timeoutMs: remainingTime,
        });

        const generated = await findGeneratedVideos(dirname(destination), outputPrefix);
        if (generated.length !== 1) {
          throw new Error("The YouTube downloader did not produce exactly one video file.");
        }
        const generatedStat = await stat(generated[0]!);
        if (generatedStat.size <= 0 || generatedStat.size > MAX_VIDEO_BYTES) {
          throw new Error(
            generatedStat.size <= 0
              ? "The YouTube source video is empty."
              : "Videos must be no larger than 4 GiB.",
          );
        }
        await rename(generated[0]!, destination);
        return;
      } catch (error) {
        if (error instanceof Error && /yt-dlp is not installed|could not be started/.test(error.message)) {
          throw error;
        }
        const stderr = await readFile(stderrPath, "utf8").catch(() => "");
        const failure = classifyYtDlpFailure(stderr, error);
        await removeGeneratedVideos(dirname(destination), outputPrefix);
        if (failure.kind === "bot-blocked") {
          throw new Error(
            "YouTube is temporarily blocking automated access to this video with bot verification. Try again later; sign-in or verification bypass is not supported.",
          );
        }
        if (failure.transient && attempt < MAX_YTDLP_ATTEMPTS) {
          const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1)!;
          await delay(Math.min(backoff, Math.max(0, deadline - Date.now())));
          continue;
        }
        throw new Error(friendlyYtDlpFailure(failure));
      } finally {
        await proxy.close();
      }
    }
  } finally {
    await removeGeneratedVideos(dirname(destination), outputPrefix);
    await rm(diagnosticDir, { recursive: true, force: true });
  }
}

async function runYtDlp({
  ytDlpPath,
  canonicalUrl,
  outputTemplate,
  proxyUrl,
  stderrPath,
  timeoutMs,
}: {
  ytDlpPath?: string;
  canonicalUrl: string;
  outputTemplate: string;
  proxyUrl: string;
  stderrPath: string;
  timeoutMs: number;
}): Promise<void> {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-cookies",
    "--no-cache-dir",
    "--no-call-home",
    "--no-remote-components",
    "--js-runtimes",
    YOUTUBE_JS_RUNTIME,
    "--no-part",
    "--no-overwrites",
    "--no-write-thumbnail",
    "--no-write-subs",
    "--no-write-auto-subs",
    "--no-write-info-json",
    "--no-write-description",
    "--socket-timeout",
    String(YTDLP_SOCKET_TIMEOUT_SECONDS),
    "--retries",
    "1",
    "--extractor-retries",
    "1",
    "--fragment-retries",
    "1",
    "--file-access-retries",
    "1",
    "--max-filesize",
    String(MAX_VIDEO_BYTES),
    "--match-filter",
    `availability = 'public' & duration > 0 & duration <= ${MAX_VIDEO_SECONDS} & !is_live`,
    "--format",
    YOUTUBE_FORMAT_SELECTOR,
    "--downloader",
    YOUTUBE_DOWNLOADER,
    "--merge-output-format",
    YOUTUBE_MERGE_OUTPUT_FORMAT,
    "--output",
    outputTemplate,
    "--proxy",
    proxyUrl,
    canonicalUrl,
  ];

  await new Promise<void>((resolve, reject) => {
    const stderrFile = createWriteStream(stderrPath, { flags: "w", mode: 0o600 });
    let capturedBytes = 0;
    let stderrWriteFailed = false;
    stderrFile.on("error", () => {
      stderrWriteFailed = true;
    });
    const command = ytDlpPath || process.env.PYTHON || "python";
    const commandArgs = ytDlpPath ? args : ["-m", "yt_dlp", ...args];
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      env: buildProxyEnvironment(proxyUrl),
      detached: process.platform !== "win32",
    });
    let spawnError: NodeJS.ErrnoException | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = MAX_YTDLP_STDERR_BYTES - capturedBytes;
      if (!stderrWriteFailed && remaining > 0) {
        const boundedChunk = chunk.subarray(0, remaining);
        capturedBytes += boundedChunk.length;
        stderrFile.write(boundedChunk);
      }
    });
    child.once("error", (error) => {
      spawnError = error as NodeJS.ErrnoException;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut || code !== 0) killProcessTree(child);
      stderrFile.end(() => {
        if (timedOut) {
          reject(new Error("The YouTube source download timed out."));
        } else if (spawnError?.code === "ENOENT") {
          reject(new Error("The Python yt-dlp module could not be started; verify Python and yt-dlp are installed."));
        } else if (spawnError) {
          reject(new Error("The YouTube downloader could not be started."));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with status ${code ?? signal ?? "unknown"}.`));
        }
      });
    });
  });
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The direct process may have already exited; still try to stop it.
    }
  }
  child.kill("SIGKILL");
}

async function findGeneratedVideos(directory: string, prefix: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(directory, entry));
}

async function removeGeneratedVideos(directory: string, prefix: string): Promise<void> {
  const generated = await findGeneratedVideos(directory, prefix).catch(() => []);
  await Promise.all(generated.map((path) => rm(path, { recursive: true, force: true })));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildProxyEnvironment(proxyUrl: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
  };
  delete environment.NO_PROXY;
  delete environment.no_proxy;
  return environment;
}