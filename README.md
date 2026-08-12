# Robinhood Chain Wallet Tracker

Bot Node.js pour **suivre des wallets** sur **Robinhood Chain (chain ID 4663)**, détecter les **lancements de tokens**, les **drains**, et optionnellement **acheter auto** via [robinhood-uniswap-bot](https://github.com/hexdexrobin/robinhood-uniswap-bot).

## Fonctionnalités

- Suivi multi-wallets (webhook Alchemy + polling backup)
- Alertes **ETH drain** + **token launch** (Telegram / Discord)
- Auto-ajout du **dernier hop** seulement si le wallet source est **vide** (&lt; 0.001 ETH)
- Décodage calldata (helper `0x5b8d85…`) pour le vrai destinataire
- Labels personnalisés + persistance `data/wallets.json`
- **Telegram** : boutons, commandes, auto-buy config
- **Auto-buy** Uniswap (TP + **stop-loss**)

## Stack

Express · ethers v6 · Alchemy JSON-RPC · Telegram Bot API · PM2 (prod)

## Install local

```bash
git clone https://github.com/hexdexrobin/robinhood-wallet-tracker.git
cd robinhood-wallet-tracker
npm install
cp .env.example .env
# éditer .env
npm start
```

## Telegram (commandes principales)

| Commande | Rôle |
|----------|------|
| `/start` `/help` | Menu |
| `/wallets` `/add` `/label` `/remove` | Suivi |
| `/alerts` `/status` `/balance` | Monitoring |
| `/buy 0xTOKEN [ETH]` | Achat manuel |
| `/autobuy on\|off` | Achat auto au launch |
| `/amount 0.001` | Montant d’achat |
| `/tp 100` `/sl 40` | Take-profit / stop-loss |
| `/dryrun on\|off` | Simulation |
| `/config` | Config trading |

Boutons : Wallets · Alertes · Status · Ajouter · AutoBuy · Montant ETH · Config · Balance · Aide

## CLI

```bash
npm run add -- 0xWALLET
npm run wallets
npm run alerts
```

## Deploy production (Spaceship)

Voir **[DEPLOY.md](./DEPLOY.md)** — Nginx HTTPS, PM2, variables d’env, auto-buy.

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

## Structure

```text
index.js              # serveur + tracker + telegram
auto-buy.js           # pont → robinhood-uniswap-bot
add-wallet.sh         # CLI add
list-wallets.sh       # CLI list
ecosystem.config.cjs  # PM2
data/wallets.json     # persistance (gitignored)
logs/                 # logs auto-buy / pm2 (gitignored)
```

## Sécurité

- Ne jamais committer `.env`
- Wallet de trading dédié, petit budget
- `AUTO_BUY_DRY_RUN=true` avant la prod

## Licence

MIT — usage à tes risques (memecoins = très risqué).
