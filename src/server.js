import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getKit, formatBRL, kitView } from './kits.js';
import { validateCheckout } from './validation.js';
import { createPix, verifyWebhookSignature, PinPayError } from './pinpay.js';
import {
  pool, initSchema, createOrder, attachPix, setStatusById, getOrderPublic,
  markPaidByPinpayId, setStatusByPinpayId, claimWebhook, releaseWebhook,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Não derrubamos o processo se faltar env — assim o primeiro deploy sobe,
// o domínio é gerado e o /healthz responde enquanto você configura as vars.
// Cada rota falha de forma controlada se a sua config específica faltar.
const EXPECTED_ENV = ['PINPAY_SECRET_KEY', 'PINPAY_WEBHOOK_SECRET', 'PINPAY_WEBHOOK_URL', 'DATABASE_URL'];
const missingEnv = EXPECTED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.warn(JSON.stringify({ evt: 'env_missing', vars: missingEnv }));
}

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de proxy
app.disable('x-powered-by');

// cabeçalhos de segurança básicos
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// log estruturado, sem corpo (nunca logamos CPF/e-mail/sk_)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    console.log(JSON.stringify({
      evt: 'http', method: req.method, path: req.path,
      status: res.statusCode, ms: Date.now() - t0,
    }));
  });
  next();
});

// ---------- rate limit simples em memória (por IP) para /api/pay ----------
const hits = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'rate_limit' });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    const keep = arr.filter((t) => now - t < 60_000);
    if (keep.length) hits.set(k, keep); else hits.delete(k);
  }
}, 60_000).unref();

// ---------- páginas ----------
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// Diagnóstico temporário — sem segredos, só status. Remover depois.
app.get('/api/_diag', async (_req, res) => {
  const url = process.env.DATABASE_URL || '';
  const out = {
    database_url_present: !!url,
    database_url_resolved: /^postgres(ql)?:\/\//.test(url),
    database_url_starts: url.slice(0, 14),
    db: null,
    env: {
      pinpay_secret: !!process.env.PINPAY_SECRET_KEY && !process.env.PINPAY_SECRET_KEY.startsWith('PENDENTE'),
      webhook_secret: !!process.env.PINPAY_WEBHOOK_SECRET && !process.env.PINPAY_WEBHOOK_SECRET.startsWith('PENDENTE'),
      webhook_url: !!process.env.PINPAY_WEBHOOK_URL,
    },
  };
  try {
    const r = await pool.query('SELECT 1 AS ok');
    out.db = r.rows[0].ok === 1 ? 'ok' : 'unexpected';
  } catch (e) {
    out.db = String(e.message || e).replace(/:\/\/[^@\s]+@/, '://***@').slice(0, 240);
  }
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

app.get('/', (_req, res) => {
  if (process.env.STORE_ORIGIN) return res.redirect(302, process.env.STORE_ORIGIN);
  res.type('text').send('naturalli-checkout API — ok');
});

// GET /checkout?kit=kit5  -> página de checkout
app.get('/checkout', (req, res) => {
  const kit = getKit(String(req.query.kit || ''));
  if (!kit) {
    return process.env.STORE_ORIGIN
      ? res.redirect(302, process.env.STORE_ORIGIN)
      : res.status(404).type('text').send('kit inválido');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'checkout.html'));
});

// dados do kit para a página montar o resumo (sem expor nada sensível)
app.get('/api/kit/:id', (req, res) => {
  const kit = getKit(String(req.params.id || ''));
  if (!kit) return res.status(404).json({ error: 'not_found' });
  res.set('Cache-Control', 'public, max-age=300');
  res.json(kitView(kit));
});

app.use('/assets', express.static(PUBLIC_DIR, { maxAge: '1h' }));

// ---------- criar cobrança ----------
app.post('/api/pay', rateLimit({ windowMs: 60_000, max: 12 }), express.json({ limit: '32kb' }), async (req, res) => {
  const kit = getKit(String(req.body?.kit || ''));
  if (!kit) return res.status(400).json({ error: 'kit_invalid' });

  const { ok, value, errors } = validateCheckout(req.body, kit);
  if (!ok) return res.status(400).json({ error: 'validation_error', fields: errors });

  const orderId = randomUUID();
  const base = `${req.protocol}://${req.get('host')}`;
  const checkoutUrl = `${base}/checkout?kit=${kit.id}`;

  try {
    await createOrder({ ...value, id: orderId });
  } catch (e) {
    console.error(JSON.stringify({ evt: 'db_create_order_failed', orderId, msg: e.message }));
    return res.status(500).json({ error: 'internal' });
  }

  try {
    const pix = await createPix({
      amount: kit.amount, // valor SEMPRE do servidor
      description: kit.nome,
      customer: {
        name: value.name,
        email: value.email,
        document: { type: 'CPF', number: value.cpf },
        phone: value.phone,
      },
      orderId,
      webhookUrl: process.env.PINPAY_WEBHOOK_URL,
      checkoutUrl,
    });

    // A PinPay aninha os dados do PIX em `pix.pix`.
    const p = pix.pix || pix;
    const qrText = p.qr_code || p.qr_code_text || p.pix_code || p.copy_paste || p.brcode
      || p.emv || p.payload || p.qrcode || p.qr_code_payload || p.code || null;
    const qrImg = p.qr_code_url || p.qr_code_image || p.qrcode_image_url || p.qr_code_base64
      || p.image_url || p.qr_image || p.qr_code_base64_image || null;
    const expAt = p.expires_at || pix.expires_at || p.expiration_date || p.due_date || null;
    const ppId = pix.id || pix.transaction_id || p.id || null;

    await attachPix(orderId, { id: ppId, qr_code: qrText, qr_code_url: qrImg, expires_at: expAt });
    console.log(JSON.stringify({ evt: 'pix_created', orderId, pinpayId: ppId, kit: kit.id, amount: kit.amount }));

    return res.status(201).json({
      order_id: orderId,
      amount: kit.amount,
      amount_brl: formatBRL(kit.amount),
      qr_code: qrText,
      qr_code_url: qrImg,
      expires_at: expAt,
      _pp_debug: { top: Object.keys(pix || {}), pix_obj: pix.pix, status: pix.status }, // DEBUG. Remover depois.
    });
  } catch (e) {
    const info = e instanceof PinPayError
      ? { code: e.code, status: e.status, field: e.field, requestId: e.requestId }
      : { code: 'unknown', msg: String(e?.message || e) };
    console.error(JSON.stringify({ evt: 'pinpay_pix_failed', orderId, ...info }));
    await setStatusById(orderId, 'failed').catch(() => {});

    // DEBUG temporário: mostra o motivo da PinPay (sem segredos). Remover depois.
    const dbg = e instanceof PinPayError
      ? { pp_status: e.status, pp_code: e.code, pp_field: e.field, pp_message: e.message, pp_request_id: e.requestId, pp_payload: e.payload }
      : { js_error: String(e?.message || e) };
    if (e instanceof PinPayError && e.status === 422) {
      return res.status(422).json({ error: 'payment_declined', _debug: dbg });
    }
    return res.status(502).json({ error: 'gateway_error', _debug: dbg });
  }
});

// ---------- polling de status ----------
app.get('/api/order/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'bad_id' });
  const o = await getOrderPublic(id).catch(() => null);
  if (!o) return res.status(404).json({ error: 'not_found' });
  res.set('Cache-Control', 'no-store');
  res.json({
    order_id: o.id,
    status: o.status,          // created | awaiting_payment | paid | failed | expired | refunded
    amount: o.amount,
    qr_code: o.qr_code,
    qr_code_url: o.qr_code_url,
    expires_at: o.expires_at,
    paid: o.status === 'paid',
    redirect_url: o.status === 'paid' ? (process.env.SUCCESS_REDIRECT_URL || null) : null,
  });
});

