require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const fetch   = require('node-fetch');
const { DatabaseSync } = require('node:sqlite');
const { getCogs, getProductName } = require('./cogs-map');

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = process.env.DB_PATH || './pnl.db';
const db = new DatabaseSync(DB_PATH);

// Only Meta campaigns whose name contains one of these substrings count toward
// this P&L (case-insensitive). Comma-separated; override on Railway with META_CAMPAIGN_FILTER.
const META_CAMPAIGN_PATTERNS = (process.env.META_CAMPAIGN_FILTER || 'bud')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
// Builds an SQL fragment + params: matches if campaign name contains ANY pattern.
function metaCampaignFilter() {
  if (!META_CAMPAIGN_PATTERNS.length) return { clause: '1=1', params: [] };
  const clause = '(' + META_CAMPAIGN_PATTERNS
    .map(() => `LOWER(campaign_name) LIKE '%' || ? || '%'`).join(' OR ') + ')';
  return { clause, params: META_CAMPAIGN_PATTERNS };
}

// Only Shopify line items whose product name contains this substring count.
// Set SHOPIFY_PRODUCT_FILTER on Railway to scope this P&L to one product.
const PRODUCT_FILTER = (process.env.SHOPIFY_PRODUCT_FILTER || 'nrture').toLowerCase().trim();
function productFilter() {
  if (!PRODUCT_FILTER) return { clause: '1=1', param: null };
  return { clause: `LOWER(li.product_name) LIKE '%' || ? || '%'`, param: PRODUCT_FILTER };
}

// ── EASTERN TIME (America/New_York, DST-aware) ──
// Orders' created_at are stored as UTC ISO strings. To filter by an Eastern
// calendar day we convert the Eastern wall-clock boundaries to the matching
// UTC instant. June → EDT (UTC-4), winter → EST (UTC-5); handled automatically.
const TZ = 'America/New_York';

// Minutes Eastern wall-clock leads UTC at a given instant (EDT=-240, EST=-300).
function easternOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                         hour, Number(p.minute), Number(p.second));
  return (asUTC - date.getTime()) / 60000;
}

// Convert an Eastern wall-clock date ('YYYY-MM-DD') to a UTC ISO instant.
// endOfDay=false → 00:00:00 Eastern; endOfDay=true → 23:59:59 Eastern.
function easternDateToUtcISO(dateStr, endOfDay) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return endOfDay ? dateStr + 'T23:59:59Z' : dateStr + 'T00:00:00Z';
  const hh = endOfDay ? 23 : 0, mm = endOfDay ? 59 : 0, ss = endOfDay ? 59 : 0;
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);      // wall-clock as if UTC
  const off = easternOffsetMinutes(new Date(guess));     // offset at that instant
  return new Date(guess - off * 60000).toISOString();    // real UTC instant
}

