import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pool } from "@workspace/db";
import { ObjectStorageService, objectStorageClient } from "./objectStorage";

export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 10_800;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const DNS_TIMEOUT_MS = 10_000;
const objectStorage = new ObjectStorageService();

export async function createVideoWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clipwise-"));
}

export async function removeVideoWorkDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function ingestVideoSource({
  userId,
  sourceUrl,
  objectPath,
  workDir,
}: {
  userId: string;
  sourceUrl: string | null;
  objectPath: string | null;
  workDir: string;
}): Promise<{ localPath: string; objectPath: string }> {
  const candidate = sourceUrl?.trim() || objectPath?.trim();
  if (!candidate) throw new Error("A source video URL or upload is required.");

  const localPath = join(workDir, "source-video");
  if (/^https?:\/\//i.test(candidate)) {
    await downloadPublicVideo(candidate, localPath);
    return {
      localPath,
      objectPath: await persistPrivateVideo(localPath, "sources"),
    };
  }

  const uploadPath = candidate.startsWith("/objects/")
    ? candidate
    : objectPath?.trim();
  if (!uploadPath?.startsWith("/objects/")) {
    throw new Error("The source must be a direct HTTP(S) video URL or an owned upload.");
  }

  const ownedUpload = await pool.query<{ object_path: string }>(
    `SELECT object_path
       FROM cw_uploads
      WHERE user_id = $1 AND object_path = $2
      LIMIT 1`,
    [userId, uploadPath],
  );
  const ownedPath = ownedUpload.rows[0]?.object_path;
  if (!ownedPath || !ownedPath.startsWith("/objects/")) {
    throw new Error("The selected upload was not found or is not owned by this user.");
  }

  const file = await objectStorage.getObjectEntityFile(ownedPath);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  if (size <= 0) throw new Error("The selected upload is empty.");
  if (size > MAX_VIDEO_BYTES) throw new Error("Videos must be no larger than 4 GiB.");
  await pipeline(
    file.createReadStream(),
    byteLimit(MAX_VIDEO_BYTES),
    createWriteStream(localPath, { flags: "wx" }),
    { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
  );
  return { localPath, objectPath: ownedPath };
}

export async function persistPrivateVideo(
  localPath: string,
  category: "sources" | "clips",
  fixedName?: string,
): Promise<string> {
  const privateDir = objectStorage.getPrivateObjectDir().replace(/\/+$/, "");
  const [bucketName, ...prefixParts] = privateDir.replace(/^\/+/, "").split("/");
  if (!bucketName) throw new Error("Private object storage is not configured.");
  const name =
    fixedName ??
    `${randomUUID()}${category === "clips" ? ".mp4" : ".source"}`;
  const objectName = [...prefixParts, "clipwise", category, name].filter(Boolean).join("/");
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  await objectStorageClient.bucket(bucketName).upload(localPath, {
    destination: file,
    resumable: true,
    timeout: DOWNLOAD_TIMEOUT_MS,
    metadata: {
      contentType: category === "clips" ? "video/mp4" : "application/octet-stream",
      cacheControl: "private, no-store",
    },
  });
  return `/objects/clipwise/${category}/${name}`;
}

export async function assertVideoFileWithinLimit(path: string): Promise<void> {
  const fileStat = await stat(path);
  if (!fileStat.size) throw new Error("The source video is empty.");
  if (fileStat.size > MAX_VIDEO_BYTES) {
    throw new Error("Videos must be no larger than 4 GiB.");
  }
}

function byteLimit(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(new Error("The video exceeds the 4 GiB upload limit."));
      } else {
        callback(null, chunk);
      }
    },
  });
}

function ipv4IsGlobal(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6ToMappedIpv4(address: string): string | null {
  const lower = address.toLowerCase().split("%")[0] ?? "";
  const match = lower.match(/^(?:::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (match?.[1]) return match[1];
  if (!lower.startsWith("::ffff:")) return null;
  const suffix = lower.slice("::ffff:".length);
  if (suffix.includes(".")) return null;
  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const high = Number.parseInt(groups[0] ?? "0", 16);
  const low = Number.parseInt(groups[1] ?? "0", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isGlobalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return ipv4IsGlobal(address);
  if (version !== 6) return false;
  const mapped = ipv6ToMappedIpv4(address);
  if (mapped) return ipv4IsGlobal(mapped);

  const normalized = address.toLowerCase().split("%")[0] ?? "";
  // Only global-unicast 2000::/3 addresses are allowed. Exclude documentation,
  // protocol assignments, and transition prefixes that can tunnel private IPv4.
  if (!/^[23][0-9a-f]{3}:/.test(normalized)) return false;
  if (
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("2002:")
  ) return false;
  const secondGroup = Number.parseInt(normalized.split(":")[1] ?? "ffff", 16);
  if (normalized.startsWith("2001:") && secondGroup <= 0x01ff) return false;
  return true;
}

async function resolveSafeAddress(hostname: string): Promise<{ address: string; family: number }> {
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (isIP(normalizedHost)) {
    if (!isGlobalAddress(normalizedHost)) throw new Error("Private and non-global source hosts are not allowed.");
    return { address: normalizedHost, family: isIP(normalizedHost) };
  }
  let addresses: Array<{ address: string; family: number }>;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(normalizedHost, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Error("The source video host could not be resolved.")),
          DNS_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    throw new Error("The source video host could not be resolved.");
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  if (!addresses.length || addresses.some((entry) => !isGlobalAddress(entry.address))) {
    throw new Error("Private and non-global source hosts are not allowed.");
  }
  const first = addresses[0];
  if (!first) throw new Error("The source video host could not be resolved.");
  return { address: first.address, family: first.family };
}

async function downloadPublicVideo(rawUrl: string, destination: string): Promise<void> {
  let current = new URL(rawUrl);
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  for (let redirect = 0; ; redirect += 1) {
    if (
      !["http:", "https:"].includes(current.protocol) ||
      current.username ||
      current.password ||
      !current.hostname
    ) {
      throw new Error("Only credential-free public HTTP(S) video URLs are supported.");
    }
    const resolved = await resolveSafeAddress(current.hostname);
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) throw new Error("The source video download timed out.");
    const response = await requestPinned(current, resolved, remainingTime);
    const statusCode = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const location = response.headers.location;
      response.resume();
      if (!location || redirect >= MAX_REDIRECTS) {
        throw new Error("The source URL redirected too many times.");
      }
      current = new URL(location, current);
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) {
      response.resume();
      throw new Error("The source video could not be downloaded.");
    }
    const contentLength = Number(response.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) {
      response.destroy();
      throw new Error("Videos must be no larger than 4 GiB.");
    }
    try {
      await pipeline(
        response,
        byteLimit(MAX_VIDEO_BYTES),
        createWriteStream(destination, { flags: "wx" }),
        { signal: AbortSignal.timeout(remainingTime) },
      );
    } catch (error) {
      if ((error as Error).message.includes("4 GiB")) throw error;
      throw new Error("The source video download did not complete.");
    }
    await assertVideoFileWithinLimit(destination);
    return;
  }
}

function requestPinned(
  url: URL,
  resolved: { address: string; family: number },
  timeoutMs: number,
): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      url,
      {
        method: "GET",
        headers: { "user-agent": "ClipwiseVideoPipeline/1.0", accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.1" },
        lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
          callback(null, resolved.address, resolved.family);
        }) as never,
      },
      (response) => resolve(response),
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Source download timed out.")),
      timeoutMs,
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Source download timed out.")));
    req.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.once("response", (response) => {
      response.once("close", () => clearTimeout(timer));
    });
    req.end();
  });
}