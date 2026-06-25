// COGS mapping: product_id → variant_title → landed cost per pack
// NRTURE COAT & PROTECT — fill in your Shopify product ID and COGS per variant

const COGS_MAP = {
  // NRTURE COAT & PROTECT
  // Replace 'PRODUCT_ID' with the actual Shopify product ID
  // Variant titles must match exactly what Shopify stores (check /api/orders to confirm)
  'PRODUCT_ID': {
    '120 Days Risk Free': 0,  // TODO: set landed cost
    'Buy 2 Get 1 Free':   0,  // TODO: set landed cost
    'Buy 3 Get 2 Free':   0,  // TODO: set landed cost
  },
};

function getCogs(productId, variantTitle) {
  const product = COGS_MAP[String(productId)];
  if (!product) return null;
  return product[String(variantTitle)] ?? null;
}

function getProductName(productId) {
  const names = {
    'PRODUCT_ID': 'NRTURE COAT & PROTECT',
  };
  return names[String(productId)] || `Product ${productId}`;
}

module.exports = { COGS_MAP, getCogs, getProductName };
