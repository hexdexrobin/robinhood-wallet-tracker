# Robinhood Chain Wallet Tracker

Node.js bot that tracks wallets on **Robinhood Chain** (EVM L2):

| Network | Chain ID |
|---------|----------|
| Mainnet | **4663** |
| Testnet | **46630** |

This project targets **mainnet (4663)** via Alchemy + ethers.js v6.

## What it does

1. **`POST /add-wallet`** — start tracking an address.
2. On add: fetch and log the wallet’s **last outgoing transfer** (`getAssetTransfers`: external, erc20, internal, descending, max 1).
3. Register the address on an Alchemy **ADDRESS_ACTIVITY** webhook (create if needed, else append).
4. On each activity event: check the **sender ETH balance** (`provider.getBalance`). Empty = **&lt; 0.001 ETH**.
5. If empty: scan the last **10 outgoing external** txs. For each hash, load the receipt:
   - `receipt.contractAddress` set → **token/contract deploy**
   - `receipt.to` is an **EOA** (`getCode` → `0x`) and asset is ETH → **new wallet**
6. Auto-add detected new wallets **recursively**.

If ADDRESS_ACTIVITY is not available for Robinhood mainnet, the bot **falls back to polling** `getAssetTransfers` every **15 seconds**.

## Stack

- **Express** — `POST /add-wallet`, `GET /wallets`, `POST /webhook`
- **Alchemy SDK** — transfers + Notify webhooks (`Network.ROBINHOOD_MAINNET` when present, else `robinhood-mainnet`)
- **ethers.js v6** — `JsonRpcProvider`, `formatEther`, `getBalance`, receipts, `getCode`
- **In-memory storage** — `Set` of wallets + webhook id (see comment in `index.js` for Redis/Postgres)

## Setup

### 1. Install

```bash
cd robinhood-wallet-tracker
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|----------|-------------|
| `ALCHEMY_API_KEY` | API key from your Alchemy Robinhood app |
| `ALCHEMY_AUTH_TOKEN` | Notify auth token (Alchemy Dashboard → Notify) |
| `WEBHOOK_URL` | Public HTTPS URL pointing at `/webhook` (ngrok URL in local dev) |
| `PORT` | Server port (default `3000`) |

RPC used by the bot:

```text
https://robinhood-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}
```

### 3. Start the server

```bash
npm start
```

## Expose the webhook locally with ngrok

Alchemy must reach your machine over HTTPS.

```bash
# terminal 1
npm start

# terminal 2
ngrok http 3000
```

Copy the ngrok HTTPS URL and set:

```env
WEBHOOK_URL=https://<your-subdomain>.ngrok-free.app/webhook
```

Restart the bot so it uses the new URL when creating/updating the Alchemy webhook.

> Tip: free ngrok URLs change on restart — update `.env` and re-add a wallet (or recreate the webhook) after each ngrok session.

## API usage

### Add a wallet (CLI)

With the bot running (`npm start` in another terminal):

```bash
# one wallet
npm run add -- 0xYourWalletAddressHere

# several wallets
npm run add -- 0xAAA... 0xBBB...

# list tracked wallets
npm run wallets
```

Or with curl:

```bash
curl -X POST http://localhost:3000/add-wallet \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYourWalletAddressHere"}'
```

Example success response:

```json
{
  "ok": true,
  "address": "0x...",
  "alreadyTracked": false,
  "trackedCount": 1,
  "webhookId": "wh_...",
  "mode": "webhook"
}
```

`mode` is `"polling"` if ADDRESS_ACTIVITY registration failed and the 15s poller is active.

### List tracked wallets

```bash
curl http://localhost:3000/wallets
```

### Webhook receiver (Alchemy → bot)

```bash
# Alchemy POSTs here automatically; manual smoke test:
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":{"activity":[]}}'
```

The route **always responds `200` immediately**, then runs balance/detection logic asynchronously.

### Health

```bash
curl http://localhost:3000/health
```

## Log prefixes

| Prefix | Meaning |
|--------|---------|
| `[TRACKER]` | Wallet add, last transfer, webhook setup |
| `[WEBHOOK]` | Incoming Notify events |
| `[BALANCE]` | ETH balance checks |
| `[DETECT]` | Empty-wallet scan of recent txs |
| `[NEW WALLET]` | Detected EOA recipient + auto-add |
| `[TOKEN DEPLOY]` | Contract creation from empty wallet |
| `[POLLING]` | 15s fallback mode |

## Project layout

```text
robinhood-wallet-tracker/
├── index.js        # entire bot (single file)
├── package.json
├── .env.example
└── README.md
```

## Production notes

- Replace the in-memory `trackedWallets` `Set` and `addressActivityWebhookId` with **Redis** or **Postgres** (search for `PRODUCTION STORAGE` in `index.js`).
- Keep `WEBHOOK_URL` on a stable public host (not a disposable ngrok URL).
- Protect `/webhook` if you expose it publicly (Alchemy signing secret verification is a good next step).
- ethers.js **v6 only** (`ethers.formatEther`, `ethers.JsonRpcProvider`).

## License

MIT


## Telegram

Set in `.env`:

```env
TELEGRAM_BOT_TOKEN=from_BotFather
TELEGRAM_CHAT_ID=your_chat_id
```

Commands in the bot chat:

| Command | Action |
|---------|--------|
| `/add 0x...` | Track a wallet |
| `/wallets` | List tracked wallets |
| `/alerts` | Recent transfer/token alerts |
| `/help` | Help |

Alerts (transfers + token deploys) are pushed automatically to the same chat.
