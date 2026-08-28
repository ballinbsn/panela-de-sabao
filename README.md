# naturalli-checkout

Backend de checkout PIX (PinPay) para a landing page das panelas de pedra sabão.

- **A landing page continua no host atual.** Este serviço só roda a **API** e as **páginas de checkout**.
- Deploy: **Railway** (Node + Postgres). Código: **GitHub**.
- Fluxo: `LP → /checkout?kit=kitX → /api/pay → PinPay /pix → QR → webhook → banco`.

## Estrutura

```
src/
  server.js       rotas Express (checkout, /api/pay, /api/order/:id, webhook)
  kits.js         preços e nomes dos kits — FONTE DA VERDADE (nunca confia no browser)
  validation.js   CPF, e-mail, telefone, CEP, UF
  pinpay.js       cliente da API PinPay + verificação HMAC do webhook
  db.js           Postgres: schema, orders, dedupe de webhook
public/
  checkout.html   página de checkout (form + QR + polling), sem dependências
```

## Variáveis de ambiente (Railway → Variables)

| Var | O que é |
|---|---|
| `PINPAY_SECRET_KEY` | `sk_live_…` — chave secreta. **Nunca** no Git / frontend. |
| `PINPAY_WEBHOOK_SECRET` | `whsec_…` — Signing Secret do webhook (painel PinPay → Webhooks). |
| `PINPAY_WEBHOOK_URL` | URL pública deste app + `/api/webhooks/pinpay`. |
| `DATABASE_URL` | injetada automaticamente pelo plugin PostgreSQL do Railway. |
| `SUCCESS_REDIRECT_URL` | para onde mandar o cliente após pagar (ex: `https://sua-loja.com/obrigado`). Vazio = fica na tela de confirmação. |
| `STORE_ORIGIN` | domínio da sua loja, usado só no redirect de `GET /` (ex: `https://sua-loja.com`). Vazio = `GET /` responde texto simples. |

> **Domínio:** nada de domínio fica fixo no código. Rode em `*.up.railway.app`, num
> subdomínio próprio (`checkout.sua-loja.com`), ou onde quiser — basta ajustar
> `PINPAY_WEBHOOK_URL` (e re-cadastrar o webhook na PinPay) e os links da landing page.

## Deploy no Railway (passo a passo)

1. Suba esta pasta como repositório no **GitHub** (o `.gitignore` já exclui `.env` e `node_modules`).
2. No **Railway**: *New Project → Deploy from GitHub repo* → selecione o repo.
3. *New → Database → PostgreSQL*. O Railway cria `DATABASE_URL` e a injeta no serviço (confirme em *Variables → Shared*).
4. Em *Variables* do serviço Node, adicione `PINPAY_SECRET_KEY`, `PINPAY_WEBHOOK_SECRET`, `PINPAY_WEBHOOK_URL`, `SUCCESS_REDIRECT_URL`, `STORE_ORIGIN`.
5. Railway detecta Node (Nixpacks), roda `npm install` e `npm start`. O schema do banco é criado sozinho no boot (`initSchema`).
6. Pegue o domínio público (*Settings → Networking → Generate Domain*), ex: `naturalli-checkout-production.up.railway.app`.
7. Volte em `PINPAY_WEBHOOK_URL` e coloque `https://<esse-domínio>/api/webhooks/pinpay`. Redeploy.
8. No **painel da PinPay → Webhooks**, cadastre esse mesmo endpoint, assine os eventos
   `payment_approved`, `pix_received`, `payment_failed`, `payment_refunded`, e copie o
   **Signing Secret** (`whsec_…`) para `PINPAY_WEBHOOK_SECRET`. Redeploy.
9. Na **landing page**, troque os links dos kits para
   `https://<domínio-railway>/checkout?kit=kit5` (e `kit3`, `kit2`, `kit1`).

## Teste rápido (cURL)

Criar uma cobrança direto na PinPay (o que o `/api/pay` faz por baixo):

```bash
curl -sS -X POST https://api.usepinpay.com/functions/v1/api-v1/pix \
  -H "Authorization: Bearer $PINPAY_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "amount": 21990,
    "description": "Kit 5 Panelas + Brinde 7 Colheres",
    "customer": {
      "name": "João da Silva",
      "email": "joao@email.com",
      "document": { "type": "CPF", "number": "12345678909" },
      "phone": "11999999999"
    },
    "expires_in": 3600,
    "webhook_url": "https://SEU-APP.up.railway.app/api/webhooks/pinpay",
    "metadata": { "order_id": "teste-1" }
  }'
```

Testar o seu endpoint depois de subir:

```bash
curl -sS -X POST https://SEU-APP.up.railway.app/api/pay \
  -H "Content-Type: application/json" \
  -d '{
    "kit":"kit5",
    "name":"João da Silva","email":"joao@email.com",
    "cpf":"12345678909","phone":"11999999999",
    "cep":"01311000","street":"Av Paulista","number":"1000",
    "complement":"","district":"Bela Vista","city":"São Paulo","state":"SP"
  }'
```

Resposta de sucesso (`201`):

```json
{
  "order_id": "8b1c0d4e-9b3a-4d8a-9d2e-1f6b2c3a4b5c",
  "amount": 21990,
  "amount_brl": "R$ 219,90",
  "qr_code": "00020126580014br.gov.bcb.pix0136...",
  "qr_code_url": "https://api.usepinpay.com/qr/pix_abc123.png",
  "expires_at": "2026-08-27T21:00:00Z"
}
```

## Rodar local (opcional — precisa de Node 20.6+)

```bash
npm install
cp .env.example .env   # preencha as chaves e um DATABASE_URL de teste
npm run dev
```

## Segurança

- `sk_live_` e `whsec_` só em env var. O `.gitignore` bloqueia o `.env`.
- Webhook: valida HMAC-SHA256 (constant-time), é idempotente (`transaction_id:event`), responde 2xx em < 5s.
- Valor da cobrança vem **sempre** de `src/kits.js` no servidor; o browser manda só o id do kit.
- `POST /api/pay` tem rate limit por IP (12/min).

## Pendente (decidir depois)

Fulfillment no `payment_approved`: e-mail para o cliente + aviso de envio para você.
Hoje o pedido é marcado `paid` no banco e logado — falta plugar o disparo.
Ver `// TODO fulfillment` em `src/server.js`.