// ─────────────────────────────────────────────────────────────
//  SCHEMA
// ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shopify_orders (
    shopify_id         TEXT PRIMARY KEY,
    order_number       TEXT,
    customer_name      TEXT,
    customer_email     TEXT,
    total_price        REAL,
    subtotal_price     REAL,
    total_tax          REAL,
    total_discounts    REAL,
    financial_status   TEXT,
    fulfillment_status TEXT,
    presentment_currency TEXT,
    created_at         TEXT,
    synced_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS order_line_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_order_id TEXT,
    product_id       TEXT,
    product_name     TEXT,
    variant_title    TEXT,
    quantity         INTEGER,
    price            REAL,
    total_discount   REAL,
    line_revenue     REAL,
    cogs_per_pack    REAL,
    cogs_total       REAL,
    gross_profit     REAL,
    presentment_currency TEXT,
    FOREIGN KEY (shopify_order_id) REFERENCES shopify_orders(shopify_id)
  );

  CREATE TABLE IF NOT EXISTS meta_spend (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT,
    campaign_id   TEXT,
    campaign_name TEXT,
    spend         REAL,
    impressions   INTEGER,
    clicks        INTEGER,
    purchases     INTEGER,
    purchase_value REAL,
    roas          REAL,
    synced_at     TEXT,
    UNIQUE(date, campaign_id)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    source    TEXT,
    status    TEXT,
    message   TEXT,
    ran_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pnl_state (
    id         INTEGER PRIMARY KEY,
    state_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────────────────────────
//  SHOPIFY SYNC
// ─────────────────────────────────────────────────────────────
const upsertOrder = db.prepare(`
  INSERT OR REPLACE INTO shopify_orders
    (shopify_id, order_number, customer_name, customer_email,
     total_price, subtotal_price, total_tax, total_discounts,
     financial_status, fulfillment_status, presentment_currency, created_at, synced_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const deleteLineItems = db.prepare(`DELETE FROM order_line_items WHERE shopify_order_id = ?`);

const insertLineItem = db.prepare(`
  INSERT INTO order_line_items
    (shopify_order_id, product_id, product_name, variant_title, quantity,
     price, total_discount, line_revenue, cogs_per_pack, cogs_total, gross_profit, presentment_currency)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);

function syncOrdersTransaction(orders) {
  let synced = 0;
  db.exec('BEGIN');
  try {
    for (const o of orders) {
      const customerName = o.billing_address
        ? `${o.billing_address.first_name || ''} ${o.billing_address.last_name || ''}`.trim()
        : (o.email || 'Unknown');

      upsertOrder.run(
        String(o.id), o.name, customerName, o.email || '',
        parseFloat(o.total_price)||0, parseFloat(o.subtotal_price)||0,
        parseFloat(o.total_tax)||0, parseFloat(o.total_discounts)||0,
        o.financial_status||'', o.fulfillment_status||'',
        o.presentment_currency||o.currency||'USD',
        o.created_at, new Date().toISOString()
      );

      deleteLineItems.run(String(o.id));
      for (const li of (o.line_items || [])) {
        const cogsPerPack = getCogs(li.product_id, li.variant_title) ?? 0;
        const lineRevenue = parseFloat(li.price) * parseInt(li.quantity);
        const cogsTotal   = cogsPerPack;
        const grossProfit = lineRevenue - cogsTotal;

        insertLineItem.run(
          String(o.id), String(li.product_id||''),
          getProductName(li.product_id)||li.title||'',
          li.variant_title||'', parseInt(li.quantity)||1,
          parseFloat(li.price)||0, parseFloat(li.total_discount)||0,
          lineRevenue, cogsPerPack, cogsTotal, grossProfit,
          o.presentment_currency||o.currency||'USD'
        );
      }
      synced++;
    }
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return synced;
}

async function syncShopify() {
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;
  const token  = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!domain || !token) {
    console.warn('[Shopify] Missing env vars — skipping sync');
    return;
  }

  try {
    console.log('[Shopify] Syncing orders…');
    let url = `https://${domain}/admin/api/2024-01/orders.json?limit=250&status=any`;
    let totalSynced = 0;

    while (url) {
      const res = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const orders = data.orders || [];
      if (!orders.length) break;

      totalSynced += syncOrdersTransaction(orders);

      // pagination via Link header
      const linkHeader = res.headers.get('Link') || '';
      const nextMatch  = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    db.prepare(`INSERT INTO sync_log (source, status, message) VALUES (?, ?, ?)`).run(
      'shopify', 'ok', `Synced ${totalSynced} orders`
    );
    console.log(`[Shopify] ✓ ${totalSynced} orders synced`);
  } catch (err) {
    db.prepare(`INSERT INTO sync_log (source, status, message) VALUES (?, ?, ?)`).run(
      'shopify', 'error', err.message
    );
    console.error('[Shopify] ✗', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  META ADS SYNC
// ─────────────────────────────────────────────────────────────
async function syncMeta(dateFrom, dateTo) {
  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) {
    console.warn('[Meta] Missing env vars — skipping sync');
    return;
  }

  const since = dateFrom || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const until = dateTo   || new Date().toISOString().slice(0, 10);

  try {
    console.log(`[Meta] Syncing ${since} → ${until}…`);
    const fields = 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values';
    const url = `https://graph.facebook.com/v18.0/${accountId}/insights` +
      `?fields=${fields}&time_range={"since":"${since}","until":"${until}"}` +
      `&level=campaign&time_increment=1&limit=500&access_token=${token}`;

    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO meta_spend
        (date, campaign_id, campaign_name, spend, impressions, clicks, purchases, purchase_value, roas, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    db.exec('BEGIN');
    for (const r of (data.data || [])) {
      const spend         = parseFloat(r.spend) || 0;
      const purchases     = (r.actions      || []).find(a => a.action_type === 'purchase')?.value || 0;
      const purchaseValue = (r.action_values || []).find(a => a.action_type === 'purchase')?.value || 0;
      upsert.run(
        r.date_start, r.campaign_id, r.campaign_name,
        spend, parseInt(r.impressions)||0, parseInt(r.clicks)||0,
        parseInt(purchases), parseFloat(purchaseValue),
        spend > 0 ? parseFloat(purchaseValue)/spend : 0,
        new Date().toISOString()
      );
    }
    db.exec('COMMIT');
    const rowCount = (data.data || []).length;
    db.prepare(`INSERT INTO sync_log (source, status, message) VALUES (?, ?, ?)`).run(
      'meta', 'ok', `Synced ${rowCount} rows (${since} → ${until})`
    );
    console.log(`[Meta] ✓ ${rowCount} rows synced`);
    return rowCount;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch(_){}
    db.prepare(`INSERT INTO sync_log (source, status, message) VALUES (?, ?, ?)`).run(
      'meta', 'error', err.message
    );
    console.error('[Meta] ✗', err.message);
    return -1; // signals failure
  }
}

// ─────────────────────────────────────────────────────────────
//  LIVE CAD→USD RATE (refreshed daily)
// ─────────────────────────────────────────────────────────────
let cadToUsd = parseFloat(process.env.META_CURRENCY_RATE || '0.703');

async function refreshCadRate() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/CAD');
    const d = await r.json();
    const rate = d.rates?.USD;
    if (rate) { cadToUsd = rate; console.log(`[FX] CAD/USD updated: ${rate}`); }
  } catch(e) { console.warn('[FX] Rate fetch failed, using', cadToUsd); }
}

// ─────────────────────────────────────────────────────────────
//  CRON JOBS
// ─────────────────────────────────────────────────────────────
cron.schedule('0 * * * *',  syncShopify);           // every hour
cron.schedule('0 6 * * *',  () => syncMeta());      // daily at 6am
cron.schedule('0 7 * * *',  refreshCadRate);        // daily at 7am

// one-time run on startup
setTimeout(syncShopify, 5000);
setTimeout(() => syncMeta(), 8000);
setTimeout(refreshCadRate, 3000);

// ─────────────────────────────────────────────────────────────
//  API ENDPOINTS
// ─────────────────────────────────────────────────────────────

// GET /api/status — last sync times
app.get('/api/status', (req, res) => {
  const logs = db.prepare(`SELECT source, status, message, ran_at FROM sync_log ORDER BY ran_at DESC LIMIT 10`).all();
  res.json({ ok: true, logs });
});

// POST /api/sync/shopify — manual trigger
app.post('/api/sync/shopify', async (req, res) => {
  syncShopify();
  res.json({ ok: true, message: 'Shopify sync triggered' });
});

// POST /api/sync/meta — syncs Meta for the given range and waits for completion
app.post('/api/sync/meta', async (req, res) => {
  const { from, to } = req.body;
  const rows = await syncMeta(from, to);
  res.json({ ok: rows >= 0, rows, message: rows >= 0 ? `Synced ${rows} rows` : 'Meta sync failed' });
});

// POST /api/sync/meta/backfill — one-time pull of full ad-spend history into the DB.
// Defaults to 2025-01-01 → today; Meta returns rows only for days that had spend.
app.post('/api/sync/meta/backfill', async (req, res) => {
  const from = req.body.from || '2025-01-01';
  const to   = req.body.to   || new Date().toISOString().slice(0, 10);
  const rows = await syncMeta(from, to);
  res.json({ ok: rows >= 0, rows, from, to, message: rows >= 0 ? `Backfilled ${rows} rows (${from} → ${to})` : 'Backfill failed — check Meta token' });
});

// GET /api/pnl?from=2026-06-01&to=2026-06-30
app.get('/api/pnl', (req, res) => {
  const from = req.query.from || '2000-01-01';
  const to   = req.query.to   || '2099-12-31';
  // Eastern calendar-day boundaries → UTC instants for filtering order timestamps
  const fromUtc = easternDateToUtcISO(from, false);
  const toUtc   = easternDateToUtcISO(to, true);

  const pf = productFilter();
  const pfArgs = pf.param !== null ? [pf.param] : [];

  // revenue by product
  const revenueByProduct = db.prepare(`
    SELECT li.product_name,
           SUM(li.line_revenue)  AS revenue,
           SUM(li.cogs_total)    AS cogs,
           SUM(li.gross_profit)  AS gross,
           COUNT(*)              AS orders
    FROM order_line_items li
    JOIN shopify_orders o ON o.shopify_id = li.shopify_order_id
    WHERE o.created_at >= ? AND o.created_at <= ?
      AND o.financial_status != 'refunded'
      AND ${pf.clause}
    GROUP BY li.product_name
    ORDER BY revenue DESC
  `).all(fromUtc, toUtc, ...pfArgs);

  // revenue by pack/variant per product
  const revenueByVariant = db.prepare(`
    SELECT li.product_name, li.variant_title,
           COUNT(*) AS orders,
           SUM(li.line_revenue) AS revenue,
           SUM(li.cogs_total)   AS cogs,
           SUM(li.gross_profit) AS gross
    FROM order_line_items li
    JOIN shopify_orders o ON o.shopify_id = li.shopify_order_id
    WHERE o.created_at >= ? AND o.created_at <= ?
      AND o.financial_status != 'refunded'
      AND ${pf.clause}
    GROUP BY li.product_name, li.variant_title
    ORDER BY li.product_name, li.variant_title
  `).all(fromUtc, toUtc, ...pfArgs);

  // meta spend by campaign (convert from Meta account currency to USD)
  const metaCurrencyRate = cadToUsd;
  const mf = metaCampaignFilter();
  const metaSpend = db.prepare(`
    SELECT campaign_name,
           SUM(spend)          AS spend,
           SUM(impressions)    AS impressions,
           SUM(clicks)         AS clicks,
           SUM(purchases)      AS purchases,
           SUM(purchase_value) AS purchase_value
    FROM meta_spend
    WHERE date >= ? AND date <= ?
      AND ${mf.clause}
    GROUP BY campaign_name
    ORDER BY spend DESC
  `).all(from, to, ...mf.params).map(r => ({ ...r, spend: r.spend * metaCurrencyRate, purchase_value: r.purchase_value * metaCurrencyRate }));

  // totals
  const totals = db.prepare(`
    SELECT
      SUM(li.line_revenue) AS total_revenue,
      SUM(li.cogs_total)   AS total_cogs,
      SUM(li.gross_profit) AS total_gross,
      COUNT(DISTINCT o.shopify_id) AS total_orders
    FROM order_line_items li
    JOIN shopify_orders o ON o.shopify_id = li.shopify_order_id
    WHERE o.created_at >= ? AND o.created_at <= ?
      AND o.financial_status != 'refunded'
      AND ${pf.clause}
  `).get(fromUtc, toUtc, ...pfArgs);

  const totalMetaSpend = db.prepare(`
    SELECT SUM(spend) AS total FROM meta_spend
    WHERE date >= ? AND date <= ?
      AND ${mf.clause}
  `).get(from, to, ...mf.params);

  // currency breakdown (fees)
  const currencyBreakdown = db.prepare(`
    SELECT o.presentment_currency,
           COUNT(*) AS orders,
           SUM(li.line_revenue) AS revenue,
           SUM(li.cogs_total)   AS cogs
    FROM order_line_items li
    JOIN shopify_orders o ON o.shopify_id = li.shopify_order_id
    WHERE o.created_at >= ? AND o.created_at <= ?
      AND ${pf.clause}
    GROUP BY o.presentment_currency
    ORDER BY revenue DESC
  `).all(fromUtc, toUtc, ...pfArgs);

  // Regional fee rates based on presentment currency
  // USA (USD):        Shopify Payments 3.4%+$0.21  + payout 1.5%
  // Canada (CAD):     Shopify Payments 2.6%+$0.21  + conversion 2.0% + payout 1.5%
  // Europe (GBP/EUR/DKK/NOK/SEK/CZK/HUF etc): Shopify Payments 3.4%+$0.22 + conversion 2.0% + payout 1.5%
  // Australia/NZ (AUD/NZD): Shopify Payments 3.4%+$0.21 + conversion 2.0% + payout 1.5%
  const CAD_CURRENCIES = new Set(['CAD']);
  const AUS_CURRENCIES = new Set(['AUD', 'NZD']);
  const EU_CURRENCIES  = new Set(['GBP','EUR','DKK','NOK','SEK','CZK','HUF','PLN','RON','HRK','BGN','CHF','ISK','ALL','BAM','RSD','MKD']);

  let processingTotal = 0;
  let conversionTotal = 0;
  for (const row of currencyBreakdown) {
    const cur = (row.presentment_currency || 'USD').toUpperCase();
    const rev = row.revenue || 0;
    const ord = row.orders  || 0;
    if (CAD_CURRENCIES.has(cur)) {
      processingTotal += rev * 0.026 + ord * 0.21;
      conversionTotal += rev * 0.035;
    } else if (AUS_CURRENCIES.has(cur)) {
      processingTotal += rev * 0.034 + ord * 0.21;
      conversionTotal += rev * 0.035;
    } else if (EU_CURRENCIES.has(cur)) {
      processingTotal += rev * 0.034 + ord * 0.22;
      conversionTotal += rev * 0.035;
    } else {
      // USD and anything else: USA rates, no conversion fee
      processingTotal += rev * 0.034 + ord * 0.21;
      conversionTotal += rev * 0.015;
    }
  }

  const shopifyFees = {
    processing:          Math.round(processingTotal * 100) / 100,
    currency_conversion: Math.round(conversionTotal * 100) / 100,
  };
  shopifyFees.total = shopifyFees.processing + shopifyFees.currency_conversion;

  res.json({
    period: { from, to },
    totals: {
      revenue:      totals?.total_revenue  || 0,
      cogs:         totals?.total_cogs     || 0,
      gross:        totals?.total_gross    || 0,
      orders:       totals?.total_orders   || 0,
      meta_spend:   (totalMetaSpend?.total || 0) * metaCurrencyRate,
      shopify_fees: shopifyFees,
      net_profit:   (totals?.total_gross || 0) - ((totalMetaSpend?.total || 0) * metaCurrencyRate) - shopifyFees.total,
    },
    by_product:  revenueByProduct,
    by_variant:  revenueByVariant,
    meta_spend:  metaSpend,
    currency_breakdown: currencyBreakdown,
  });
});

// GET /api/orders?limit=100&product=Amino
app.get('/api/orders', (req, res) => {
  const limit   = parseInt(req.query.limit) || 100;
  const product = req.query.product || '';
  const rows = db.prepare(`
    SELECT o.order_number, o.created_at, o.financial_status, o.presentment_currency,
           li.product_name, li.variant_title, li.quantity, li.price,
           li.line_revenue, li.cogs_per_pack, li.cogs_total, li.gross_profit
    FROM order_line_items li
    JOIN shopify_orders o ON o.shopify_id = li.shopify_order_id
    WHERE (? = '' OR li.product_name LIKE '%' || ? || '%')
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(product, product, limit);
  res.json(rows);
});

// GET /api/last-sync
app.get('/api/last-sync', (req, res) => {
  const shopify = db.prepare(`SELECT ran_at, status FROM sync_log WHERE source='shopify' ORDER BY ran_at DESC LIMIT 1`).get();
  const meta    = db.prepare(`SELECT ran_at, status FROM sync_log WHERE source='meta' ORDER BY ran_at DESC LIMIT 1`).get();
  res.json({ shopify, meta });
});

// ─────────────────────────────────────────────────────────────
//  SHARED STATE (multi-user P&L sync)
// ─────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const row = db.prepare('SELECT state_json, updated_at FROM pnl_state WHERE id = 1').get();
  if (!row) return res.json(null);
  res.json({ state: JSON.parse(row.state_json), updated_at: row.updated_at });
});

app.post('/api/state', (req, res) => {
  const json = JSON.stringify(req.body);
  db.prepare('INSERT OR REPLACE INTO pnl_state (id, state_json, updated_at) VALUES (1, ?, datetime(\'now\'))').run(json);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
//  SHOPIFY OAUTH — captures access token on app install
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// Step 1: redirect merchant to Shopify OAuth consent screen
app.get('/auth', (req, res) => {
  const shop    = req.query.shop || process.env.SHOPIFY_SHOP_DOMAIN;
  const apiKey  = process.env.SHOPIFY_API_KEY;
  const scopes  = 'read_orders,read_products';
  const redirect = `http://localhost:${process.env.PORT || 3001}/auth/callback`;
  const state   = crypto.randomBytes(16).toString('hex');
  const url = `https://${shop}/admin/oauth/authorize?client_id=${apiKey}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  res.redirect(url);
});

// Step 2: Shopify sends back the code; we exchange it for a permanent token
app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  const apiKey    = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error('No access_token in response');

    // Write token into .env
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('SHOPIFY_ACCESS_TOKEN=')) {
      envContent = envContent.replace(/SHOPIFY_ACCESS_TOKEN=.*/, `SHOPIFY_ACCESS_TOKEN=${access_token}`);
    } else {
      envContent += `\nSHOPIFY_ACCESS_TOKEN=${access_token}`;
    }
    fs.writeFileSync(envPath, envContent);
    process.env.SHOPIFY_ACCESS_TOKEN = access_token;

    console.log(`\n✓ Shopify access token saved! Token starts with: ${access_token.slice(0,12)}...\n`);
    res.send(`<h2 style="font-family:sans-serif;color:green">✓ Token saved! Close this tab and restart the server.</h2><p>Token: <code>${access_token.slice(0,12)}...</code></p>`);
  } catch (err) {
    console.error('[OAuth] Error:', err.message);
    res.status(500).send(`<h2 style="color:red">Error: ${err.message}</h2>`);
  }
});

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✓ PnL server running on http://localhost:${PORT}`);
  console.log('  Shopify sync: every hour');
  console.log('  Meta sync:    daily at 6am\n');
});
