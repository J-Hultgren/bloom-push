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

function parseLendingClub(subject, body) {
  if (!subject.toLowerCase().includes('lendingclub') && !subject.toLowerCase().includes('transaction alert')) return null;
  const amountMatch = body.match(/Amount:\s*\$?([\d,]+\.?\d*)/i) || body.match(/\$([\d,]+\.\d{2})/);
  const txnMatch = body.match(/Transaction:\s*([^\n<\r]+)/i);
  if (!amountMatch) return null;
  const merchant = (txnMatch ? txnMatch[1] : 'LendingClub').replace(/\s*(DBT|POS|ACH|CHK)\s*PURCHASE.*/i,'').replace(/TST\*/i,'').trim();
  const amount = parseFloat(amountMatch[1].replace(',',''));
  const isDeposit = /deposit/i.test(body) && !/debit|purchase|withdrawal/i.test(body);
  return { bank:'LendingClub', account:'lc', merchant: merchant||'LendingClub', amount: isDeposit?amount:-amount, amountDisplay:`$${amount.toFixed(2)}` };
}

function parseServiceCU(subject, body) {
  if (!subject.toLowerCase().includes('service credit union') && !subject.toLowerCase().includes('service cu')) return null;
  const lineMatch = body.match(/([A-Za-z][^\n$]{5,50})\s+\$([\d,]+\.?\d*)/m);
  const amountMatch = body.match(/\$([\d,]+\.?\d*)/);
  if (!amountMatch && !lineMatch) return null;
  const amount = parseFloat((lineMatch?lineMatch[2]:amountMatch[1]).replace(',',''));
  const merchant = lineMatch ? lineMatch[1].trim() : 'Service CU Transaction';
  const isDeposit = /deposit|transfer from|credit/i.test(merchant);
  return { bank:'Service CU', account:'scu', merchant, amount: isDeposit?amount:-amount, amountDisplay:`$${amount.toFixed(2)}` };
}

function parseEmail(subject, body) {
  return parseLendingClub(subject, body) || parseServiceCU(subject, body);
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
    const cleanBody = (body||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const txn = parseEmail(subject||'', cleanBody);
    if (!txn) return res.status(200).json({ ok:false, message:'Not a bank email', subject, preview:cleanBody.slice(0,200) });

    const pushPayload = {
      title: `${txn.amount>0?'💰':'💳'} ${txn.amount>0?'+':'-'}${txn.amountDisplay} — ${txn.bank}`,
      body: `${txn.merchant} · Tap to log in Bloom`,
      amount: String(txn.amount), merchant: txn.merchant,
      account: txn.account, catId: suggestCategory(txn.merchant),
    };

    let subscription;
    try {
      const redis = await getRedis();
      const stored = await redis.get('bloom_subscription');
      subscription = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch(e) {
      return res.status(500).json({ error: 'Storage error: ' + e.message });
    }

    if (!subscription) return res.status(400).json({ error: 'No push subscription registered. Open Bloom and enable notifications first.' });

    try {
      await webpush.sendNotification(subscription, JSON.stringify(pushPayload));
      return res.json({ ok: true, txn });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
