// Bloom Push Notification Backend
// Receives forwarded bank emails via Zapier/Make webhook
// Parses transaction data and sends Web Push to your phone

const webpush = require('web-push');

// VAPID keys — set these as Vercel environment variables
webpush.setVapidDetails(
  'mailto:' + process.env.CONTACT_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Email parsers ─────────────────────────────────────────────

function parseLendingClub(subject, body) {
  if (!subject.includes('LendingClub') || !subject.includes('Transaction Alert')) return null;

  // Amount: "$22.61"
  const amountMatch = body.match(/Amount:\s*\$?([\d,]+\.?\d*)/i);
  // Transaction: "TST*RISE AND GRIND DBT PURCHASE ON..."
  const txnMatch = body.match(/Transaction:\s*([^\n•\r]+)/i);
  // Account: "******8656"
  const accMatch = body.match(/Account:\s*([\*\d]+)/i);

  if (!amountMatch) return null;

  const rawMerchant = txnMatch ? txnMatch[1].trim() : 'Unknown';
  // Clean up merchant — remove "DBT PURCHASE ON MM/DD @ HH:MM address" suffix
  const merchant = rawMerchant
    .replace(/\s*(DBT|POS|ACH|CHK)\s*PURCHASE.*/i, '')
    .replace(/TST\*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const amount = parseFloat(amountMatch[1].replace(',', ''));
  const isDeposit = body.match(/deposit/i) && !body.match(/debit|purchase|withdrawal/i);

  return {
    bank: 'LendingClub',
    account: 'lc',
    merchant: merchant || 'LendingClub',
    amount: isDeposit ? amount : -amount,
    amountDisplay: `$${amount.toFixed(2)}`,
  };
}

function parseServiceCU(subject, body) {
  if (!subject.includes('Service Credit Union')) return null;

  // Amount appears at end of transaction line: "Deposit Transfer from Jessa SAVINGS    $1.00"
  const amountMatch = body.match(/\$([\d,]+\.?\d*)\s*$/m);
  // Transaction description is bold/prominent line before the amount
  const txnMatch = body.match(/(?:APR|JAN|FEB|MAR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\n\s*\d+\s*\n\s*\d+\s*\n([^\n$]+)\s+\$/im)
    || body.match(/\d{4}\s*\n([^\n$]{3,60})\s+\$[\d.]+/m);

  // Fallback: just grab any line with a dollar amount
  const lineMatch = body.match(/([A-Za-z][^\n]{5,50})\s+\$([\d,]+\.?\d*)/m);

  if (!amountMatch && !lineMatch) return null;

  const amount = parseFloat((amountMatch || lineMatch)[1].replace(',', ''));
  const rawMerchant = txnMatch ? txnMatch[1].trim()
    : lineMatch ? lineMatch[1].trim()
    : 'Service CU Transaction';

  const merchant = rawMerchant.replace(/\s+/g, ' ').trim();
  const isDeposit = /deposit|transfer from|credit/i.test(merchant);
  const isWithdrawal = /withdrawal|purchase|payment|debit/i.test(merchant);

  return {
    bank: 'Service CU',
    account: 'scu',
    merchant,
    amount: isDeposit ? amount : -amount,
    amountDisplay: `$${amount.toFixed(2)}`,
  };
}

function parseEmail(subject, body) {
  return parseLendingClub(subject, body) || parseServiceCU(subject, body);
}

// ── Suggest budget category from merchant name ────────────────
function suggestCategory(merchant) {
  const m = merchant.toLowerCase();
  if (/grind|coffee|dunkin|starbucks|cafe/.test(m)) return 'dine';
  if (/grocery|market|whole foods|trader|shaw|stop.shop|hannaford/.test(m)) return 'groc';
  if (/gas|shell|mobil|exxon|bp|sunoco|chevron/.test(m)) return '';
  if (/amazon|target|walmart|costco/.test(m)) return 'groc';
  if (/restaurant|pizza|taco|burger|mcdonald|wendy|chick|subway/.test(m)) return 'dine';
  if (/paycheck|direct dep|payroll|terrapower|x.energy/.test(m)) return 'xe';
  if (/mortgage/.test(m)) return 'mort';
  if (/avant/.test(m)) return 'p_av';
  if (/sofi/.test(m)) return 'p_sf';
  if (/upstart/.test(m)) return 'p_up';
  if (/upgrade/.test(m)) return 'p_ug';
  if (/best egg/.test(m)) return 'p_be';
  if (/affirm/.test(m)) return 'p_af';
  if (/barclay/.test(m)) return 'p_ba';
  if (/amex|american express/.test(m)) return 'p_ax';
  if (/citi aa/.test(m)) return 'p_ca';
  if (/citi/.test(m)) return 'p_ci';
  if (/google fi|t-mobile|verizon|at.t/.test(m)) return 'gfi';
  if (/netflix/.test(m)) return 'net';
  if (/hulu/.test(m)) return 'hulu';
  if (/youtube/.test(m)) return 'yt';
  if (/gym|lfod|fitness/.test(m)) return 'gym';
  if (/dance/.test(m)) return 'dance';
  return '';
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow CORS for subscription registration from Bloom
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET /api/notify?vapidKey=true — return public VAPID key to Bloom
  if (req.method === 'GET' && req.query.vapidKey) {
    return res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  }

  // POST /api/notify with { type: 'subscribe', subscription: {...} }
  // Bloom sends its push subscription here to be stored
  if (req.method === 'POST' && req.body?.type === 'subscribe') {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'No subscription' });
    // Store in Vercel KV or just use an env var for single-user setup
    // For simplicity, we use a global store (works for single user)
    process.env.PUSH_SUBSCRIPTION = JSON.stringify(subscription);
    // Also try Vercel KV if available
    try {
      const { kv } = await import('@vercel/kv');
      await kv.set('bloom_subscription', JSON.stringify(subscription));
    } catch {}
    return res.json({ ok: true });
  }

  // POST /api/notify with email webhook from Zapier/Make
  if (req.method === 'POST') {
    const { subject, body, from } = req.body || {};

    if (!subject && !body) {
      return res.status(400).json({ error: 'Missing subject or body' });
    }

    const txn = parseEmail(subject || '', body || '');
    if (!txn) {
      return res.status(200).json({ ok: false, message: 'Email not recognized as a bank transaction' });
    }

    const catId = suggestCategory(txn.merchant);
    const isDeposit = txn.amount > 0;
    const emoji = isDeposit ? '💰' : '💳';
    const sign = isDeposit ? '+' : '-';

    const pushPayload = {
      title: `${emoji} ${sign}${txn.amountDisplay} — ${txn.bank}`,
      body: `${txn.merchant} · Tap to log in Bloom`,
      amount: String(txn.amount),
      merchant: txn.merchant,
      account: txn.account,
      catId,
    };

    // Retrieve stored subscription
    let subscription;
    try {
      const { kv } = await import('@vercel/kv');
      const stored = await kv.get('bloom_subscription');
      subscription = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch {
      subscription = process.env.PUSH_SUBSCRIPTION
        ? JSON.parse(process.env.PUSH_SUBSCRIPTION)
        : null;
    }

    if (!subscription) {
      return res.status(400).json({ error: 'No push subscription registered. Open Bloom and enable notifications first.' });
    }

    try {
      await webpush.sendNotification(subscription, JSON.stringify(pushPayload));
      return res.json({ ok: true, txn });
    } catch (err) {
      console.error('Push failed:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
