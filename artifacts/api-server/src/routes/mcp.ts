import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { getAccountSummary, getJobForUser, submitJob } from "../lib/clipwise-service";
import { getClerkProxyHost } from "../middlewares/clerkProxyMiddleware";
import {
  authenticateApiKey,
  ClipwiseError,
} from "../lib/clipwise-store";

const router: IRouter = Router();
const rateBuckets = new Map<string, { startedAt: number; count: number }>();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function bearerToken(authorization: string | undefined): string | null {
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
  return match?.[1]?.trim() ?? null;
}

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(userId);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(userId, { startedAt: now, count: 1 });
    if (rateBuckets.size > 10_000) {
      for (const [key, value] of rateBuckets) {
        if (now - value.startedAt >= RATE_WINDOW_MS) {
          rateBuckets.delete(key);
        }
      }
    }
    return true;
  }
  if (bucket.count >= RATE_LIMIT) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function toolResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function createMcpServer(userId: string, publicOrigin: string): McpServer {
  const server = new McpServer({
    name: "clipwise",
    version: "1.0.0",
  });

  server.registerTool(
    "submit_video",
    {
      title: "Submit video",
      description:
        "Submit one HTTP(S) video URL or an existing private upload object_path for clipping. For large files, request an authenticated upload ticket at POST /api/storage/uploads/request-url, PUT the file to uploadURL, then pass the returned objectPath. Do not send file bytes or base64 through MCP.",
      inputSchema: {
        video_url: z.string().url().optional(),
        object_path: z.string().min(1).optional(),
        title: z.string().max(200).optional(),
        number_of_clips: z.number().int().min(1).max(10).default(3),
        caption_style: z.enum(["bold", "minimal", "karaoke"]).default("bold"),
        credit_source: z.enum(["auto", "free", "paid"]).default("auto"),
      },
    },
    async (input) => {
      if (Boolean(input.video_url) === Boolean(input.object_path)) {
        return {
          ...toolResult({
            error: "Provide exactly one of video_url or object_path",
          }),
          isError: true,
        };
      }
      try {
        const job = await submitJob(userId, {
          videoUrl: input.video_url,
          objectPath: input.object_path,
          title: input.title,
          numberOfClips: input.number_of_clips,
          captionStyle: input.caption_style,
          creditSource: input.credit_source,
        });
        return toolResult({
          job_id: job.id,
          status: job.status,
          credits_reserved: job.creditsReserved,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Video submission failed";
        return { ...toolResult({ error: message }), isError: true };
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get video job",
      description:
        "Get an owned video job's current status, progress and completed clip results, including real download/preview URLs, durations, virality scores and transcripts.",
      inputSchema: {
        job_id: z.string().min(1),
      },
    },
    async ({ job_id }) => {
      try {
        const job = await getJobForUser(userId, job_id);
        if (!job) {
          return {
            ...toolResult({ error: "Job not found" }),
            isError: true,
          };
        }
        return toolResult({
          job_id: job.id,
          status: job.status,
          progress: job.progress,
          stage: job.stage,
          duration_seconds: job.durationSeconds,
          credits_reserved: job.creditsReserved,
          watermarked: job.watermarked,
          error: job.error,
          clips: Array.isArray(job.clips) ? job.clips.map((clip) => ({
            ...clip,
            downloadUrl: new URL(clip.downloadUrl, publicOrigin).toString(),
            previewUrl: new URL(clip.previewUrl, publicOrigin).toString(),
          })) : [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not retrieve job";
        return { ...toolResult({ error: message }), isError: true };
      }
    },
  );

  return server;
}

router.all("/mcp", async (req, res): Promise<void> => {
  if (req.method === "GET" || req.method === "DELETE") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Streamable HTTP MCP supports POST only" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const token = bearerToken(req.get("authorization"));
    if (!token) {
      res.status(401).json({ error: "A Clipwise API key bearer token is required" });
      return;
    }
    const userId = await authenticateApiKey(token);
    if (!userId) {
      res.status(401).json({ error: "Invalid or revoked Clipwise API key" });
      return;
    }
    if (!checkRateLimit(userId)) {
      res.status(429).json({ error: "MCP request rate limit exceeded" });
      return;
    }

    // The MCP API requires a positive live balance for every request (including
    // get_job); REST job retrieval remains available when the balance is zero.
    const account = await getAccountSummary(userId);
    if (Number(account.totalCredits) <= 0) {
      res.status(402).json({ error: "A positive Clipwise credit balance is required for MCP" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const host = getClerkProxyHost(req);
    if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
      res.status(400).json({ error: "A valid public request host is required" });
      return;
    }
    const server = createMcpServer(userId, `https://${host}`);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    await server.close();
  } catch (error) {
    if (error instanceof ClipwiseError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "MCP request failed",
      });
    }
  }
});

export default router;