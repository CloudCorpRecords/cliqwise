import {
  stripeApiRequest,
  stripePostForm,
  StripeProviderError,
} from "./stripeClient";

const CREDIT_PACKS = [
  { key: "starter", name: "Starter", credits: 120, unitAmount: 1_200 },
  { key: "creator", name: "Creator", credits: 600, unitAmount: 4_900 },
  { key: "studio", name: "Studio", credits: 1_800, unitAmount: 12_900 },
] as const;

type StripeProduct = {
  id: string;
  name: string;
  active: boolean;
  metadata: Record<string, string>;
};

type StripePrice = {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: unknown | null;
};

type StripePage<T> = {
  data: T[];
  has_more: boolean;
};

function queryPath(path: string, params: Array<[string, string | number]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    query.append(key, String(value));
  }
  return `${path}?${query.toString()}`;
}

async function listProducts(): Promise<StripeProduct[]> {
  const products: StripeProduct[] = [];
  let startingAfter: string | undefined;
  do {
    const params: Array<[string, string | number]> = [
      ["active", "true"],
      ["limit", 100],
    ];
    if (startingAfter) {
      params.push(["starting_after", startingAfter]);
    }
    const page = await stripeApiRequest<StripePage<StripeProduct>>(
      queryPath("/v1/products", params),
    );
    products.push(...page.data);
    startingAfter = page.has_more
      ? page.data[page.data.length - 1]?.id
      : undefined;
  } while (startingAfter);
  return products;
}

async function findOrCreateProduct(
  pack: (typeof CREDIT_PACKS)[number],
): Promise<StripeProduct> {
  const existingProduct = (await listProducts()).find(
    (product) =>
      product.metadata.app === "clipwise" &&
      product.metadata.pack === pack.key,
  );
  const fields: Array<[string, string | number]> = [
    ["name", pack.name],
    ["active", "true"],
    ["metadata[app]", "clipwise"],
    ["metadata[pack]", pack.key],
    ["metadata[credits]", pack.credits],
  ];

  if (existingProduct) {
    return stripePostForm<StripeProduct>(
      `/v1/products/${encodeURIComponent(existingProduct.id)}`,
      fields,
    );
  }

  return stripePostForm<StripeProduct>(
    "/v1/products",
    [
      ...fields,
      ["description", `${pack.credits} Clipwise video-processing credits.`],
    ],
    `clipwise-${pack.key}-product-v1`,
  );
}

async function listActivePrices(productId: string): Promise<StripePrice[]> {
  const prices: StripePrice[] = [];
  let startingAfter: string | undefined;
  do {
    const params: Array<[string, string | number]> = [
      ["product", productId],
      ["active", "true"],
      ["limit", 100],
    ];
    if (startingAfter) {
      params.push(["starting_after", startingAfter]);
    }
    const page = await stripeApiRequest<StripePage<StripePrice>>(
      queryPath("/v1/prices", params),
    );
    prices.push(...page.data);
    startingAfter = page.has_more
      ? page.data[page.data.length - 1]?.id
      : undefined;
  } while (startingAfter);
  return prices;
}

async function deactivatePrice(priceId: string): Promise<void> {
  await stripePostForm(
    `/v1/prices/${encodeURIComponent(priceId)}`,
    [["active", "false"]],
  );
}

async function ensurePackPrice(
  product: StripeProduct,
  pack: (typeof CREDIT_PACKS)[number],
): Promise<StripePrice> {
  const activePrices = await listActivePrices(product.id);
  const desiredPrice = activePrices.find(
    (price) =>
      price.unit_amount === pack.unitAmount &&
      price.currency === "usd" &&
      !price.recurring,
  );

  if (desiredPrice) {
    await Promise.all(
      activePrices
        .filter((price) => price.id !== desiredPrice.id)
        .map((price) => deactivatePrice(price.id)),
    );
    return desiredPrice;
  }

  const price = await stripePostForm<StripePrice>(
    "/v1/prices",
    [
      ["product", product.id],
      ["unit_amount", pack.unitAmount],
      ["currency", "usd"],
      ["metadata[app]", "clipwise"],
      ["metadata[pack]", pack.key],
      ["metadata[credits]", pack.credits],
    ],
    `clipwise-${pack.key}-price-usd-${pack.unitAmount}-v1`,
  );
  await Promise.all(activePrices.map((activePrice) => deactivatePrice(activePrice.id)));
  return price;
}

async function seedCreditPacks(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT_ID) {
    throw new Error("Credit pack seeding is restricted to development.");
  }

  for (const pack of CREDIT_PACKS) {
    const product = await findOrCreateProduct(pack);
    const price = await ensurePackPrice(product, pack);
    console.info(`Seeded ${pack.name} pack (${product.id}, ${price.id}).`);
  }
}

seedCreditPacks().catch((error: unknown) => {
  if (error instanceof StripeProviderError) {
    console.error(
      `Failed to seed Clipwise credit packs (Stripe HTTP ${error.status}).`,
    );
  } else {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Failed to seed Clipwise credit packs (${errorType}).`);
  }
  process.exitCode = 1;
});