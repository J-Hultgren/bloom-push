const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:' + process.env.CONTACT_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  return Redis.fromEnv();
}

function parseLendingClub(subject, body, from) {
  const isLC = subject.toLowerCase().includes('lendingclub') ||
               (from||'').toLowerCase().includes('lendingclub');
  if (!isLC) return null;
  const amountMatch = body.match(/Amount:\s*\$?([\d,]+\.?\d*)/i) || body.match(/\$([\d,]+\.\d{2})/);
  const txnMatch = body.match(/Transaction:\s*([^\n<\r]+)/i);
  if (!amountMatch) return null;
  const merchant = (txnMatch ? txnMatch[1] : 'LendingClub')
    .replace(/\s*(DBT|POS|ACH|CHK)\s*PURCHASE.*/i,'').replace(/TST\*/i,'').trim();
  const amount = parseFloat(amountMatch[1].replace(',',''));
  const isDeposit = /deposit/i.test(body) && !/debit|purchase|withdrawal/i.test(body);
  return { bank:'LendingClub', account:'lc', merchant: merchant||'LendingClub', amount: isDeposit?amount:-amount, amountDisplay:`$${amount.toFixed(2)}` };
}

function parseServiceCU(subject, body, from) {
  const isSCU = subject.toLowerCase().includes('service credit union') ||
                subject.toLowerCase().includes('service cu') ||
                (from||'').toLowerCase().includes('servicecu.org') ||
                body.toLowerCase().includes('service credit union');
  if (!isSCU) return null;

  // Clean HTML tags from body
  const clean = body.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

  // Match transaction line: "Deposit Transfer from Jessa SAVINGS $1.00"
  // or "Purchase at MERCHANT $22.61"
  const txnMatch = clean.match(/([A-Z][A-Za-z\s]+(?:Transfer|Purchase|Withdrawal|Payment|Deposit)[A-Za-z\s]*)\s+\$([\d,]+\.?\d*)/i) ||
                   clean.match(/((?:Deposit|Withdrawal|Purchase|Payment|Transfer)[A-Za-z\s,*]+)\s+\$([\d,]+\.?\d*)/i);

  const amountMatch = clean.match(/\$([\d,]+\.?\d*)/);
  if (!amountMatch && !txnMatch) return null;

  const amount = parseFloat((txnMatch ? txnMatch[2] : amountMatch[1]).replace(',',''));
  const merchant = txnMatch ? txnMatch[1].trim() : 'Service CU Transaction';
  const isDeposit = /deposit|transfer from|credit/i.test(merchant);

  return { bank:'Service CU', account:'scu', merchant: merchant.slice(0,60), amount: isDeposit?amount:-amount, amountDisplay:`$${amount.toFixed(2)}` };
}

function parseEmail(subject, body, from) {
  return parseLendingClub(subject, body, from) || parseServiceCU(subject, body, from);
}

function suggestCategory(merchant) {
  const m = (merchant||'').toLowerCase();
  if (/grind|coffee|dunkin|starbucks|cafe/.test(m)) return 'dine';
  if (/grocery|market|whole foods|trader|shaw|hannaford/.test(m)) return 'groc';
  if (/restaurant|pizza|taco|burger|mcdonald|subway/.test(m)) return 'dine';
  if (/mortgage/.test(m)) return 'mort';
  if (/avant/.test(m)) return 'p_av';
  if (/sofi/.test(m)) return 'p_sf';
  if (/upstart/.test(m)) return 'p_up';
  if (/upgrade/.test(m)) return 'p_ug';
  if (/best egg/.test(m)) return 'p_be';
  if (/affirm/.test(m)) return 'p_af';
  if (/barclay/.test(m)) return 'p_ba';
  if (/amex|american express/.test(m)) return 'p_ax';
  if (/google fi/.test(m)) return 'gfi';
  if (/netflix/.test(m)) return 'net';
  if (/hulu/.test(m)) return 'hulu';
  if (/youtube/.test(m)) return 'yt';
  if (/gym|lfod/.test(m)) return 'gym';
  if (/dance/.test(m)) return 'dance';
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query.vapidKey) {
    return res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  }

  if (req.method === 'POST' && req.body?.type === 'subscribe') {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'No subscription' });
    try {
      const redis = await getRedis();
      await redis.set('bloom_subscription', JSON.stringify(subscription));
      return res.json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: 'Storage error: ' + e.message });
    }
  }

  if (req.method === 'POST') {
    const { subject, body, from } = req.body || {};
    if (!subject && !body) return res.status(400).json({ error: 'Missing subject or body' });

    const txn = parseEmail(subject||'', body||'', from||'');
    if (!txn) return res.status(200).json({ ok:false, message:'Not a recognized bank email', subject });

    const pushPayload = {
      title: `${txn.amount>0?'💰':'💳'} ${txn.amount>0?'+':'-'}${txn.amountDisplay} — ${txn.bank}`,
      body: `${txn.merchant} · Tap to log in Bloom`,
      amount: String(txn.amount),
      merchant: txn.merchant,
      account: txn.account,
      catId: suggestCategory(txn.merchant),
    };

    let subscription;
    try {
      const redis = await getRedis();
      const stored = await redis.get('bloom_subscription');
      subscription = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch(e) {
      return res.status(500).json({ error: 'Storage error: ' + e.message });
    }

    if (!subscription) return res.status(400).json({ error: 'No push subscription registered.' });

    try {
      await webpush.sendNotification(subscription, JSON.stringify(pushPayload));
      return res.json({ ok: true, txn });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
