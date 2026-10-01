import { createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function snapshotVideoUploadStream({
  source,
  localPath,
  maxBytes,
  timeoutMs,
  persistSnapshot,
}: {
  source: Readable;
  localPath: string;
  maxBytes: number;
  timeoutMs: number;
  persistSnapshot: (localPath: string) => Promise<string>;
}): Promise<string> {
  let total = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error("The video exceeds the 4 GiB upload limit."));
      } else {
        callback(null, chunk);
      }
    },
  });
  await pipeline(
    source,
    byteLimit,
    createWriteStream(localPath, { flags: "wx" }),
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  return persistSnapshot(localPath);
}