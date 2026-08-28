import pg from 'pg';

const { Pool } = pg;

const DB_URL = process.env.DATABASE_URL || '';

// Rede interna do Railway (postgres.railway.internal) e localhost = sem SSL.
// URL pública / provedor externo normalmente traz sslmode=require.
const wantSSL =
  process.env.DATABASE_SSL === 'true' ||
  /sslmode=require/.test(DB_URL) ||
  /[?&]ssl=true/.test(DB_URL);

export const pool = new Pool({
  connectionString: DB_URL,
  ssl: wantSSL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ evt: 'pg_pool_error', msg: err.message }));
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      kit             TEXT NOT NULL,
      amount          INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'created',
      pinpay_id       TEXT UNIQUE,
      customer_name   TEXT NOT NULL,
      customer_email  TEXT NOT NULL,
      customer_cpf    TEXT NOT NULL,
      customer_phone  TEXT NOT NULL,
      ship_cep        TEXT NOT NULL,
      ship_street     TEXT NOT NULL,
      ship_number     TEXT NOT NULL,
      ship_complement TEXT,
      ship_district   TEXT NOT NULL,
      ship_city       TEXT NOT NULL,
      ship_state      TEXT NOT NULL,
      qr_code         TEXT,
      qr_code_url     TEXT,
      expires_at      TIMESTAMPTZ,
      paid_at         TIMESTAMPTZ,
      e2e_id          TEXT,
      payer_name      TEXT,
      payer_document  TEXT,
      payer_bank      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS orders_pinpay_id_idx ON orders (pinpay_id);
    CREATE INDEX IF NOT EXISTS orders_status_idx    ON orders (status);

    CREATE TABLE IF NOT EXISTS processed_webhooks (
      dedupe_key  TEXT PRIMARY KEY,
      event       TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function createOrder(o) {
  await pool.query(
    `INSERT INTO orders (
       id, kit, amount, status,
       customer_name, customer_email, customer_cpf, customer_phone,
       ship_cep, ship_street, ship_number, ship_complement, ship_district, ship_city, ship_state
     ) VALUES ($1,$2,$3,'created',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      o.id, o.kit, o.amount,
      o.name, o.email, o.cpf, o.phone,
      o.cep, o.street, o.number, o.complement || null, o.district, o.city, o.state,
    ],
  );
}

export async function attachPix(orderId, pix) {
  await pool.query(
    `UPDATE orders
        SET pinpay_id = $2, qr_code = $3, qr_code_url = $4,
            expires_at = $5, status = 'awaiting_payment', updated_at = now()
      WHERE id = $1`,
    [orderId, pix.id, pix.qr_code || null, pix.qr_code_url || null, pix.expires_at || null],
  );
}

export async function setStatusById(orderId, status) {
  await pool.query(
    `UPDATE orders SET status = $2, updated_at = now()
      WHERE id = $1 AND status <> 'paid'`,
    [orderId, status],
  );
}

export async function getOrderPublic(id) {
  const { rows } = await pool.query(
    `SELECT id, kit, amount, status, qr_code, qr_code_url, expires_at, paid_at
       FROM orders WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

// --- webhook side (correlaciona pelo pinpay_id / data.transaction_id) ---

// Retorna o nº de linhas afetadas. 0 = pedido ainda não tem esse pinpay_id
// (corrida rara: webhook antes do attachPix) -> o handler deve pedir retry.
export async function markPaidByPinpayId(pinpayId, info = {}) {
  const r = await pool.query(
    `UPDATE orders SET
        status = 'paid',
        paid_at = COALESCE(paid_at, now()),
        e2e_id = COALESCE($2, e2e_id),
        payer_name = COALESCE($3, payer_name),
        payer_document = COALESCE($4, payer_document),
        payer_bank = COALESCE($5, payer_bank),
        updated_at = now()
      WHERE pinpay_id = $1`,
    [pinpayId, info.e2e_id || null, info.payer_name || null, info.payer_document || null, info.payer_bank || null],
  );
  return r.rowCount;
}

export async function setStatusByPinpayId(pinpayId, status) {
  await pool.query(
    `UPDATE orders SET status = $2, updated_at = now()
      WHERE pinpay_id = $1 AND status <> 'paid'`,
    [pinpayId, status],
  );
}

// Reivindica o evento de forma atômica.
//   true  = primeira vez -> processe
//   false = já reivindicado -> ignore (200)
// Se o processamento falhar, chame releaseWebhook() para permitir o retry.
export async function claimWebhook(dedupeKey, event) {
  const { rows } = await pool.query(
    `INSERT INTO processed_webhooks (dedupe_key, event)
     VALUES ($1, $2)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    [dedupeKey, event],
  );
  return rows.length > 0;
}

export async function releaseWebhook(dedupeKey) {
  await pool.query(`DELETE FROM processed_webhooks WHERE dedupe_key = $1`, [dedupeKey]);
}
