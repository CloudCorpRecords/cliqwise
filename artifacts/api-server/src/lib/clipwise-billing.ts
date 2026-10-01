import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { ensureAccount } from "./clipwise-store";
import { logger } from "./logger";
import {
  stripeApiRequest,
  stripePostForm,
  StripeProviderError,
} from "./stripeClient";

type StripeProduct = {
  id: string;
  object: "product";
  active: boolean;
  name: string;
  metadata: Record<string, string>;
  deleted?: false;
};

type StripeDeletedProduct = {
  id: string;
  object: "product";
  deleted: true;
};

type StripePrice = {
  id: string;
  object: "price";
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: unknown | null;
  product: string | StripeProduct | StripeDeletedProduct;
};

type StripeList<T> = {
  data: T[];
  has_more: boolean;
};

type StripeCheckoutSession = {
  id: string;
  object: "checkout.session";
  mode: string;
  status: string | null;
  payment_status: string;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
};

type StripeLineItem = {
  quantity: number | null;
  price: StripePrice | null;
};

type StripeEvent = {
  id: string;
  object: "event";
  type: string;
  data?: {
    object?: {
      id?: string;
      object?: string;
    };
  };
};

export type CreditPack = {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
};

export class InvalidCreditPackError extends Error {
  constructor() {
    super("This price is not an active Clipwise credit pack.");
    this.name = "InvalidCreditPackError";
  }
}

function positiveCredits(value: unknown): number | null {
  const credits = typeof value === "number" ? value : Number(value);
  return Number.isFinite(credits) && credits > 0 ? credits : null;
}

function isDeletedProduct(
  product: StripeProduct | StripeDeletedProduct,
): product is StripeDeletedProduct {
  return "deleted" in product && product.deleted === true;
}

function getQueryPath(
  path: string,
  params: Array<[string, string | number]>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    query.append(key, String(value));
  }
  return `${path}?${query.toString()}`;
}

async function getProduct(
  product: string | StripeProduct | StripeDeletedProduct,
): Promise<StripeProduct | null> {
  const result =
    typeof product === "string"
      ? await stripeApiRequest<StripeProduct | StripeDeletedProduct>(
          `/v1/products/${encodeURIComponent(product)}`,
        )
      : product;
  return isDeletedProduct(result) ? null : result;
}

async function listActivePrices(): Promise<StripePrice[]> {
  const prices: StripePrice[] = [];
  let startingAfter: string | undefined;

  do {
    const params: Array<[string, string | number]> = [
      ["active", "true"],
      ["limit", 100],
      ["expand[]", "data.product"],
    ];
    if (startingAfter) {
      params.push(["starting_after", startingAfter]);
    }
    const page = await stripeApiRequest<StripeList<StripePrice>>(
      getQueryPath("/v1/prices", params),
    );
    prices.push(...page.data);
    startingAfter = page.has_more
      ? page.data[page.data.length - 1]?.id
      : undefined;
  } while (startingAfter);

  return prices;
}

function mapCreditPack(price: StripePrice, product: StripeProduct): CreditPack | null {
  const credits = positiveCredits(product.metadata.credits);
  if (
    !price.active ||
    price.recurring ||
    !credits ||
    !Number.isInteger(price.unit_amount) ||
    price.unit_amount === null ||
    price.unit_amount < 0 ||
    !price.currency
  ) {
    return null;
  }

  return {
    id: price.id,
    name: product.name,
    credits,
    priceCents: price.unit_amount,
    currency: price.currency.toLowerCase(),
  };
}

export async function listClipwiseCreditPacks(): Promise<CreditPack[]> {
  const prices = await listActivePrices();
  const packs: CreditPack[] = [];
  for (const price of prices) {
    const product = await getProduct(price.product);
    if (!product?.active || product.metadata.app !== "clipwise") {
      continue;
    }
    const pack = mapCreditPack(price, product);
    if (pack) {
      packs.push(pack);
    }
  }

  return packs.sort(
    (left, right) =>
      left.priceCents - right.priceCents || left.name.localeCompare(right.name),
  );
}

