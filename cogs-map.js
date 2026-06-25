// COGS mapping: product_id → variant_title → landed cost per pack
// NRTURE COAT & PROTECT — fill in your Shopify product ID and COGS per variant

const COGS_MAP = {
  // NRTURE COAT & PROTECT
  '9314830352637': {
    '1': 16.90,  // 1-pack landed cost ($14.70 product + $2.20 shipping)
    '3': 43.40,  // 3-pack landed cost ($34.60 product + $8.80 shipping)
    '5': 67.40,  // 5-pack landed cost ($56.40 product + $11.00 shipping)
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
