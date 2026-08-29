import crypto from 'node:crypto';

const BASE_URL = 'https://api.usepinpay.com/functions/v1/api-v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PinPayError extends Error {
  constructor(code, status, payload = {}) {
    // A PinPay responde { error: { code, message } } (aninhado) ou { error, message } (plano).
    const nested = payload.error && typeof payload.error === 'object' ? payload.error : null;
    const realCode = code || nested?.code || payload.error || 'pinpay_error';
    const realMsg = nested?.message || payload.message || realCode;
    super(realMsg);
    this.name = 'PinPayError';
    this.code = typeof realCode === 'string' ? realCode : 'pinpay_error';
    this.status = status;
    this.field = nested?.field || payload.field;
    this.requestId = payload.request_id || nested?.request_id;
    this.payload = payload;
  }
}

/**
 * Cria uma cobrança PIX. Retenta em rede/429/5xx com a MESMA
 * Idempotency-Key (= orderId), então nunca cobra duas vezes.
 */
export async function createPix({ amount, description, customer, orderId, webhookUrl }) {
  const body = JSON.stringify({
    amount,
    description,
    customer,
    expires_in: 3600,
    webhook_url: webhookUrl,
    // external_reference é obrigatório: id do pedido no nosso sistema.
    metadata: { external_reference: orderId, order_id: orderId },
  });

  const headers = {
    Authorization: `Bearer ${process.env.PINPAY_SECRET_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': orderId, // 1 pedido = 1 cobrança, mesmo em retry
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/pix`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      lastError = new PinPayError('network_error', 0, { message: String(e?.message || e) });
      if (attempt < 3) { await sleep(400 * attempt); continue; }
      throw lastError;
    }

    if (res.ok) return res.json();

    const payload = await res.json().catch(() => ({}));

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after')) || attempt;
      await sleep(retryAfter * 1000);
      lastError = new PinPayError(payload.error, res.status, payload);
      continue;
    }

    throw new PinPayError(payload.error, res.status, payload);
  }
  throw lastError;
}

export async function getPix(pixId) {
  const res = await fetch(`${BASE_URL}/pix/${encodeURIComponent(pixId)}`, {
    headers: { Authorization: `Bearer ${process.env.PINPAY_SECRET_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new PinPayError(payload.error, res.status, payload);
  }
  return res.json();
}

/** Valida a assinatura HMAC-SHA256 do webhook (header X-Webhook-Signature). */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !secret) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (signatureHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}