// ---------- webhook PinPay ----------
// express.raw ANTES de qualquer parser JSON: precisamos dos bytes exatos p/ o HMAC.
app.post('/api/webhooks/pinpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  if (!verifyWebhookSignature(req.body, sig, process.env.PINPAY_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).end();
  }

  const event = payload?.event;
  const data = payload?.data || {};
  const txId = data.transaction_id; // == id retornado no POST /pix

  // payment_pending não traz transaction_id — nada a fazer (pedido já é awaiting_payment)
  if (!txId || !event) return res.status(200).end();

  const dedupeKey = `${txId}:${event}`;

  let fresh;
  try {
    fresh = await claimWebhook(dedupeKey, event);
  } catch (e) {
    console.error(JSON.stringify({ evt: 'webhook_claim_error', msg: e.message }));
    return res.status(500).end(); // erro nosso -> PinPay retenta
  }
  if (!fresh) return res.status(200).end(); // duplicado

  try {
    switch (event) {
      case 'payment_approved':
      case 'pix_received': {
        const rows = await markPaidByPinpayId(txId, {
          e2e_id: data.end_to_end_id,
          payer_name: data.payer_name,
          payer_document: data.payer_document,
          payer_bank: data.payer_bank,
        });
        if (rows === 0) {
          // pedido ainda não gravou o pinpay_id — libera e deixa a PinPay retentar
          console.error(JSON.stringify({ evt: 'paid_but_order_not_found', pinpayId: txId }));
          await releaseWebhook(dedupeKey).catch(() => {});
          return res.status(500).end();
        }
        console.log(JSON.stringify({ evt: 'order_paid', pinpayId: txId, via: event }));
        // TODO fulfillment (e-mail p/ cliente + aviso de envio) — definir depois
        break;
      }

      case 'payment_failed': {
        const s = data.status === 'expired' ? 'expired'
          : data.status === 'cancelled' ? 'cancelled'
          : 'failed';
        await setStatusByPinpayId(txId, s);
        console.log(JSON.stringify({ evt: 'order_failed', pinpayId: txId, status: s }));
        break;
      }

      case 'payment_refunded':
        await setStatusByPinpayId(txId, 'refunded');
        console.log(JSON.stringify({ evt: 'order_refunded', pinpayId: txId }));
        break;

      default:
        // evento que não tratamos: ok, 200 pra não gerar retry
        break;
    }
  } catch (e) {
    console.error(JSON.stringify({ evt: 'webhook_handler_error', event, pinpayId: txId, msg: e.message }));
    await releaseWebhook(dedupeKey).catch(() => {}); // libera p/ retry da PinPay
    return res.status(500).end();
  }

  res.status(200).end();
});

// 404 padrão
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const PORT = process.env.PORT || 3000;

async function ensureSchema() {
  if (!process.env.DATABASE_URL) {
    console.warn(JSON.stringify({ evt: 'schema_skipped', reason: 'no DATABASE_URL' }));
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await initSchema();
      console.log(JSON.stringify({ evt: 'schema_ready' }));
      return;
    } catch (e) {
      console.error(JSON.stringify({ evt: 'schema_attempt_failed', attempt, msg: e.message }));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.error(JSON.stringify({ evt: 'schema_failed', note: 'app segue no ar; /api/pay falha até o banco responder' }));
}

// Sobe o servidor de qualquer jeito (domínio + /healthz), tenta o schema em paralelo.
app.listen(PORT, () => console.log(JSON.stringify({ evt: 'listening', port: Number(PORT) })));
ensureSchema();
