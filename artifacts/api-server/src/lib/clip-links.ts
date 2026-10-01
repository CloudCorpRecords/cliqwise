import { createHmac, timingSafeEqual } from "node:crypto";

function signature(clipId: string, expires: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Clip download signing is not configured.");
  return createHmac("sha256", secret)
    .update(`clipwise-download:${clipId}:${expires}`)
    .digest("hex");
}

export function clipContentUrl(clipId: string, download = false): string {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return `/api/clips/${encodeURIComponent(clipId)}/content?expires=${expires}&signature=${signature(clipId, expires)}${download ? "&download=1" : ""}`;
}

export function validClipSignature(clipId: string, expires: unknown, value: unknown): boolean {
  if (typeof expires !== "string" || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
  const deadline = Number(expires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(deadline) || deadline < now || deadline > now + 3600) return false;
  return timingSafeEqual(Buffer.from(signature(clipId, deadline), "hex"), Buffer.from(value, "hex"));
}