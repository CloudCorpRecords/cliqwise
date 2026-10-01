import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool } from "@workspace/db";
import { ObjectStorageService, objectStorageClient } from "./objectStorage";
import {
  downloadPublicVideo,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
} from "./video-ingest-network";
import { downloadYoutubeVideo, isYoutubeSourceHost } from "./youtube-ingest";
import { snapshotVideoUploadStream } from "./video-upload-snapshot";

export {
  assertVideoFileWithinLimit,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
} from "./video-ingest-network";
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
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
    let source: URL;
    try {
      source = new URL(candidate);
    } catch {
      throw new Error("Enter a valid direct video URL or supported YouTube URL.");
    }
    if (isYoutubeSourceHost(source.hostname)) {
      await downloadYoutubeVideo(candidate, localPath);
    } else {
      await downloadPublicVideo(candidate, localPath);
    }
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
  const sourceSnapshotPath = await snapshotVideoUploadStream({
    source: file.createReadStream(),
    localPath,
    maxBytes: MAX_VIDEO_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    persistSnapshot: (sourcePath) => persistPrivateVideo(sourcePath, "sources"),
  });
  return { localPath, objectPath: sourceSnapshotPath };
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
