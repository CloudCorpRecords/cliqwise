import { getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCheckoutBody,
  CreateCheckoutResponse,
  ListCreditPacksResponse,
} from "@workspace/api-zod";
import { getClerkProxyHost } from "../middlewares/clerkProxyMiddleware";
import {
  createClipwiseCheckout,
  handleStripeWebhookPayload,
  InvalidCreditPackError,
  listClipwiseCreditPacks,
  reconcileOwnedCheckoutSession,
} from "../lib/clipwise-billing";
import { logger } from "../lib/logger";
import { StripeProviderError } from "../lib/stripeClient";

const router: IRouter = Router();

router.get("/billing/packs", async (_req, res) => {
  try {
    const response = ListCreditPacksResponse.parse(
      await listClipwiseCreditPacks(),
    );
    res.json(response);
  } catch {
    logger.error("Unable to load the Clipwise credit pack catalog.");
    res.status(503).json({ error: "Credit packs are temporarily unavailable." });
  }
});

router.post("/billing/checkout", async (req, res) => {
  const parsedBody = CreateCheckoutBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "A valid priceId is required." });
    return;
  }

  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication is required." });
    return;
  }

  try {
    const publicHost = getClerkProxyHost(req);
    const response = CreateCheckoutResponse.parse({
      url: await createClipwiseCheckout(
        userId,
        parsedBody.data.priceId,
        publicHost ? `https://${publicHost}` : undefined,
      ),
    });
    res.json(response);
  } catch (error) {
    if (error instanceof InvalidCreditPackError) {
      res.status(400).json({ error: "That price is not an active credit pack." });
      return;
    }
    const status = error instanceof StripeProviderError ? error.status : undefined;
    logger.error({ status }, "Unable to create a Clipwise Stripe Checkout session.");
    res.status(503).json({ error: "Checkout is temporarily unavailable." });
  }
});

router.get("/billing/reconcile", async (req, res) => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication is required." });
    return;
  }

  const sessionId =
    typeof req.query.session_id === "string" ? req.query.session_id : "";
  try {
    const paid = sessionId
      ? await reconcileOwnedCheckoutSession(sessionId, userId)
      : false;
    res.json({ paid });
  } catch (error) {
    const status = error instanceof StripeProviderError ? error.status : undefined;
    logger.error({ status }, "Unable to reconcile the Clipwise Checkout session.");
    res.status(503).json({ error: "Checkout status is temporarily unavailable." });
  }
});

export async function handleStripeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Stripe webhook requires a raw request body." });
    return;
  }

  try {
    await handleStripeWebhookPayload(req.body);
    res.status(200).json({ received: true });
  } catch (error) {
    const status = error instanceof StripeProviderError ? error.status : undefined;
    logger.error({ status }, "Stripe webhook processing failed.");
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

export default router;