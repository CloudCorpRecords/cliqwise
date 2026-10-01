import { getAuth } from "@clerk/express";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  GetAccountResponse,
  GetJobParams,
  GetJobResponse,
  GenerateApiKeyBody,
  GenerateApiKeyResponse,
  ListActivityResponse,
  ListApiKeysResponse,
  ListJobsResponse,
  RevokeApiKeyParams,
  RevokeApiKeyResponse,
  SubmitVideoBody,
  SubmitVideoResponse,
  GetSystemStatusResponse,
} from "@workspace/api-zod";
import {
  authenticateApiKey,
  ClipwiseError,
  createApiKey,
  listActivity,
  listApiKeys,
  revokeApiKey,
} from "../lib/clipwise-store";
import {
  ensureAccount,
  getAccountSummary,
  getJobForUser,
  listJobsForUser,
  submitJob,
} from "../lib/clipwise-service";
import { isVideoPipelineReady } from "../lib/video-pipeline";

type ClipwiseRequest = Request & { clipwiseUserId?: string };

const router: IRouter = Router();
const rateBuckets = new Map<string, { startedAt: number; count: number }>();
const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 120;
const SUBMITS_PER_WINDOW = 5;

function readBearer(req: Request): string | null {
  const authorization = req.get("authorization");
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() ?? null;
}

async function resolveUserId(req: Request): Promise<string | null> {
  const bearer = readBearer(req);
  if (bearer !== null) {
    return authenticateApiKey(bearer);
  }
  try {
    return getAuth(req).userId ?? null;
  } catch {
    return null;
  }
}

function allowRequest(userId: string, submit: boolean): boolean {
  const now = Date.now();
  const key = `${userId}:${submit ? "submit" : "general"}`;
  const max = submit ? SUBMITS_PER_WINDOW : REQUESTS_PER_WINDOW;
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    if (rateBuckets.size > 10_000) {
      for (const [bucketKey, value] of rateBuckets) {
        if (now - value.startedAt >= WINDOW_MS) {
          rateBuckets.delete(bucketKey);
        }
      }
    }
    return true;
  }
  if (bucket.count >= max) {
    return false;
  }
  bucket.count += 1;
  return true;
}

router.use(async (request: Request, response: Response, next: NextFunction) => {
  if (request.path === "/system") {
    next();
    return;
  }
  try {
    const userId = await resolveUserId(request);
    if (!userId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    const submit = request.method === "POST" && request.path === "/jobs";
    if (!allowRequest(userId, submit)) {
      response.status(429).json({ error: "Request rate limit exceeded" });
      return;
    }
    (request as ClipwiseRequest).clipwiseUserId = userId;
    next();
  } catch (error) {
    next(error);
  }
});

function userId(req: Request): string {
  const value = (req as ClipwiseRequest).clipwiseUserId;
  if (!value) {
    throw new ClipwiseError("Authentication required", 401);
  }
  return value;
}

function respondError(error: unknown, res: Response): void {
  if (error instanceof ClipwiseError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "Request failed";
  res.status(500).json({ error: message });
}

router.get("/account", async (req, res): Promise<void> => {
  try {
    res.json(GetAccountResponse.parse(await getAccountSummary(userId(req))));
  } catch (error) {
    respondError(error, res);
  }
});

router.get("/jobs", async (req, res): Promise<void> => {
  try {
    res.json(ListJobsResponse.parse(await listJobsForUser(userId(req))));
  } catch (error) {
    respondError(error, res);
  }
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = SubmitVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const job = await submitJob(userId(req), {
      title: parsed.data.title,
      videoUrl: parsed.data.videoUrl,
      objectPath: parsed.data.objectPath,
      numberOfClips: parsed.data.numberOfClips,
      captionStyle: parsed.data.captionStyle,
      creditSource: parsed.data.creditSource,
    });
    res.status(201).json(SubmitVideoResponse.parse(job));
  } catch (error) {
    respondError(error, res);
  }
});

router.get("/jobs/:id", async (req, res): Promise<void> => {
  const parsed = GetJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const job = await getJobForUser(userId(req), parsed.data.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(GetJobResponse.parse(job));
  } catch (error) {
    respondError(error, res);
  }
});

router.get("/keys", async (req, res): Promise<void> => {
  try {
    res.json(ListApiKeysResponse.parse(await listApiKeys(userId(req))));
  } catch (error) {
    respondError(error, res);
  }
});

router.post("/keys", async (req, res): Promise<void> => {
  const parsed = GenerateApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const accountId = userId(req);
    await ensureAccount(accountId);
    res.status(
      201,
    ).json(GenerateApiKeyResponse.parse(await createApiKey(accountId, parsed.data.name)));
  } catch (error) {
    respondError(error, res);
  }
});

router.delete("/keys/:id", async (req, res): Promise<void> => {
  const parsed = RevokeApiKeyParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const revoked = await revokeApiKey(userId(req), parsed.data.id);
    if (!revoked) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    res.json(RevokeApiKeyResponse.parse({ success: true }));
  } catch (error) {
    respondError(error, res);
  }
});

router.get("/activity", async (req, res): Promise<void> => {
  try {
    res.json(ListActivityResponse.parse(await listActivity(userId(req))));
  } catch (error) {
    respondError(error, res);
  }
});

router.get("/system", (_req, res): void => {
  res.json(
    GetSystemStatusResponse.parse({
      mcpPath: "/api/mcp",
      maxDurationSeconds: 10_800,
      maxFileBytes: 4_294_967_296,
      captionStyles: ["bold", "minimal", "karaoke"],
      pipelineReady: isVideoPipelineReady(),
    }),
  );
});

export default router;