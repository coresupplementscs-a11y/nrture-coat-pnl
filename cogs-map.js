// COGS mapping: product_id → variant_title → landed cost per pack
// NRTURE COAT & PROTECT — fill in your Shopify product ID and COGS per variant

const COGS_MAP = {
  // NRTURE COAT & PROTECT
  '9314830352637': {
    '1': 16.90,  // 1-pack total landed ($14.70 + $2.20)
    '2': 28.10,  // 2-pack total landed ($23.70 + $4.40)
    '3': 43.40,  // 3-pack total landed ($34.60 + $8.80)
    '5': 67.40,  // 5-pack total landed ($56.40 + $11.00)
  },
};

function getCogs(productId, variantTitle) {
  const product = COGS_MAP[String(productId)];
  if (!product) return null;
  return product[String(variantTitle)] ?? null;
}

function getProductName(productId) {
  const names = {
    '9314830352637': 'NRTURE COAT & PROTECT',
  };
  return names[String(productId)] || `Product ${productId}`;
}

module.exports = { COGS_MAP, getCogs, getProductName };