function parsePublicOrigin(value: string): URL {
  const authority = value.trim().match(/^https:\/\/([^/?#]*)/i)?.[1];
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("A valid public HTTPS origin is required for Stripe Checkout.");
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    !authority ||
    authority.includes("@") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("A valid public HTTPS origin is required for Stripe Checkout.");
  }
  return new URL(url.origin);
}

function getTrustedAppOrigin(callerOrigin?: string): URL {
  const configuredOrigin = process.env.PUBLIC_APP_URL?.trim();
  if (configuredOrigin) {
    return parsePublicOrigin(configuredOrigin);
  }
  if (callerOrigin) {
    return parsePublicOrigin(callerOrigin);
  }
  throw new Error("A public app origin is required for Stripe Checkout.");
}

function assertCheckoutPrice(price: StripePrice, product: StripeProduct | null): number {
  const credits = positiveCredits(product?.metadata.credits);
  if (
    !price.active ||
    price.recurring ||
    !product?.active ||
    product.metadata.app !== "clipwise" ||
    !credits
  ) {
    throw new InvalidCreditPackError();
  }
  return credits;
}

export async function createClipwiseCheckout(
  userId: string,
  priceId: string,
  callerOrigin?: string,
): Promise<string> {
  const price = await stripeApiRequest<StripePrice>(
    getQueryPath(`/v1/prices/${encodeURIComponent(priceId)}`, [
      ["expand[]", "product"],
    ]),
  );
  const product = await getProduct(price.product);
  assertCheckoutPrice(price, product);
  const origin = getTrustedAppOrigin(callerOrigin);
  await ensureAccount(userId);

  void ensureWebhookEndpoint(origin.origin).catch((error: unknown) => {
    reportBackgroundBillingError(
      "Could not register the Clipwise Stripe webhook endpoint.",
      error,
    );
  });
  const session = await stripePostForm<{ id: string; url: string | null }>(
    "/v1/checkout/sessions",
    [
      ["mode", "payment"],
      ["line_items[0][price]", price.id],
      ["line_items[0][quantity]", 1],
      ["client_reference_id", userId],
      ["metadata[app]", "clipwise"],
      ["metadata[userId]", userId],
      ["metadata[priceId]", price.id],
      [
        "success_url",
        new URL(
          "/billing?success=1&session_id={CHECKOUT_SESSION_ID}",
          origin,
        ).toString(),
      ],
      ["cancel_url", new URL("/billing?checkout=cancelled", origin).toString()],
    ],
  );

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL.");
  }
  return session.url;
}

function isCheckoutSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_[A-Za-z0-9_]+$/.test(value);
}

async function retrieveSessionAndLineItems(
  sessionId: string,
): Promise<{ session: StripeCheckoutSession; lineItems: StripeLineItem[] }> {
  const session = await stripeApiRequest<StripeCheckoutSession>(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
  const lineItems = await stripeApiRequest<StripeList<StripeLineItem>>(
    getQueryPath(
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`,
      [
        ["limit", 100],
        ["expand[]", "data.price.product"],
      ],
    ),
  );
  return { session, lineItems: lineItems.data };
}

async function fulfillPaidCheckout(
  sessionId: string,
  expectedUserId?: string,
): Promise<boolean> {
  if (!isCheckoutSessionId(sessionId)) {
    return false;
  }

  const { session, lineItems } = await retrieveSessionAndLineItems(sessionId);
  const userId = session.client_reference_id;
  if (
    session.id !== sessionId ||
    session.object !== "checkout.session" ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.metadata?.app !== "clipwise" ||
    !userId ||
    session.metadata.userId !== userId ||
    (expectedUserId !== undefined && userId !== expectedUserId) ||
    lineItems.length !== 1
  ) {
    return false;
  }

  const lineItem = lineItems[0];
  const price = lineItem.price;
  if (!price || lineItem.quantity !== 1 || price.recurring) {
    return false;
  }
  const product = await getProduct(price.product);
  const credits = positiveCredits(product?.metadata.credits);
  if (!product || product.metadata.app !== "clipwise" || !credits) {
    return false;
  }

  await ensureAccount(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = await client.query<{ id: string }>(
      "SELECT id FROM cw_accounts WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (account.rowCount !== 1) {
      throw new Error("Clipwise account was not available for credit fulfillment.");
    }

    const ledgerEntry = await client.query(
      `INSERT INTO cw_ledger
        (id, user_id, type, description, credits, job_id, stripe_session_id)
       VALUES ($1, $2, 'purchase', $3, $4, NULL, $5)
       ON CONFLICT (stripe_session_id) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        userId,
        `Purchased ${product.name} credit pack`,
        credits,
        session.id,
      ],
    );

    if (ledgerEntry.rowCount === 1) {
      await client.query(
        "UPDATE cw_accounts SET paid_credits = paid_credits + $1 WHERE id = $2",
        [credits, userId],
      );
    }

    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("Clipwise credit fulfillment failed.");
  } finally {
    client.release();
  }
}

export async function reconcileOwnedCheckoutSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  return fulfillPaidCheckout(sessionId, userId);
}

export async function handleStripeWebhookPayload(payload: Buffer): Promise<void> {
  if (!Buffer.isBuffer(payload)) {
    throw new Error("Stripe webhook payload must be a raw Buffer.");
  }

  let postedEventId: unknown;
  try {
    const postedEvent = JSON.parse(payload.toString("utf8")) as {
      id?: unknown;
    };
    postedEventId = postedEvent.id;
  } catch {
    throw new Error("Stripe webhook body was not valid JSON.");
  }

  if (
    typeof postedEventId !== "string" ||
    !/^evt_[A-Za-z0-9_]+$/.test(postedEventId)
  ) {
    return;
  }

  // The webhook body is untrusted. Only use its event ID to fetch the
  // authenticated, canonical event from Stripe through the Replit proxy.
  const event = await stripeApiRequest<StripeEvent>(
    `/v1/events/${encodeURIComponent(postedEventId)}`,
  );
  const eventObject = event.data?.object;
  if (
    event.id !== postedEventId ||
    event.object !== "event" ||
    (event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded") ||
    !eventObject ||
    eventObject.object !== "checkout.session" ||
    !isCheckoutSessionId(eventObject.id)
  ) {
    return;
  }

  await fulfillPaidCheckout(eventObject.id);
}

const configuredWebhookOrigins = new Set<string>();
const registeredWebhookOrigins = new Set<string>();
const webhookRegistrationPromises = new Map<string, Promise<void>>();

async function registerWebhookEndpoint(origin: string): Promise<void> {
  const webhookUrl = new URL("/api/stripe/webhook", origin).toString();
  const enabledEvents = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ];

  let startingAfter: string | undefined;
  let matchingEndpoint:
    | { id: string; url: string; enabled_events?: string[] }
    | undefined;
  do {
    const params: Array<[string, string | number]> = [["limit", 100]];
    if (startingAfter) {
      params.push(["starting_after", startingAfter]);
    }
    const page = await stripeApiRequest<
      StripeList<{ id: string; url: string; enabled_events?: string[] }>
    >(getQueryPath("/v1/webhook_endpoints", params));
    matchingEndpoint = page.data.find((endpoint) => endpoint.url === webhookUrl);
    startingAfter = page.has_more
      ? page.data[page.data.length - 1]?.id
      : undefined;
  } while (!matchingEndpoint && startingAfter);

  if (matchingEndpoint) {
    if (enabledEvents.every((event) => matchingEndpoint?.enabled_events?.includes(event))) {
      return;
    }
    const fields = enabledEvents.map(
      (event) => ["enabled_events[]", event] as [string, string],
    );
    await stripePostForm(
      `/v1/webhook_endpoints/${encodeURIComponent(matchingEndpoint.id)}`,
      fields,
    );
    return;
  }

  await stripePostForm("/v1/webhook_endpoints", [
    ["url", webhookUrl],
    ...enabledEvents.map(
      (event) => ["enabled_events[]", event] as [string, string],
    ),
  ]);
}

async function ensureWebhookEndpoint(publicOrigin: string): Promise<void> {
  const origin = parsePublicOrigin(publicOrigin).origin;
  configuredWebhookOrigins.add(origin);
  if (registeredWebhookOrigins.has(origin)) {
    return;
  }

  const pending = webhookRegistrationPromises.get(origin);
  if (pending) {
    return pending;
  }

  const registration = registerWebhookEndpoint(origin)
    .then(() => {
      registeredWebhookOrigins.add(origin);
    })
    .finally(() => {
      webhookRegistrationPromises.delete(origin);
    });
  webhookRegistrationPromises.set(origin, registration);
  return registration;
}

