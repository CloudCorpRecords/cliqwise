import { Router, type IRouter, type Request } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "@workspace/db";
import { RequestUploadUrlBody, RequestUploadUrlResponse } from "@workspace/api-zod";
import { rateLimit } from "express-rate-limit";
import { ObjectStorageService } from "../lib/objectStorage";
import { authenticateApiKey, ensureAccount } from "../lib/clipwise-store";
import { validClipSignature } from "../lib/clip-links";

const router: IRouter = Router();
const storage = new ObjectStorageService();

async function identity(req: Request): Promise<string | null> {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
  if (bearer) return authenticateApiKey(bearer[1]!.trim());
  return getAuth(req).userId;
}

router.post("/storage/uploads/request-url", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, validate: false }), async (req, res): Promise<void> => {
  const userId = await identity(req);
  if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A video name, MIME type, and size between 1 byte and 4 GB are required." }); return; }
  if (!parsed.data.contentType.startsWith("video/")) {
    res.status(400).json({ error: "Choose a video file." }); return;
  }
  await ensureAccount(userId);
  const account = await pool.query("SELECT free_credits + paid_credits AS balance FROM cw_accounts WHERE id=$1", [userId]);
  if (Number(account.rows[0]?.balance) <= 0) { res.status(402).json({ error: "You need processing credits before uploading." }); return; }
  const uploadURL = await storage.getObjectEntityUploadURL();
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  await pool.query("INSERT INTO cw_uploads(object_path,user_id,name,size) VALUES($1,$2,$3,$4)", [objectPath, userId, parsed.data.name, parsed.data.size]);
  res.json(RequestUploadUrlResponse.parse({ uploadURL, objectPath }));
});

router.get("/clips/:id/content", async (req, res): Promise<void> => {
  const id = String(req.params.id);
  if (!/^[a-f0-9-]{36}$/i.test(id)) { res.sendStatus(404); return; }
  const result = await pool.query<{ object_path: string; user_id: string }>(
    "SELECT c.object_path,j.user_id FROM cw_clips c JOIN cw_jobs j ON j.id=c.job_id WHERE c.id=$1 AND j.status='completed'", [id]);
  const clip = result.rows[0];
  if (!clip) { res.sendStatus(404); return; }
  if (!validClipSignature(id, req.query.expires, req.query.signature) && await identity(req) !== clip.user_id) {
    res.status(401).json({ error: "This private download link has expired. Refresh the job to get a new link." }); return;
  }
  const file = await storage.getObjectEntityFile(clip.object_path);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  res.set({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="clipwise-${id}.mp4"`);
  let start = 0;
  let end = size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || end < start) { res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", String(end - start + 1));
  if (req.method === "HEAD") { res.end(); return; }
  const stream = file.createReadStream({ start, end });
  stream.on("error", () => { if (!res.headersSent) res.sendStatus(502); else res.destroy(); });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
});

export default router;