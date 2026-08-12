# Deploy — Spaceship / VPS

Guide pour héberger **robinhood-wallet-tracker** (+ optionnel **robinhood-uniswap-bot** pour l’auto-buy).

## 1. Prérequis serveur

- Ubuntu 22.04+ (ou similaire)
- Node.js **≥ 18**
- Accès SSH
- Domaine ou IP publique (HTTPS recommandé pour le webhook Alchemy)

```bash
# Node 20 via nodesource (exemple)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
```

## 2. Cloner les repos

```bash
cd ~
git clone https://github.com/hexdexrobin/robinhood-wallet-tracker.git
git clone https://github.com/hexdexrobin/robinhood-uniswap-bot.git

cd robinhood-wallet-tracker && npm install
cd ~/robinhood-uniswap-bot && npm install
```

## 3. Configurer `.env`

### Tracker

```bash
cd ~/robinhood-wallet-tracker
cp .env.example .env
nano .env
```

Renseigner au minimum :

| Variable | Où la trouver |
|----------|----------------|
| `ALCHEMY_API_KEY` | Alchemy → app Robinhood Chain |
| `ALCHEMY_AUTH_TOKEN` | Alchemy → Notify → Auth Token |
| `WEBHOOK_URL` | `https://TON_DOMAINE/webhook` |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `TELEGRAM_CHAT_ID` | ton chat id |
| `UNISWAP_BOT_PATH` | `/home/USER/robinhood-uniswap-bot` |
| `AUTO_BUY_ENABLED` | `true` seulement quand prêt |

### Uniswap bot (auto-buy)

```bash
cd ~/robinhood-uniswap-bot
cp env.template .env   # ou .env.example si présent
nano .env
```

| Variable | Notes |
|----------|--------|
| `UNISWAP_API_KEY` | developers.uniswap.org |
| `PRIVATE_KEY` | **wallet dédié** avec peu d’ETH |
| `RPC_URL` | Alchemy Robinhood ou RPC public |
| `CHAIN_ID` | `4663` |
| `STOP_LOSS_PCT` | ex. `40` |
| `TAKE_PROFIT_PCT` | ex. `100` |
| `DRY_RUN` | `true` pour tests |

## 4. HTTPS + reverse proxy (Nginx)

Alchemy envoie les webhooks en **HTTPS**.

Exemple Nginx :

```nginx
server {
    listen 443 ssl;
    server_name tracker.tondomaine.com;

    # ssl_certificate ...;
    # ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Puis dans `.env` du tracker :

```env
WEBHOOK_URL=https://tracker.tondomaine.com/webhook
PORT=3000
```

Créer / mettre à jour le webhook Address Activity sur **Robinhood Chain Mainnet** vers cette URL.

## 5. Lancer avec PM2

```bash
cd ~/robinhood-wallet-tracker
mkdir -p logs data
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # suivre la commande affichée
pm2 status
pm2 logs robinhood-wallet-tracker
```

## 6. Vérifications

```bash
curl https://tracker.tondomaine.com/health
curl https://tracker.tondomaine.com/wallets

# Telegram
# /start  /status  /wallets  /config  /amount 0.001  /autobuy on
```

## 7. Auto-buy checklist

1. Uniswap bot installé + `.env` avec clé + `PRIVATE_KEY`
2. Tracker : `UNISWAP_BOT_PATH` = chemin absolu correct
3. `AUTO_BUY_DRY_RUN=true` pour un premier test
4. Puis `AUTO_BUY_DRY_RUN=false` + petit `AUTO_BUY_ETH_AMOUNT`
5. Wallet tracké lance un token → alerte Telegram + process swap

## 8. Mises à jour

```bash
cd ~/robinhood-wallet-tracker && git pull && npm install && pm2 restart robinhood-wallet-tracker
cd ~/robinhood-uniswap-bot && git pull && npm install
```

## 9. Sécurité

- Ne jamais committer `.env` / clés privées
- Wallet trading **séparé** du cold wallet
- Firewall : ouvrir 80/443 seulement (pas exposer 3000 publiquement si Nginx)
- Révoquer les tokens GitHub / Alchemy si exposés

## Dépannage

| Problème | Solution |
|----------|----------|
| Webhook muet | Vérifier `WEBHOOK_URL`, Nginx, Alchemy Notify network = ROBINHOOD_MAINNET |
| RPC 401 | Mauvaise `ALCHEMY_API_KEY` |
| Telegram OFF | `TELEGRAM_BOT_TOKEN` + `CHAT_ID` |
| Auto-buy fail | `pm2 logs` + `logs/autobuy-*.log` + chemin `UNISWAP_BOT_PATH` |
| No quotes | Token trop nouveau / pas de liquidité → retry, slippage plus haut |