function getStartupWebhookOrigin(): string | undefined {
  const configuredOrigin = process.env.PUBLIC_APP_URL?.trim();
  if (configuredOrigin) {
    return parsePublicOrigin(configuredOrigin).origin;
  }
  const isProductionDeployment =
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.REPLIT_DEPLOYMENT_ID) ||
    Boolean(process.env.REPLIT_DEPLOYMENT_ENVIRONMENT) ||
    Boolean(process.env.WEB_REPL_RENEWAL);
  if (isProductionDeployment) {
    return undefined;
  }

  const developmentDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return developmentDomain
    ? parsePublicOrigin(`https://${developmentDomain}`).origin
    : undefined;
}

let reconciliationTimer: NodeJS.Timeout | undefined;
let reconciliationRunning = false;

async function reconcileRecentPaidCheckouts(): Promise<void> {
  if (reconciliationRunning) {
    return;
  }
  reconciliationRunning = true;
  try {
    const createdAfter = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    let startingAfter: string | undefined;

    do {
      const params: Array<[string, string | number]> = [
        ["status", "complete"],
        ["created[gte]", createdAfter],
        ["limit", 100],
      ];
      if (startingAfter) {
        params.push(["starting_after", startingAfter]);
      }

      const page = await stripeApiRequest<StripeList<StripeCheckoutSession>>(
        getQueryPath("/v1/checkout/sessions", params),
      );
      for (const session of page.data) {
        if (
          session.metadata?.app === "clipwise" &&
          session.client_reference_id &&
          session.metadata.userId === session.client_reference_id
        ) {
          await fulfillPaidCheckout(session.id);
        }
      }
      startingAfter = page.has_more
        ? page.data[page.data.length - 1]?.id
        : undefined;
    } while (startingAfter);
  } finally {
    reconciliationRunning = false;
  }
}

function reportBackgroundBillingError(message: string, error: unknown): void {
  const status = error instanceof StripeProviderError ? error.status : undefined;
  logger.error({ status }, message);
}

export async function initStripeBilling(): Promise<void> {
  if (!reconciliationTimer) {
    // Polling is intentionally detached so Stripe connectivity never blocks
    // API startup. Billing requests report provider outages explicitly.
    try {
      const startupOrigin = getStartupWebhookOrigin();
      if (startupOrigin) {
        void ensureWebhookEndpoint(startupOrigin).catch((error: unknown) => {
          reportBackgroundBillingError(
            "Could not register the Clipwise Stripe webhook endpoint.",
            error,
          );
        });
      } else if (
        process.env.NODE_ENV === "production" ||
        process.env.REPLIT_DEPLOYMENT_ID ||
        process.env.REPLIT_DEPLOYMENT_ENVIRONMENT ||
        process.env.WEB_REPL_RENEWAL
      ) {
        logger.info(
          "Stripe webhook registration is deferred until checkout supplies a validated public origin.",
        );
      }
    } catch (error) {
      reportBackgroundBillingError(
        "Could not determine a safe Clipwise Stripe webhook origin.",
        error,
      );
    }
    void reconcileRecentPaidCheckouts().catch((error: unknown) => {
      reportBackgroundBillingError(
        "Clipwise Stripe checkout reconciliation failed.",
        error,
      );
    });

    reconciliationTimer = setInterval(() => {
      for (const origin of configuredWebhookOrigins) {
        void ensureWebhookEndpoint(origin).catch((error: unknown) => {
          reportBackgroundBillingError(
            "Could not register the Clipwise Stripe webhook endpoint.",
            error,
          );
        });
      }
      void reconcileRecentPaidCheckouts().catch((error: unknown) => {
        reportBackgroundBillingError(
          "Clipwise Stripe checkout reconciliation failed.",
          error,
        );
      });
    }, 5 * 60 * 1000);
    reconciliationTimer.unref();
  }
}