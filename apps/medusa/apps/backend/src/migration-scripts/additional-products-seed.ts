import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createPriceListsWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows";

export default async function additional_products_seed({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("Fetching existing infrastructure for additional products...");

  // Get default sales channel
  const { data: salesChannels } = await query.graph({
    entity: "sales_channel",
    fields: ["id", "name"],
    filters: { name: "Default Sales Channel" },
  });
  const defaultSalesChannel = salesChannels[0];
  if (!defaultSalesChannel) {
    throw new Error("Default Sales Channel not found — run initial seed first.");
  }

  // Get shipping profile
  const { data: shippingProfiles } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  });
  const shippingProfile = shippingProfiles[0];
  if (!shippingProfile) {
    throw new Error("Shipping profile not found — run initial seed first.");
  }

  // Get category IDs
  const { data: categories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name"],
  });
  const catId = (name: string) => {
    const cat = categories.find((c) => c.name === name);
    if (!cat) throw new Error(`Category "${name}" not found.`);
    return cat.id;
  };

  logger.info("Seeding non-deal products...");
  await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Classic Polo",
          category_ids: [catId("Shirts")],
          description:
            "A timeless polo shirt crafted from premium piqué cotton. Ideal for casual and smart-casual occasions.",
          handle: "classic-polo",
          weight: 350,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/tee-black-front.png" },
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/tee-white-front.png" },
          ],
          options: [
            { title: "Size", values: ["S", "M", "L", "XL"] },
            { title: "Color", values: ["Navy", "White"] },
          ],
          variants: ["S", "M", "L", "XL"].flatMap((size) =>
            ["Navy", "White"].map((color) => ({
              title: `${size} / ${color}`,
              sku: `POLO-${size}-${color.toUpperCase()}`,
              options: { Size: size, Color: color },
              prices: [
                { amount: 2500, currency_code: "eur" },
                { amount: 2800, currency_code: "usd" },
              ],
            }))
          ),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
        {
          title: "Vintage Cap",
          category_ids: [catId("Merch")],
          description:
            "Structured six-panel cap with embroidered logo. One size fits most with an adjustable strap.",
          handle: "vintage-cap",
          weight: 150,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/shorts-vintage-front.png" },
          ],
          options: [{ title: "Color", values: ["Black", "Khaki", "Navy"] }],
          variants: ["Black", "Khaki", "Navy"].map((color) => ({
            title: color,
            sku: `CAP-${color.toUpperCase()}`,
            options: { Color: color },
            prices: [
              { amount: 2000, currency_code: "eur" },
              { amount: 2200, currency_code: "usd" },
            ],
          })),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
        {
          title: "Jogger Set",
          category_ids: [catId("Pants")],
          description:
            "Matching jogger and top set in ultra-soft French terry. Perfect for lounging or light workouts.",
          handle: "jogger-set",
          weight: 700,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatpants-gray-front.png" },
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatpants-gray-back.png" },
          ],
          options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
          variants: ["S", "M", "L", "XL"].map((size) => ({
            title: size,
            sku: `JOGGER-SET-${size}`,
            options: { Size: size },
            prices: [
              { amount: 6000, currency_code: "eur" },
              { amount: 6500, currency_code: "usd" },
            ],
          })),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
        {
          title: "Canvas Tote",
          category_ids: [catId("Merch")],
          description:
            "Heavy-duty 12oz canvas tote with reinforced handles. Holds up to 15kg. Zero single-use plastic.",
          handle: "canvas-tote",
          weight: 300,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/shorts-vintage-back.png" },
          ],
          options: [{ title: "Color", values: ["Natural", "Black"] }],
          variants: ["Natural", "Black"].map((color) => ({
            title: color,
            sku: `TOTE-${color.toUpperCase()}`,
            options: { Color: color },
            prices: [
              { amount: 2500, currency_code: "eur" },
              { amount: 2700, currency_code: "usd" },
            ],
          })),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
      ],
    },
  });
  logger.info("Non-deal products seeded.");

  logger.info("Seeding deal products...");
  const { result: dealProducts } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Cargo Pants",
          category_ids: [catId("Pants")],
          description:
            "Multi-pocket cargo trousers in durable ripstop fabric. Relaxed fit with tapered ankle.",
          handle: "cargo-pants",
          weight: 600,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatpants-gray-front.png" },
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatpants-gray-back.png" },
          ],
          options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
          variants: ["S", "M", "L", "XL"].map((size) => ({
            title: size,
            sku: `CARGO-${size}`,
            options: { Size: size },
            prices: [
              { amount: 4500, currency_code: "eur" },
              { amount: 5000, currency_code: "usd" },
            ],
          })),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
        {
          title: "Zip Hoodie",
          category_ids: [catId("Sweatshirts")],
          description:
            "Full-zip hoodie in heavyweight fleece with a brushed interior. Double-lined hood and kangaroo pocket.",
          handle: "zip-hoodie",
          weight: 700,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatshirt-vintage-front.png" },
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatshirt-vintage-back.png" },
          ],
          options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
          variants: ["S", "M", "L", "XL"].map((size) => ({
            title: size,
            sku: `ZIP-HOODIE-${size}`,
            options: { Size: size },
            prices: [
              { amount: 5500, currency_code: "eur" },
              { amount: 6000, currency_code: "usd" },
            ],
          })),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
        {
          title: "Track Jacket",
          category_ids: [catId("Sweatshirts")],
          description:
            "Lightweight track jacket with contrast side stripes and mock-neck collar. Moisture-wicking shell.",
          handle: "track-jacket",
          weight: 450,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/sweatshirt-vintage-front.png" },
          ],
          options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
          variants: ["S", "M", "L", "XL"].map((size) => ({
            title: size,
            sku: `TRACK-JACKET-${size}`,
            options: { Size: size },
            prices: [
              { amount: 4500, currency_code: "eur" },
              { amount: 4800, currency_code: "usd" },
            ],
          })),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
        {
          title: "Crew Neck Tee",
          category_ids: [catId("Shirts")],
          description:
            "Relaxed crew neck tee in 100% organic ring-spun cotton. Pre-shrunk and enzyme-washed for softness.",
          handle: "crew-neck-tee",
          weight: 280,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          images: [
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/tee-black-front.png" },
            { url: "https://medusa-public-images.s3.eu-west-1.amazonaws.com/tee-white-front.png" },
          ],
          options: [
            { title: "Size", values: ["S", "M", "L", "XL"] },
            { title: "Color", values: ["Black", "White"] },
          ],
          variants: ["S", "M", "L", "XL"].flatMap((size) =>
            ["Black", "White"].map((color) => ({
              title: `${size} / ${color}`,
              sku: `CREW-${size}-${color.toUpperCase()}`,
              options: { Size: size, Color: color },
              prices: [
                { amount: 1800, currency_code: "eur" },
                { amount: 2000, currency_code: "usd" },
              ],
            }))
          ),
          sales_channels: [{ id: defaultSalesChannel.id }],
        },
      ],
    },
  });
  logger.info("Deal products seeded.");

  logger.info("Creating Seasonal Sale price list...");

  // Map SKU prefix → sale price (eur)
  const salePrices: Record<string, number> = {
    "CARGO-":       3200,
    "ZIP-HOODIE-":  4000,
    "TRACK-JACKET-":3200,
    "CREW-":        1200,
  };

  const priceEntries = dealProducts.flatMap((product) =>
    (product.variants ?? []).flatMap((variant) => {
      const sku = variant.sku ?? "";
      const prefix = Object.keys(salePrices).find((k) => sku.startsWith(k));
      if (!prefix) return [];
      return [
        { variant_id: variant.id, amount: salePrices[prefix], currency_code: "eur" },
        { variant_id: variant.id, amount: Math.round(salePrices[prefix] * 1.1), currency_code: "usd" },
      ];
    })
  );

  if (priceEntries.length > 0) {
    await createPriceListsWorkflow(container).run({
      input: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        price_lists_data: [
          {
            name: "Seasonal Sale",
            title: "Seasonal Sale",
            description: "Limited-time discounts on selected items",
            type: "sale",
            status: "active",
            prices: priceEntries,
          },
        ] as any,
      },
    });
    logger.info(`Price list created with ${priceEntries.length} entries.`);
  }

  logger.info("Seeding inventory for new products...");
  const { data: stockLocations } = await query.graph({
    entity: "stock_location",
    fields: ["id", "name"],
  });
  const stockLocation = stockLocations[0];

  if (stockLocation) {
    const { data: inventoryItems } = await query.graph({
      entity: "inventory_item",
      fields: ["id"],
    });

    // Only set inventory for items that don't yet have levels at this location
    const { data: existingLevels } = await query.graph({
      entity: "inventory_level",
      fields: ["inventory_item_id"],
      filters: { location_id: stockLocation.id },
    });
    const existingItemIds = new Set(existingLevels.map((l: any) => l.inventory_item_id));
    const newItems = inventoryItems.filter((item: any) => !existingItemIds.has(item.id));

    if (newItems.length > 0) {
      const { createInventoryLevelsWorkflow } = await import("@medusajs/medusa/core-flows");
      await createInventoryLevelsWorkflow(container).run({
        input: {
          inventory_levels: newItems.map((item: any) => ({
            location_id: stockLocation.id,
            stocked_quantity: 1000000,
            inventory_item_id: item.id,
          })),
        },
      });
      logger.info(`Inventory set for ${newItems.length} new items.`);
    }
  }

  logger.info("Additional products seed complete.");
}
