import { ReplitConnectors } from "@replit/connectors-sdk";

const stripeProxyFetch = new ReplitConnectors().createProxyFetch("stripe");

export class StripeProviderError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Stripe provider request failed with HTTP ${status}.`);
    this.name = "StripeProviderError";
    this.status = status;
  }
}

type StripeRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | URLSearchParams | null;
};

/**
 * Calls Stripe through Replit's authenticated connector proxy. The proxy
 * injects credentials server-side; application code never reads or stores
 * Stripe keys.
 */
export async function stripeApiRequest<T>(
  path: string,
  options: StripeRequestOptions = {},
): Promise<T> {
  const response = await stripeProxyFetch(path, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    body: options.body,
  });

  if (!response.ok) {
    throw new StripeProviderError(response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Stripe provider returned an invalid JSON response.");
  }
}

export function stripeForm(fields: Array<[string, string | number]>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of fields) {
    form.append(key, String(value));
  }
  return form;
}

export async function stripePostForm<T>(
  path: string,
  fields: Array<[string, string | number]>,
  idempotencyKey?: string,
): Promise<T> {
  return stripeApiRequest<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: stripeForm(fields),
  });
}