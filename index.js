/**
 * Robinhood Chain Wallet Tracker Bot
 *
 * Tracks wallets on Robinhood Chain mainnet (Chain ID 4663).
 * Testnet Chain ID is 46630 (documented for reference; this bot targets mainnet).
 *
 * Stack: Express + Alchemy JSON-RPC (alchemy_getAssetTransfers) + ethers.js v6
 *
 * Why not alchemy-sdk Network?
 * alchemy-sdk still does NOT list "robinhood-mainnet" in its Network enum.
 * Passing it makes getAssetTransfers throw "Invalid network 'robinhood-mainnet'".
 * We call the Robinhood Alchemy RPC URL directly instead (same methods, no SDK gate).
 *
 * Storage: in-memory (see PRODUCTION STORAGE comment below)
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { ethers } = require("ethers");
const { maybeAutoBuyToken } = require("./auto-buy");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Robinhood Chain mainnet = 4663 | testnet = 46630
const CHAIN_ID_MAINNET = 4663;
const CHAIN_ID_TESTNET = 46630; // not used at runtime; documented for operators

const EMPTY_BALANCE_WEI = ethers.parseEther("0.001"); // < 0.001 ETH ⇒ "empty"
const POLL_INTERVAL_MS = 15_000;
const LAST_OUTGOING_SCAN_COUNT = 10;

// Alchemy network slug used in RPC host (NOT yet in alchemy-sdk Network enum)
const ROBINHOOD_NETWORK_SLUG = "robinhood-mainnet";

// Local alert log (one line JSON per signal)
const ALERTS_LOG_PATH = path.join(__dirname, "alerts.log");
// Persisted wallet personalization (labels/notes) + list across restarts
const WALLETS_DB_PATH = path.join(__dirname, "data", "wallets.json");

const {
  ALCHEMY_API_KEY,
  ALCHEMY_AUTH_TOKEN,
  WEBHOOK_URL,
  PORT = 3000,
  // Optional push notifications when a tracked wallet transfers
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

if (!ALCHEMY_API_KEY) {
  console.error("[TRACKER] Missing ALCHEMY_API_KEY in environment");
  process.exit(1);
}

// RPC: https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}
const RPC_URL = `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// ethers.js v6 JsonRpcProvider for balance + receipt + getCode
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID_MAINNET);

// ---------------------------------------------------------------------------
// In-memory state
// PRODUCTION STORAGE: swap this Set + variables for Redis (e.g. ioredis) or
// Postgres (e.g. pg / Prisma) so tracked wallets and webhookId survive restarts
// and can be shared across multiple bot instances.
// ---------------------------------------------------------------------------

/** @type {Set<string>} checksum-normalized lowercase addresses */
const trackedWallets = new Set();

/**
 * Personalization per wallet.
 * @type {Map<string, { address: string, label: string, note: string, addedAt: string, source: string, parent: string|null }>}
 */
const walletMeta = new Map();

/** Telegram multi-step pending actions: chatId -> { action, address? } */
const tgPending = new Map();

/** Alchemy ADDRESS_ACTIVITY webhook id, once created/found */
let addressActivityWebhookId = null;

/**
 * true when ADDRESS_ACTIVITY webhooks work on Robinhood; false forces polling.
 * Starts null until first register attempt resolves.
 */
let webhooksSupported = null;

/** setInterval handle for the 15s polling fallback */
let pollingIntervalId = null;

/**
 * Per-wallet last seen outgoing tx hash (polling dedupe).
 * PRODUCTION STORAGE: persist in Redis/Postgres alongside trackedWallets.
 * @type {Map<string, string>}
 */
const lastSeenOutgoingHash = new Map();

/** Dedupe identical transfer alerts (hash+direction) for a few minutes */
const recentAlertKeys = new Map(); // key -> timestamp ms
const ALERT_DEDUPE_MS = 60_000;

/**
 * Contract addresses already flagged as token deploys (avoid spam).
 * PRODUCTION STORAGE: persist in Redis/Postgres with trackedWallets.
 * @type {Set<string>}
 */
const detectedTokenContracts = new Set();

// Minimal ERC-20 ABI to fingerprint a newly deployed token
const ERC20_IFACE = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// ALERTS — "fais moi signe" when a tracked wallet transfers
// ---------------------------------------------------------------------------

/**
 * Big terminal banner + optional Discord/Telegram + alerts.log
 * Called whenever a tracked wallet sends (or receives) a transfer.
 */
async function signalTransfer(alert) {
  const {
    direction = "OUT", // OUT | IN
    wallet,
    from,
    to,
    asset,
    value,
    hash,
    category,
    source = "webhook",
  } = alert;

  const dedupeKey = `${(hash || "").toLowerCase()}:${direction}:${(wallet || "").toLowerCase()}`;
  const now = Date.now();
  if (hash && recentAlertKeys.has(dedupeKey)) {
    const prev = recentAlertKeys.get(dedupeKey);
    if (now - prev < ALERT_DEDUPE_MS) return;
  }
  if (hash) recentAlertKeys.set(dedupeKey, now);

  // Prune old dedupe keys occasionally
  if (recentAlertKeys.size > 500) {
    for (const [k, t] of recentAlertKeys) {
      if (now - t > ALERT_DEDUPE_MS) recentAlertKeys.delete(k);
    }
  }

  const ts = new Date().toISOString();
  const valueStr =
    value === undefined || value === null || value === ""
      ? "?"
      : String(value);
  const assetStr = asset || "ETH";
  const arrow = direction === "IN" ? "⬅️  REÇU" : "➡️  ENVOYÉ";
  const line =
    `${arrow} | wallet=${wallet} | ${from} → ${to} | ` +
    `${valueStr} ${assetStr} | hash=${hash || "?"} | via=${source}`;

  // Terminal: loud banner + bell (\x07) so you notice in the console
  const bar = "═".repeat(72);
  console.log("\x07"); // terminal bell
  console.log(`\n${bar}`);
  console.log(`[ALERT] 🚨 TRANSFERT WALLET SUIVI 🚨  ${ts}`);
  console.log(`[ALERT] ${line}`);
  if (hash) {
    console.log(`[ALERT] tx: ${hash}`);
  }
  console.log(`${bar}\n`);

  // Persist for later review: npm-less tail -f alerts.log
  try {
    fs.appendFileSync(
      ALERTS_LOG_PATH,
      JSON.stringify({ ts, direction, wallet, from, to, asset: assetStr, value: valueStr, hash, category, source }) +
        "\n"
    );
  } catch (err) {
    console.error(`[ALERT] failed to write ${ALERTS_LOG_PATH}: ${err.message}`);
  }

  // Optional Discord
  if (DISCORD_WEBHOOK_URL) {
    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content:
            `🚨 **Robinhood transfer** (${direction})\n` +
            `\`${wallet}\`\n` +
            `${from} → ${to}\n` +
            `**${valueStr} ${assetStr}**\n` +
            `\`${hash || "?"}\``,
        }),
      });
    } catch (err) {
      console.error(`[ALERT] Discord notify failed: ${err.message || err}`);
    }
  }

  // Optional Telegram (same chat as commands)
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(
      `🚨 TRANSFERT (${direction === "IN" ? "REÇU" : "ENVOYÉ"})\n` +
        `wallet: ${walletDisplay(wallet)}\n` +
        `${wallet}\n` +
        `${from} → ${to}\n` +
        `${valueStr} ${assetStr}\n` +
        `hash: ${hash || "?"}`,
      TELEGRAM_CHAT_ID,
      { reply_markup: mainReplyKeyboard() }
    );
  }
}

/**
 * Should we push this activity to Telegram/console as a "sign"?
 * Skip noisy ERC-20 sells into pools/routers — only signal:
 *  - native ETH outs (drains / eth moves)
 *  - ETH ins to a tracked wallet
 * Token deploys + new-wallet hops have their own alerts.
 */
async function isSignificantTransferAlert(item, direction) {
  const asset = (item.asset || "").toUpperCase();
  const category = (item.category || "").toLowerCase();
  const to = (item.toAddress || item.to || "").toLowerCase();
  const isEth =
    category === "external" ||
    asset === "ETH" ||
    asset === "NATIVE" ||
    asset === "" ||
    asset === "NULL";

  if (direction === "OUT") {
    // Only ETH outs (real drains / funding moves)
    if (!isEth) {
      console.log(
        `[ALERT] skip noise OUT token ${asset || category} → ${to || "?"} (pool/sell)`
      );
      return false;
    }
    // ETH out to a known burn/sentinel — skip
    if (to && SKIP_AUTO_TRACK.has(to)) return false;
    return true;
  }

  // IN: only ETH received on a tracked wallet
  if (!isEth) return false;
  return true;
}

/**
 * Build and fire an alert from an Alchemy activity item if it touches a tracked wallet.
 * Returns true if the `from` address is a tracked wallet (caller may run empty-detect).
 */
async function alertIfTrackedActivity(item, source = "webhook") {
  const from = (item.fromAddress || item.from || "").toLowerCase();
  const to = (item.toAddress || item.to || "").toLowerCase();
  const hash = item.hash || item.transactionHash || item.txHash;
  const asset = item.asset;
  const value = item.value;
  const category = item.category;

  let fired = false;

  if (from && trackedWallets.has(from)) {
    if (await isSignificantTransferAlert(item, "OUT")) {
      await signalTransfer({
        direction: "OUT",
        wallet: from,
        from,
        to: to || "?",
        asset,
        value,
        hash,
        category,
        source,
      });
      fired = true;
    }
  }

  if (to && trackedWallets.has(to) && to !== from) {
    if (await isSignificantTransferAlert(item, "IN")) {
      await signalTransfer({
        direction: "IN",
        wallet: to,
        from: from || "?",
        to,
        asset,
        value,
        hash,
        category,
        source,
      });
      fired = true;
    }
  }

  return from && trackedWallets.has(from);
}

// ---------------------------------------------------------------------------
// Alchemy JSON-RPC helpers (bypass alchemy-sdk network enum)
// ---------------------------------------------------------------------------

let rpcId = 1;

/**
 * Low-level JSON-RPC call against the Robinhood Alchemy endpoint.
 * Used because alchemy-sdk rejects network "robinhood-mainnet".
 */
async function alchemyRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  if (body.error) {
    throw new Error(body.error.message || JSON.stringify(body.error));
  }
  return body.result;
}

/**
 * alchemy_getAssetTransfers via raw RPC.
 *
 * NOTE: category "internal" is NOT supported on Robinhood Chain yet
 * (Alchemy returns -32602). We use external + erc20 only.
 *
 * @param {object} opts
 * @param {string} [opts.fromAddress]
 * @param {string[]} [opts.category]
 * @param {string} [opts.order] "asc" | "desc"
 * @param {number} [opts.maxCount]
 */
async function getAssetTransfers({
  fromAddress,
  category = ["external", "erc20"],
  order = "desc",
  maxCount = 1,
}) {
  // Alchemy expects maxCount as hex string in some gateways; number also works
  // on most endpoints — use hex for widest compatibility.
  const result = await alchemyRpc("alchemy_getAssetTransfers", [
    {
      fromAddress,
      category,
      order,
      maxCount: "0x" + Number(maxCount).toString(16),
      withMetadata: true,
    },
  ]);
  return result || { transfers: [] };
}

/**
 * List all team webhooks (Notify Auth Token required).
 * GET https://dashboard.alchemy.com/api/team-webhooks
 */
async function notifyListWebhooks() {
  const res = await fetch("https://dashboard.alchemy.com/api/team-webhooks", {
    headers: { "X-Alchemy-Token": ALCHEMY_AUTH_TOKEN },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `List webhooks failed HTTP ${res.status}`
    );
  }
  return data.data || data.webhooks || [];
}

/**
 * Find an existing active ADDRESS_ACTIVITY webhook on Robinhood mainnet.
 * Prefer one whose URL matches WEBHOOK_URL when set.
 */
async function notifyFindRobinhoodWebhook() {
  const webhooks = await notifyListWebhooks();
  const robinhood = webhooks.filter(
    (w) =>
      w.is_active !== false &&
      (w.webhook_type === "ADDRESS_ACTIVITY" ||
        w.type === "ADDRESS_ACTIVITY") &&
      String(w.network || "").toUpperCase().includes("ROBINHOOD")
  );
  if (robinhood.length === 0) return null;

  if (WEBHOOK_URL) {
    const match = robinhood.find(
      (w) =>
        (w.webhook_url || w.url || "").replace(/\/$/, "") ===
        WEBHOOK_URL.replace(/\/$/, "")
    );
    if (match) return match;
  }
  return robinhood[0];
}

/**
 * Alchemy Notify REST: create ADDRESS_ACTIVITY webhook on Robinhood mainnet.
 * Docs: https://docs.alchemy.com/reference/create-webhook
 */
async function notifyCreateAddressActivityWebhook(url, addresses) {
  const res = await fetch("https://dashboard.alchemy.com/api/create-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Alchemy-Token": ALCHEMY_AUTH_TOKEN,
    },
    body: JSON.stringify({
      network: "ROBINHOOD_MAINNET",
      webhook_type: "ADDRESS_ACTIVITY",
      webhook_url: url,
      addresses,
      name: "robinhood-wallet-tracker",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Notify create failed HTTP ${res.status}`
    );
  }
  // Response may be flat or nested under data
  return data.data || data;
}

/**
 * Alchemy Notify REST: append addresses to an existing webhook.
 */
async function notifyUpdateWebhookAddresses(webhookId, addressesToAdd) {
  const res = await fetch(
    "https://dashboard.alchemy.com/api/update-webhook-addresses",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Alchemy-Token": ALCHEMY_AUTH_TOKEN,
      },
      body: JSON.stringify({
        webhook_id: webhookId,
        addresses_to_add: addressesToAdd,
        addresses_to_remove: [],
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Notify update failed HTTP ${res.status}`
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize an address to lowercase hex for Set membership. */
function normalizeAddress(address) {
  return ethers.getAddress(address).toLowerCase();
}

// ---------------------------------------------------------------------------
// Wallet personalization + JSON persistence
// ---------------------------------------------------------------------------

/** Display name: custom label or short address */
function walletDisplay(address) {
  const a = (address || "").toLowerCase();
  const meta = walletMeta.get(a);
  if (meta?.label) return `${meta.label}`;
  return a;
}

/** Label + full address line for messages */
function walletLine(address) {
  const a = (address || "").toLowerCase();
  const meta = walletMeta.get(a);
  if (meta?.label) return `🏷️ ${meta.label}\n   ${a}`;
  return a;
}

function ensureWalletMeta(address, extra = {}) {
  const a = address.toLowerCase();
  if (!walletMeta.has(a)) {
    walletMeta.set(a, {
      address: a,
      label: extra.label || "",
      note: extra.note || "",
      addedAt: extra.addedAt || new Date().toISOString(),
      source: extra.source || "api",
      parent: extra.parent || null,
    });
  } else if (extra.label != null && extra.label !== "") {
    walletMeta.get(a).label = extra.label;
  }
  if (extra.note != null) walletMeta.get(a).note = extra.note;
  if (extra.source) walletMeta.get(a).source = extra.source;
  if (extra.parent) walletMeta.get(a).parent = extra.parent;
  return walletMeta.get(a);
}

function saveWalletsDb() {
  try {
    fs.mkdirSync(path.dirname(WALLETS_DB_PATH), { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      webhookId: addressActivityWebhookId,
      wallets: [...trackedWallets].map((a) => {
        const m = walletMeta.get(a) || { address: a, label: "", note: "" };
        return {
          address: a,
          label: m.label || "",
          note: m.note || "",
          addedAt: m.addedAt || null,
          source: m.source || null,
          parent: m.parent || null,
        };
      }),
    };
    fs.writeFileSync(WALLETS_DB_PATH, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(`[TRACKER] save wallets db failed: ${err.message || err}`);
  }
}

function loadWalletsDb() {
  try {
    if (!fs.existsSync(WALLETS_DB_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(WALLETS_DB_PATH, "utf8"));
    if (data.webhookId && !addressActivityWebhookId) {
      addressActivityWebhookId = data.webhookId;
    }
    return Array.isArray(data.wallets) ? data.wallets : [];
  } catch (err) {
    console.error(`[TRACKER] load wallets db failed: ${err.message || err}`);
    return [];
  }
}

/**
 * Set or clear a custom label for a tracked wallet.
 */
function setWalletLabel(rawAddress, label) {
  const address = normalizeAddress(rawAddress);
  if (!trackedWallets.has(address)) {
    throw new Error("Wallet non suivi — ajoute-le d’abord");
  }
  ensureWalletMeta(address);
  walletMeta.get(address).label = String(label || "").trim().slice(0, 48);
  saveWalletsDb();
  return walletMeta.get(address);
}

/**
 * Remove a wallet from tracking (memory + webhook + db).
 */
async function removeWallet(rawAddress) {
  const address = normalizeAddress(rawAddress);
  if (!trackedWallets.has(address)) {
    return { address, removed: false };
  }
  trackedWallets.delete(address);
  walletMeta.delete(address);
  lastSeenOutgoingHash.delete(address);

  if (addressActivityWebhookId && ALCHEMY_AUTH_TOKEN) {
    try {
      await notifyUpdateWebhookAddressesRemove(addressActivityWebhookId, [
        address,
      ]);
    } catch (err) {
      console.warn(
        `[TRACKER] webhook remove address failed: ${err.message || err}`
      );
    }
  }
  saveWalletsDb();
  console.log(`[TRACKER] Removed wallet ${address}`);
  return { address, removed: true };
}

/** Notify API: remove addresses from webhook */
async function notifyUpdateWebhookAddressesRemove(webhookId, addressesToRemove) {
  const res = await fetch(
    "https://dashboard.alchemy.com/api/update-webhook-addresses",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Alchemy-Token": ALCHEMY_AUTH_TOKEN,
      },
      body: JSON.stringify({
        webhook_id: webhookId,
        addresses_to_add: [],
        addresses_to_remove: addressesToRemove,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Notify remove failed HTTP ${res.status}`
    );
  }
  return data;
}

/**
 * Fetch the most recent outgoing transfer for a wallet.
 * Categories: external + erc20 (internal unsupported on Robinhood).
 */
async function fetchLastOutgoingTransfer(walletAddress) {
  console.log(
    `[TRACKER] Fetching last outgoing transfer for ${walletAddress}`
  );

  const response = await getAssetTransfers({
    fromAddress: walletAddress,
    category: ["external", "erc20"],
    order: "desc",
    maxCount: 1,
  });

  const transfer = response.transfers?.[0] ?? null;
  if (transfer) {
    console.log(
      `[TRACKER] Last outgoing: hash=${transfer.hash} to=${transfer.to} ` +
        `asset=${transfer.asset} value=${transfer.value} category=${transfer.category}`
    );
  } else {
    console.log(`[TRACKER] No outgoing transfers found for ${walletAddress}`);
  }
  return transfer;
}

/**
 * Fetch up to `maxCount` recent outgoing EXTERNAL transfers (ETH-level txs).
 * Used when an empty wallet is detected to find token deploys / new wallets.
 */
async function fetchRecentOutgoingExternal(walletAddress, maxCount) {
  console.log(
    `[DETECT] Scanning last ${maxCount} outgoing external txs for ${walletAddress}`
  );

  const response = await getAssetTransfers({
    fromAddress: walletAddress,
    category: ["external"],
    order: "desc",
    maxCount,
  });

  return response.transfers || [];
}

/**
 * Register `address` on an Alchemy ADDRESS_ACTIVITY webhook.
 * Creates the webhook if none exists yet; otherwise appends the address.
 * On unsupported-network / API failure, enables the 15s polling fallback.
 */
async function registerAddressOnWebhook(address) {
  if (!ALCHEMY_AUTH_TOKEN) {
    console.warn(
      "[TRACKER] ALCHEMY_AUTH_TOKEN missing — skipping webhook registration, enabling polling"
    );
    enablePollingFallback("missing ALCHEMY_AUTH_TOKEN", {
      disableWebhooks: true,
    });
    return;
  }

  if (!WEBHOOK_URL) {
    console.warn(
      "[TRACKER] WEBHOOK_URL missing — skipping webhook registration, enabling polling"
    );
    enablePollingFallback("missing WEBHOOK_URL", { disableWebhooks: true });
    return;
  }

  if (webhooksSupported === false) {
    console.log(
      `[TRACKER] Webhooks unsupported; ${address} will be covered by polling only`
    );
    return;
  }

  try {
    // Reuse webhook created in the Alchemy dashboard if we don't have an id yet
    if (!addressActivityWebhookId) {
      try {
        const existing = await notifyFindRobinhoodWebhook();
        if (existing?.id) {
          addressActivityWebhookId = existing.id;
          webhooksSupported = true;
          console.log(
            `[TRACKER] Reusing existing webhook id=${addressActivityWebhookId} ` +
              `url=${existing.webhook_url || existing.url || "?"}`
          );
        }
      } catch (findErr) {
        console.warn(
          `[TRACKER] Could not list existing webhooks: ${findErr.message || findErr}`
        );
      }
    }

    if (!addressActivityWebhookId) {
      console.log(
        `[TRACKER] Creating ADDRESS_ACTIVITY webhook → ${WEBHOOK_URL}`
      );
      const webhook = await notifyCreateAddressActivityWebhook(WEBHOOK_URL, [
        address,
      ]);
      addressActivityWebhookId =
        webhook.id || webhook.webhook_id || null;
      if (!addressActivityWebhookId) {
        throw new Error(
          `Create webhook returned no id: ${JSON.stringify(webhook)}`
        );
      }
      webhooksSupported = true;
      console.log(
        `[TRACKER] Webhook created id=${addressActivityWebhookId} for ${address}`
      );
    } else {
      console.log(
        `[TRACKER] Appending ${address} to webhook ${addressActivityWebhookId}`
      );
      await notifyUpdateWebhookAddresses(addressActivityWebhookId, [address]);
      webhooksSupported = true;
      console.log(`[TRACKER] Webhook updated with ${address}`);
    }
  } catch (err) {
    console.error(
      `[TRACKER] ADDRESS_ACTIVITY webhook failed: ${err.message || err}`
    );
    enablePollingFallback(err.message || String(err), {
      disableWebhooks: true,
    });
  }
}

/**
 * Flip into polling mode and start a 15s setInterval over all tracked wallets.
 * Idempotent — calling multiple times does not stack intervals.
 */
/**
 * Start (or keep) the 15s polling loop over tracked wallets.
 * Does NOT force webhooksSupported=false when used as a backup alongside webhooks.
 */
function enablePollingFallback(reason, { disableWebhooks = false } = {}) {
  if (disableWebhooks) {
    webhooksSupported = false;
  }
  console.warn(
    `[POLLING] getAssetTransfers every ${POLL_INTERVAL_MS / 1000}s ` +
      `(reason: ${reason})`
  );

  if (pollingIntervalId) return;

  pollingIntervalId = setInterval(() => {
    pollAllTrackedWallets().catch((err) => {
      console.error(`[POLLING] Interval error: ${err.message || err}`);
    });
  }, POLL_INTERVAL_MS);
}

/**
 * Polling loop: for each tracked wallet, look at the latest outgoing transfer.
 * If the hash is new, treat it like a webhook activity event for that sender.
 */
async function pollAllTrackedWallets() {
  const wallets = [...trackedWallets];
  if (wallets.length === 0) return;

  console.log(`[POLLING] Checking ${wallets.length} wallet(s)`);

  for (const wallet of wallets) {
    try {
      const response = await getAssetTransfers({
        fromAddress: wallet,
        category: ["external", "erc20"],
        order: "desc",
        maxCount: 1,
      });

      const transfer = response.transfers?.[0];
      if (!transfer?.hash) continue;

      const prev = lastSeenOutgoingHash.get(wallet);
      if (prev === transfer.hash) continue;

      // Seed baseline on first poll without treating historical txs as "new"
      if (prev === undefined) {
        lastSeenOutgoingHash.set(wallet, transfer.hash);
        console.log(
          `[POLLING] Seeded lastSeen for ${wallet} → ${transfer.hash}`
        );
        continue;
      }

      lastSeenOutgoingHash.set(wallet, transfer.hash);
      console.log(
        `[POLLING] New activity for ${wallet}: hash=${transfer.hash} ` +
          `to=${transfer.to} asset=${transfer.asset} value=${transfer.value}`
      );

      await handleActivityForSender(
        wallet,
        [
          {
            fromAddress: transfer.from,
            toAddress: transfer.to,
            hash: transfer.hash,
            asset: transfer.asset,
            category: transfer.category,
            value: transfer.value,
          },
        ],
        "polling"
      );
    } catch (err) {
      console.error(
        `[POLLING] Failed for ${wallet}: ${err.message || err}`
      );
    }
  }
}

/**
 * For each outgoing ETH tx from a tracked wallet, find the REAL next wallet:
 * - direct EOA transfer, OR
 * - address encoded in calldata when sending to a helper/relay contract
 *
 * ONLY auto-adds when the SOURCE wallet is empty (< 0.001 ETH).
 * That way we only track the "last" hop after a full drain.
 */
async function followHopWalletsFromTxs(senderNorm, txHashes, source = "webhook") {
  // Hard requirement: source must have nothing left
  let balance;
  try {
    balance = await provider.getBalance(senderNorm);
  } catch (err) {
    console.error(
      `[DETECT] balance check before hop failed: ${err.message || err}`
    );
    return;
  }
  const balEth = ethers.formatEther(balance);
  if (balance >= EMPTY_BALANCE_WEI) {
    console.log(
      `[DETECT] skip hop auto-add — ${senderNorm} still has ${balEth} ETH ` +
        `(need < 0.001 to follow next wallet)`
    );
    return;
  }
  console.log(
    `[DETECT] source empty (${balEth} ETH) — searching last hop wallet(s)`
  );

  for (const txHash of txHashes) {
    if (!txHash || txHash.length !== 66) continue;
    let candidates = [];
    try {
      candidates = await resolveNewWalletCandidates(txHash, senderNorm);
    } catch (err) {
      console.error(
        `[DETECT] hop resolve failed for ${txHash}: ${err.message || err}`
      );
      continue;
    }
    for (const newAddr of candidates) {
      if (SKIP_AUTO_TRACK.has(newAddr) || !isPlausibleWalletAddress(newAddr)) {
        console.log(`[DETECT] skip non-wallet hop ${newAddr} (tx ${txHash})`);
        continue;
      }
      if (trackedWallets.has(newAddr)) {
        console.log(`[DETECT] hop ${newAddr} already tracked (tx ${txHash})`);
        continue;
      }
      // Re-check source empty right before add (race with more funding)
      try {
        const bal2 = await provider.getBalance(senderNorm);
        if (bal2 >= EMPTY_BALANCE_WEI) {
          console.log(
            `[DETECT] abort hop add — ${senderNorm} refilled before add`
          );
          return;
        }
      } catch {
        /* continue with add */
      }

      console.log(
        `[NEW WALLET] Last hop (source empty) ${newAddr} from ${senderNorm} ` +
          `(tx ${txHash}, via=${source})`
      );
      try {
        await addWallet(newAddr, {
          source: "auto-detect-hop-empty",
          parent: senderNorm,
        });
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
          await sendTelegram(
            `🆕 NOUVEAU WALLET (dernier hop — source vide)\n` +
              `from: ${walletDisplay(senderNorm)}\n` +
              `${senderNorm}\n` +
              `new: ${walletDisplay(newAddr)}\n` +
              `${newAddr}\n` +
              `tx: ${txHash}`,
            TELEGRAM_CHAT_ID,
            { reply_markup: mainReplyKeyboard() }
          );
        }
      } catch (err) {
        console.error(
          `[NEW WALLET] failed to add ${newAddr}: ${err.message || err}`
        );
      }
    }
  }
}

/**
 * Handle activity for a sender:
 * 1) Alert significant transfers only (ETH drain/in — not ERC20 pool sells)
 * 2) Token CREATE detection
 * 3) If wallet EMPTY (< 0.001 ETH) → follow last hop + deep scan
 */
async function handleActivityForSender(sender, activityItems = [], source = "webhook") {
  let senderNorm;
  try {
    senderNorm = normalizeAddress(sender);
  } catch {
    console.log(`[WEBHOOK] Invalid sender ${sender}`);
    return;
  }

  // Significant transfer alerts only (filters ERC-20 → pool noise)
  for (const item of activityItems) {
    try {
      await alertIfTrackedActivity(item, source);
    } catch (err) {
      console.error(`[ALERT] signal error: ${err.message || err}`);
    }
  }

  if (!trackedWallets.has(senderNorm)) {
    return;
  }

  const hashes = new Set();
  for (const item of activityItems) {
    const h = item.hash || item.transactionHash || item.txHash;
    if (h && typeof h === "string" && h.startsWith("0x") && h.length === 66) {
      hashes.add(h.toLowerCase());
    }
  }

  // Token CREATE (direct receipt.contractAddress only — less noise)
  for (const txHash of hashes) {
    try {
      await detectTokenCreationFromTx(txHash, senderNorm, source);
    } catch (err) {
      console.error(
        `[TOKEN DEPLOY] scan failed for ${txHash}: ${err.message || err}`
      );
    }
  }

  console.log(`[BALANCE] Checking ETH balance for ${senderNorm}`);
  let balance;
  try {
    balance = await provider.getBalance(senderNorm);
  } catch (err) {
    console.error(
      `[BALANCE] getBalance failed for ${senderNorm}: ${err.message || err}`
    );
    return;
  }

  const balanceEth = ethers.formatEther(balance);
  console.log(`[BALANCE] ${senderNorm} balance=${balanceEth} ETH`);

  // ONLY when nothing left: follow last hop + deep scan of recent outs
  if (balance < EMPTY_BALANCE_WEI) {
    console.log(
      `[DETECT] ${senderNorm} empty (< 0.001 ETH) — follow last wallet + scan`
    );
    if (hashes.size > 0) {
      await followHopWalletsFromTxs(senderNorm, [...hashes], source);
    }
    await detectTokenDeploysAndNewWallets(senderNorm, activityItems);
  } else {
    console.log(
      `[DETECT] ${senderNorm} still has funds — no hop auto-add yet`
    );
  }
}

/**
 * Read ERC-20 metadata from a contract (name/symbol/decimals/totalSupply).
 * Returns null fields when the contract is not ERC-20-like.
 */
async function readErc20Metadata(contractAddress) {
  const meta = {
    address: contractAddress,
    name: null,
    symbol: null,
    decimals: null,
    totalSupply: null,
    isErc20Like: false,
  };
  const addr = contractAddress;
  try {
    meta.name = await provider.call({
      to: addr,
      data: ERC20_IFACE.encodeFunctionData("name", []),
    }).then((r) => {
      try {
        return ERC20_IFACE.decodeFunctionResult("name", r)[0];
      } catch {
        return null;
      }
    });
  } catch {
    /* not a token or reverts */
  }
  try {
    meta.symbol = await provider.call({
      to: addr,
      data: ERC20_IFACE.encodeFunctionData("symbol", []),
    }).then((r) => {
      try {
        return ERC20_IFACE.decodeFunctionResult("symbol", r)[0];
      } catch {
        return null;
      }
    });
  } catch {
    /* */
  }
  try {
    const raw = await provider.call({
      to: addr,
      data: ERC20_IFACE.encodeFunctionData("decimals", []),
    });
    meta.decimals = Number(ERC20_IFACE.decodeFunctionResult("decimals", raw)[0]);
  } catch {
    /* */
  }
  try {
    const raw = await provider.call({
      to: addr,
      data: ERC20_IFACE.encodeFunctionData("totalSupply", []),
    });
    const supply = ERC20_IFACE.decodeFunctionResult("totalSupply", raw)[0];
    meta.totalSupply = supply.toString();
    if (meta.decimals != null) {
      try {
        meta.totalSupplyFormatted = ethers.formatUnits(supply, meta.decimals);
      } catch {
        meta.totalSupplyFormatted = meta.totalSupply;
      }
    }
  } catch {
    /* */
  }

  meta.isErc20Like = Boolean(
    meta.symbol || meta.name || meta.decimals != null || meta.totalSupply
  );
  return meta;
}

/**
 * Loud alert when a tracked wallet deploys a contract / token.
 */
async function signalTokenDeploy({ deployer, contractAddress, txHash, meta, source }) {
  const key = `token:${contractAddress.toLowerCase()}`;
  if (detectedTokenContracts.has(contractAddress.toLowerCase())) {
    return;
  }
  detectedTokenContracts.add(contractAddress.toLowerCase());

  const ts = new Date().toISOString();
  const name = meta?.name || "?";
  const symbol = meta?.symbol || "?";
  const decimals = meta?.decimals != null ? meta.decimals : "?";
  const supply =
    meta?.totalSupplyFormatted || meta?.totalSupply || "?";
  const kind = meta?.isErc20Like ? "TOKEN ERC-20" : "CONTRACT";

  const bar = "═".repeat(72);
  console.log("\x07");
  console.log(`\n${bar}`);
  const launchTag = meta?.launchpad ? "LANCEMENT" : "CRÉÉ";
  console.log(`[TOKEN DEPLOY] 🪙 ${kind} ${launchTag} 🪙  ${ts}`);
  console.log(`[TOKEN DEPLOY] deployer = ${deployer}`);
  console.log(`[TOKEN DEPLOY] contract = ${contractAddress}`);
  console.log(
    `[TOKEN DEPLOY] name=${name}  symbol=${symbol}  decimals=${decimals}  supply=${supply}`
  );
  console.log(`[TOKEN DEPLOY] tx = ${txHash}`);
  console.log(`${bar}\n`);

  try {
    fs.appendFileSync(
      ALERTS_LOG_PATH,
      JSON.stringify({
        ts,
        type: "TOKEN_DEPLOY",
        kind,
        deployer,
        contractAddress,
        name,
        symbol,
        decimals,
        totalSupply: supply,
        hash: txHash,
        source,
      }) + "\n"
    );
  } catch (err) {
    console.error(`[TOKEN DEPLOY] log write failed: ${err.message}`);
  }

  // Also go through generic transfer-style notifiers (Discord / Telegram)
  if (DISCORD_WEBHOOK_URL) {
    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content:
            `🪙 **Token / contract deploy** on Robinhood\n` +
            `deployer: \`${deployer}\`\n` +
            `contract: \`${contractAddress}\`\n` +
            `**${name} (${symbol})** decimals=${decimals} supply=${supply}\n` +
            `tx: \`${txHash}\``,
        }),
      });
    } catch (err) {
      console.error(`[TOKEN DEPLOY] Discord failed: ${err.message || err}`);
    }
  }

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const buyAmt = process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
    const autoOn = isEnvOn("AUTO_BUY_ENABLED");
    await sendTelegram(
      `🪙 TOKEN ${meta?.launchpad ? "LANCÉ" : "CRÉÉ"}\n` +
        `deployer: ${walletDisplay(deployer)}\n` +
        `${deployer}\n` +
        `token: ${contractAddress}\n` +
        `**${name} (${symbol})**\n` +
        `decimals=${decimals} supply=${supply}\n` +
        `tx: ${txHash}\n\n` +
        (autoOn
          ? `🛒 Auto-buy ON → ${buyAmt} ETH`
          : `⏸ Auto-buy OFF — choisis un montant :`),
      TELEGRAM_CHAT_ID,
      {
        reply_markup: meta?.isErc20Like
          ? tokenBuyKeyboard(contractAddress)
          : mainReplyKeyboard(),
      }
    );
  }

  // Auto-buy via robinhood-uniswap-bot when a tracked wallet launches/creates a token
  if (meta?.isErc20Like) {
    setImmediate(() => {
      maybeAutoBuyToken({
        tokenAddress: contractAddress,
        deployer,
        symbol: String(symbol),
        name: String(name),
        txHash,
        launchpad: Boolean(meta?.launchpad),
        isErc20Like: true,
        fromCreate: !meta?.launchpad && Boolean(contractAddress),
        notify: (msg) =>
          sendTelegram(msg, TELEGRAM_CHAT_ID, {
            reply_markup: mainReplyKeyboard(),
          }),
      }).catch((err) => {
        console.error(`[AUTO-BUY] failed: ${err.message || err}`);
      });
    });
  }

  void key;
}

/**
 * Infrastructure / base assets that mint during launches but are NOT the new token.
 * (WETH wrap, Uniswap position NFTs, known routers, etc.)
 */
const SKIP_TOKEN_ADDRESSES = new Set(
  [
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH on Robinhood
    "0x73991a25c818bf1f1128deaab1492d45638de0d3", // Uniswap V3 Positions NFT
    "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb", // launch/router helper
    "0x736d76699c26d0d966744cae304c000d471f7f35", // swap helper often seen
    "0x5b8d85ebabf17cf6b67bfa2fe6795623951cd70e", // drain helper
  ].map((a) => a.toLowerCase())
);

const SKIP_TOKEN_SYMBOLS = new Set(
  [
    "WETH",
    "ETH",
    "USDC",
    "USDT",
    "DAI",
    "WBTC",
    "UNI-V3-POS",
    "UNI-V2",
  ].map((s) => s.toUpperCase())
);

function isSkippedLaunchToken(tokenAddr, meta) {
  if (SKIP_TOKEN_ADDRESSES.has(tokenAddr.toLowerCase())) return true;
  const sym = (meta?.symbol || "").toUpperCase();
  const name = (meta?.name || "").toLowerCase();
  if (sym && SKIP_TOKEN_SYMBOLS.has(sym)) return true;
  if (name.includes("uniswap") || name.includes("position nft")) return true;
  if (name === "wrapped ether" || name === "weth") return true;
  return false;
}

/**
 * Detect token/contract creation OR launchpad launch from a tracked wallet.
 *
 * Strategies:
 *  A) Classic CREATE: receipt.contractAddress set
 *  B) Launchpad / factory: ERC-20 Transfer(from=0x0) mint of a NEW token
 *     (common pattern: send ETH to router 0xa5aab3… which mints token + LP)
 *     Filters WETH / UNI-V3 NFT / known infra.
 */
async function detectTokenCreationFromTx(txHash, deployer, source = "webhook") {
  if (!txHash || !txHash.startsWith("0x") || txHash.length !== 66) {
    return [];
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    console.error(
      `[TOKEN DEPLOY] receipt fetch failed for tx ${txHash}: ${err.message || err}`
    );
    return [];
  }
  if (!receipt) {
    console.log(`[TOKEN DEPLOY] no receipt yet for ${txHash}`);
    return [];
  }

  const found = [];
  const deployerNorm = (deployer || "").toLowerCase();

  // --- A) Direct contract creation ---
  if (receipt.contractAddress) {
    const c = receipt.contractAddress.toLowerCase();
    console.log(
      `[TOKEN DEPLOY] CREATE detected: ${c} by ${deployer} in ${txHash}`
    );
    const meta = await readErc20Metadata(c);
    if (!isSkippedLaunchToken(c, meta)) {
      await signalTokenDeploy({
        deployer,
        contractAddress: c,
        txHash,
        meta,
        source,
      });
      found.push(c);
    } else {
      console.log(`[TOKEN DEPLOY] skip CREATE infra ${c}`);
    }
  }

  // --- B) Mints in logs = launchpad / factory token birth ---
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO_TOPIC =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  /** @type {Map<string, { toDeployer: boolean, mintTo: string|null }>} */
  const mintInfo = new Map();
  for (const log of receipt.logs || []) {
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (!log.topics[1] || log.topics[1].toLowerCase() !== ZERO_TOPIC) continue;
    const tokenAddr = (log.address || "").toLowerCase();
    if (!tokenAddr) continue;
    // topics[2] = to (padded address)
    let mintTo = null;
    if (log.topics[2] && log.topics[2].length === 66) {
      mintTo = "0x" + log.topics[2].slice(26).toLowerCase();
    }
    const prev = mintInfo.get(tokenAddr) || {
      toDeployer: false,
      mintTo: null,
    };
    if (mintTo && deployerNorm && mintTo === deployerNorm) {
      prev.toDeployer = true;
    }
    // also: later Transfer of this token TO deployer counts as launch involvement
    prev.mintTo = mintTo;
    mintInfo.set(tokenAddr, prev);
  }

  // If any Transfer of a mint-candidate ends up at deployer, flag it
  for (const log of receipt.logs || []) {
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    const tokenAddr = (log.address || "").toLowerCase();
    if (!mintInfo.has(tokenAddr)) continue;
    if (log.topics[2] && log.topics[2].length === 66) {
      const to = "0x" + log.topics[2].slice(26).toLowerCase();
      if (deployerNorm && to === deployerNorm) {
        mintInfo.get(tokenAddr).toDeployer = true;
      }
    }
  }

  for (const [tokenAddr, info] of mintInfo) {
    if (found.includes(tokenAddr)) continue;
    if (detectedTokenContracts.has(tokenAddr)) continue;
    if (SKIP_TOKEN_ADDRESSES.has(tokenAddr)) {
      console.log(`[TOKEN DEPLOY] skip known infra mint ${tokenAddr}`);
      continue;
    }

    let code;
    try {
      code = await provider.getCode(tokenAddr);
    } catch {
      continue;
    }
    if (!code || code === "0x" || code === "0x0") continue;

    const meta = await readErc20Metadata(tokenAddr);
    if (!meta.isErc20Like) {
      console.log(`[TOKEN DEPLOY] mint ${tokenAddr} not ERC-20-like — skip`);
      continue;
    }
    if (isSkippedLaunchToken(tokenAddr, meta)) {
      console.log(
        `[TOKEN DEPLOY] skip mint ${tokenAddr} symbol=${meta.symbol}`
      );
      continue;
    }

    // Prefer mints linked to deployer; still accept unknown new ERC20 minted
    // in a tx sent by deployer (launchpad create+liq pattern).
    console.log(
      `[TOKEN DEPLOY] LAUNCH mint detected: ${tokenAddr} ` +
        `symbol=${meta.symbol} name=${meta.name} toDeployer=${info.toDeployer} ` +
        `tx=${txHash}`
    );
    await signalTokenDeploy({
      deployer,
      contractAddress: tokenAddr,
      txHash,
      meta: { ...meta, launchpad: true, toDeployer: info.toDeployer },
      source,
    });
    found.push(tokenAddr);
  }

  if (found.length === 0 && (receipt.logs || []).length > 0) {
    console.log(
      `[TOKEN DEPLOY] no new token found in ${txHash} ` +
        `(mints=${mintInfo.size}, create=${receipt.contractAddress || "none"})`
    );
  }

  return found;
}

/**
 * Is this a plausible 20-byte wallet address (not a small int / offset / amount
 * that happens to look like a left-padded word in ABI calldata)?
 * Rejects addresses whose first 4 bytes are zero (filters 0x40, amounts, etc.).
 */
function isPlausibleWalletAddress(addr) {
  try {
    const hex = ethers.getAddress(addr).toLowerCase().replace(/^0x/, "");
    if (/^0+$/.test(hex)) return false;
    // First 4 bytes zero ⇒ almost always an ABI offset/length/amount, not an EOA
    if (hex.slice(0, 8) === "00000000") return false;
    // type(uint160).max / burn / sentinel — common in swap/approve calldata
    if (/^f+$/i.test(hex)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Known non-wallet contracts we should never auto-track as "new wallets". */
const SKIP_AUTO_TRACK = new Set(
  [
    "0xffffffffffffffffffffffffffffffffffffffff",
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
  ].map((a) => a.toLowerCase())
);

/**
 * Extract candidate recipient addresses from tx calldata.
 *
 * Drain pattern seen on Robinhood: empty wallet sends ETH to a helper CONTRACT
 * (e.g. 0x5b8d85...) whose input encodes the REAL new wallet, e.g.
 *   selector 0xe2f16e56 + address[] recipients + uint256[] amounts
 * So receipt.to is a contract and the true EOA is only in `tx.data`.
 */
function extractAddressesFromCalldata(data) {
  const found = [];
  if (!data || data === "0x" || data.length < 10) return found;

  const hex = data.toLowerCase().replace(/^0x/, "");
  // Skip 4-byte selector; scan 32-byte ABI words
  const body = hex.slice(8);
  for (let i = 0; i + 64 <= body.length; i += 64) {
    const word = body.slice(i, i + 64);
    // Standard ABI address encoding: 12 zero bytes + 20-byte address
    if (word.slice(0, 24) !== "0".repeat(24)) continue;
    const addr = "0x" + word.slice(24);
    if (!isPlausibleWalletAddress(addr)) continue;
    found.push(ethers.getAddress(addr).toLowerCase());
  }
  return [...new Set(found)];
}

/**
 * Resolve real destination wallet(s) for an outgoing drain tx.
 * 1) If receipt.to is EOA → that is the new wallet
 * 2) If receipt.to is a contract → decode EOAs from calldata (relay/batch drain)
 */
async function resolveNewWalletCandidates(txHash, emptyWallet) {
  const candidates = [];

  let receipt;
  let tx;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    console.error(
      `[DETECT] receipt fetch failed for tx ${txHash}: ${err.message || err}`
    );
    return candidates;
  }
  if (!receipt) {
    console.log(`[DETECT] No receipt yet for ${txHash}`);
    return candidates;
  }

  // Token create also handled here during empty-wallet sweep
  try {
    await detectTokenCreationFromTx(txHash, emptyWallet, "empty-scan");
  } catch (err) {
    console.error(
      `[TOKEN DEPLOY] empty-scan failed for ${txHash}: ${err.message || err}`
    );
  }

  try {
    tx = await provider.getTransaction(txHash);
  } catch (err) {
    console.error(
      `[DETECT] getTransaction failed for tx ${txHash}: ${err.message || err}`
    );
  }

  const to = (receipt.to || tx?.to || "").toLowerCase();
  const emptyNorm = emptyWallet.toLowerCase();

  // Path A: plain ETH transfer to an EOA
  if (to) {
    try {
      const code = await provider.getCode(to);
      if (code === "0x" || code === "0x0") {
        if (to !== emptyNorm && isPlausibleWalletAddress(to)) {
          console.log(
            `[DETECT] Direct EOA recipient ${to} in tx ${txHash}`
          );
          candidates.push(to);
        }
      } else {
        console.log(
          `[DETECT] tx.to ${to} is a CONTRACT — decoding real recipient from calldata`
        );
      }
    } catch (err) {
      console.error(
        `[DETECT] getCode failed for ${to} (tx ${txHash}): ${err.message || err}`
      );
    }
  }

  // Path B: addresses embedded in calldata (batch/relay drain helpers)
  const data = tx?.data || "0x";
  if (data && data !== "0x") {
    const embedded = extractAddressesFromCalldata(data);
    for (const addr of embedded) {
      if (addr === emptyNorm) continue;
      if (to && addr === to) continue; // skip the helper contract itself if listed

      let code;
      try {
        code = await provider.getCode(addr);
      } catch (err) {
        console.error(
          `[DETECT] getCode failed for calldata addr ${addr}: ${err.message || err}`
        );
        continue;
      }

      if (code === "0x" || code === "0x0") {
        console.log(
          `[DETECT] Calldata EOA recipient ${addr} in tx ${txHash}`
        );
        candidates.push(addr);
      } else {
        console.log(
          `[DETECT] Calldata address ${addr} is a contract — skip`
        );
      }
    }
  }

  return [...new Set(candidates)];
}

/**
 * For an empty wallet: inspect last 10 outgoing external txs.
 * - receipt.contractAddress set → token (or any contract) deploy
 * - receipt.to is EOA → new wallet
 * - receipt.to is contract with real EOA in calldata → new wallet (fixed)
 */
async function detectTokenDeploysAndNewWallets(emptyWallet, activityItems) {
  let transfers;
  try {
    transfers = await fetchRecentOutgoingExternal(
      emptyWallet,
      LAST_OUTGOING_SCAN_COUNT
    );
  } catch (err) {
    console.error(
      `[DETECT] getAssetTransfers failed for ${emptyWallet}: ${err.message || err}`
    );
    return;
  }

  const byHash = new Map();
  for (const t of transfers) {
    if (t.hash) byHash.set(t.hash.toLowerCase(), t);
  }
  for (const a of activityItems) {
    if (a.hash && !byHash.has(a.hash.toLowerCase())) {
      byHash.set(a.hash.toLowerCase(), {
        hash: a.hash,
        to: a.toAddress,
        asset: a.asset,
        category: a.category,
        value: a.value,
      });
    }
  }

  console.log(
    `[DETECT] Inspecting ${byHash.size} outgoing tx(s) from ${emptyWallet}`
  );

  for (const transfer of byHash.values()) {
    const txHash = transfer.hash;
    if (!txHash) continue;

    const asset = (transfer.asset || "").toUpperCase();
    const isEthAsset =
      !transfer.asset ||
      asset === "ETH" ||
      asset === "NATIVE" ||
      transfer.category === "external";

    // Token creates can be non-ETH txs too (deploy with 0 value)
    if (!isEthAsset) {
      try {
        await detectTokenCreationFromTx(txHash, emptyWallet, "empty-scan");
      } catch (err) {
        console.error(
          `[TOKEN DEPLOY] receipt/scan failed for tx ${txHash}: ${err.message || err}`
        );
      }
      continue;
    }

    console.log(
      `[DETECT] Analyzing ETH out tx ${txHash} (alchemy to=${transfer.to})`
    );

    let candidates;
    try {
      candidates = await resolveNewWalletCandidates(txHash, emptyWallet);
    } catch (err) {
      console.error(
        `[DETECT] resolve failed for ${txHash}: ${err.message || err}`
      );
      continue;
    }

    if (candidates.length === 0) {
      console.log(`[DETECT] No EOA recipient found in tx ${txHash}`);
      continue;
    }

    for (const newAddr of candidates) {
      console.log(
        `[NEW WALLET] Detected ${newAddr} from empty wallet ${emptyWallet} ` +
          `(tx ${txHash})`
      );
      await addWallet(newAddr, {
        source: "auto-detect",
        parent: emptyWallet,
      });
    }
  }
}

/**
 * Core "add wallet" flow used by POST /add-wallet and recursive detection.
 * @param {string} rawAddress
 * @param {{ source?: string, parent?: string }} meta
 */
async function addWallet(rawAddress, meta = {}) {
  let address;
  try {
    address = normalizeAddress(rawAddress);
  } catch {
    throw new Error(`Invalid address: ${rawAddress}`);
  }

  if (trackedWallets.has(address)) {
    console.log(`[TRACKER] Already tracking ${address}`);
    if (meta.label) setWalletLabel(address, meta.label);
    return {
      address,
      alreadyTracked: true,
      label: walletMeta.get(address)?.label || "",
    };
  }

  trackedWallets.add(address);
  const autoLabel =
    meta.label ||
    (meta.parent
      ? `Hop ← ${walletDisplay(meta.parent).slice(0, 20)}`
      : meta.source && String(meta.source).includes("auto")
        ? `Auto ${new Date().toISOString().slice(5, 16)}`
        : "");
  ensureWalletMeta(address, {
    label: autoLabel,
    source: meta.source || "api",
    parent: meta.parent || null,
  });
  saveWalletsDb();

  console.log(
    `[TRACKER] Added wallet ${address}` +
      (autoLabel ? ` label="${autoLabel}"` : "") +
      (meta.source ? ` (source=${meta.source}` : "") +
      (meta.parent ? ` parent=${meta.parent}` : "") +
      (meta.source ? ")" : "")
  );
  if (meta.source && String(meta.source).includes("auto")) {
    console.log(`[NEW WALLET] Auto-added ${address} to tracker`);
  }

  try {
    await fetchLastOutgoingTransfer(address);
  } catch (err) {
    console.error(
      `[TRACKER] last-outgoing fetch failed for ${address}: ${err.message || err}`
    );
  }

  await registerAddressOnWebhook(address);

  // Seed lastSeen for polling (always useful; required if webhooks unsupported)
  try {
    const response = await getAssetTransfers({
      fromAddress: address,
      category: ["external", "erc20"],
      order: "desc",
      maxCount: 1,
    });
    const hash = response.transfers?.[0]?.hash;
    if (hash) {
      lastSeenOutgoingHash.set(address, hash);
      console.log(`[POLLING] Seeded lastSeen for new wallet ${address} → ${hash}`);
    } else {
      lastSeenOutgoingHash.set(address, "");
    }
  } catch (err) {
    console.error(
      `[POLLING] Seed failed for ${address}: ${err.message || err}`
    );
  }

  // Always run polling as a safety net — webhooks alone missed hop wallets
  // when Alchemy delivered late or only contract `to` without empty-state race.
  enablePollingFallback(
    webhooksSupported === true
      ? "backup polling alongside webhook"
      : "webhook unavailable or unconfirmed"
  );

  saveWalletsDb();
  return {
    address,
    alreadyTracked: false,
    label: walletMeta.get(address)?.label || "",
  };
}

/**
 * Parse Alchemy ADDRESS_ACTIVITY webhook body and process each activity item.
 */
async function processWebhookPayload(body) {
  const event = body?.event || body;
  const activities = event?.activity || [];

  if (!Array.isArray(activities) || activities.length === 0) {
    console.log("[WEBHOOK] No activity items in payload");
    return;
  }

  console.log(`[WEBHOOK] Processing ${activities.length} activity item(s)`);

  /** @type {Map<string, object[]>} */
  const bySender = new Map();
  for (const item of activities) {
    const from = item.fromAddress || item.from;
    if (!from) continue;
    const key = from.toLowerCase();
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key).push(item);
  }

  for (const [sender, items] of bySender) {
    try {
      await handleActivityForSender(sender, items, "webhook");
    } catch (err) {
      console.error(
        `[WEBHOOK] handler error for ${sender}: ${err.message || err}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * POST /add-wallet
 * Body: { "address": "0x..." }
 */
app.post("/add-wallet", async (req, res) => {
  const address = req.body?.address;
  const label = req.body?.label;
  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "Body must include string 'address'" });
  }

  try {
    const result = await addWallet(address, { source: "api", label });
    return res.status(result.alreadyTracked ? 200 : 201).json({
      ok: true,
      ...result,
      trackedCount: trackedWallets.size,
      webhookId: addressActivityWebhookId,
      mode: webhooksSupported === true ? "webhook" : "polling",
    });
  } catch (err) {
    console.error(`[TRACKER] /add-wallet error: ${err.message || err}`);
    return res.status(400).json({ error: err.message || String(err) });
  }
});

/**
 * PATCH /wallet-label  Body: { address, label }
 */
app.patch("/wallet-label", (req, res) => {
  try {
    const meta = setWalletLabel(req.body?.address, req.body?.label || "");
    return res.json({ ok: true, ...meta });
  } catch (err) {
    return res.status(400).json({ error: err.message || String(err) });
  }
});

/**
 * DELETE /wallet  Body: { address }  or query ?address=
 */
app.delete("/wallet", async (req, res) => {
  try {
    const address = req.body?.address || req.query?.address;
    const result = await removeWallet(address);
    return res.json({ ok: true, ...result, trackedCount: trackedWallets.size });
  } catch (err) {
    return res.status(400).json({ error: err.message || String(err) });
  }
});

/**
 * GET /wallets
 */
app.get("/wallets", (_req, res) => {
  const wallets = [...trackedWallets].map((a) => {
    const m = walletMeta.get(a) || {};
    return {
      address: a,
      label: m.label || "",
      note: m.note || "",
      addedAt: m.addedAt || null,
      source: m.source || null,
      parent: m.parent || null,
    };
  });
  res.json({
    wallets,
    addresses: [...trackedWallets],
    count: trackedWallets.size,
    webhookId: addressActivityWebhookId,
    webhooksSupported,
    mode: webhooksSupported === true ? "webhook" : "polling",
    chainId: CHAIN_ID_MAINNET,
    network: ROBINHOOD_NETWORK_SLUG,
  });
});

/**
 * POST /webhook
 * Alchemy Notify receiver — respond 200 immediately, process async.
 */
app.post("/webhook", (req, res) => {
  res.status(200).json({ ok: true });
  console.log("[WEBHOOK] Received event");
  setImmediate(() => {
    processWebhookPayload(req.body).catch((err) => {
      console.error(`[WEBHOOK] async processing failed: ${err.message || err}`);
    });
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    chainId: CHAIN_ID_MAINNET,
    network: ROBINHOOD_NETWORK_SLUG,
  });
});

/**
 * GET /alerts — last N transfer alerts (from alerts.log)
 * Query: ?limit=50
 */
app.get("/alerts", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 500);
  try {
    if (!fs.existsSync(ALERTS_LOG_PATH)) {
      return res.json({ alerts: [], count: 0 });
    }
    const lines = fs
      .readFileSync(ALERTS_LOG_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const slice = lines.slice(-limit);
    const alerts = slice
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .reverse();
    return res.json({ alerts, count: alerts.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * GET /balances — ETH balances for all tracked wallets
 * GET /balances?address=0x... — detail one wallet (+ tokens if API allows)
 */
app.get("/balances", async (req, res) => {
  try {
    const one = req.query.address;
    if (one) {
      const info = await fetchWalletBalances(String(one));
      return res.json({ ok: true, ...info });
    }
    const list = [...trackedWallets];
    const wallets = [];
    let totalEth = 0;
    for (const a of list) {
      try {
        const wei = await provider.getBalance(a);
        const eth = ethers.formatEther(wei);
        totalEth += Number(eth);
        wallets.push({
          address: a,
          label: walletMeta.get(a)?.label || "",
          eth,
          ethShort: formatEthShort(wei, true),
        });
      } catch (e) {
        wallets.push({
          address: a,
          label: walletMeta.get(a)?.label || "",
          error: e.message || String(e),
        });
      }
    }
    wallets.sort((a, b) => Number(b.eth || 0) - Number(a.eth || 0));
    const trading = await fetchTradingWalletBalance();
    return res.json({
      ok: true,
      count: wallets.length,
      totalEth,
      wallets,
      tradingWallet: trading,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Telegram bot — buttons + labels + commands
// ---------------------------------------------------------------------------

/** Persistent bottom keyboard — best daily actions */
function mainReplyKeyboard() {
  const amt = process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
  return {
    keyboard: [
      [{ text: "📋 Wallets" }, { text: "🚨 Alertes" }, { text: "📊 Status" }],
      [{ text: "➕ Ajouter" }, { text: "🛒 AutoBuy" }, { text: `💵 ${amt} ETH` }],
      [{ text: "⚙️ Config" }, { text: "💰 Balance" }, { text: "ℹ️ Aide" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** Inline keyboard to pick buy amount (saved as AUTO_BUY_ETH_AMOUNT) */
function amountPickKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "0.0005", callback_data: "cfg:amt:0.0005" },
        { text: "0.001", callback_data: "cfg:amt:0.001" },
        { text: "0.002", callback_data: "cfg:amt:0.002" },
      ],
      [
        { text: "0.005", callback_data: "cfg:amt:0.005" },
        { text: "0.01", callback_data: "cfg:amt:0.01" },
        { text: "0.02", callback_data: "cfg:amt:0.02" },
      ],
      [
        { text: "0.05", callback_data: "cfg:amt:0.05" },
        { text: "0.1", callback_data: "cfg:amt:0.1" },
        { text: "✏️ Autre", callback_data: "cfg:amt:custom" },
      ],
    ],
  };
}

/** Buy buttons on a token alert — amount embedded in callback */
function tokenBuyKeyboard(tokenAddress) {
  const t = tokenAddress.toLowerCase();
  // callback max 64 bytes: "buy:0.001:0x..." ≈ 52
  return {
    inline_keyboard: [
      [
        { text: "🛒 0.001", callback_data: `buy:0.001:${t}` },
        { text: "🛒 0.005", callback_data: `buy:0.005:${t}` },
        { text: "🛒 0.01", callback_data: `buy:0.01:${t}` },
      ],
      [
        { text: "🛒 montant config", callback_data: `buy:cfg:${t}` },
        { text: "💵 Changer montant", callback_data: "menu:amount" },
      ],
    ],
  };
}

async function tgShowAmount(chatId) {
  const cur = process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
  await sendTelegram(
    `💵 Montant d’achat auto\n\n` +
      `Actuel : **${cur} ETH** par token lancé\n\n` +
      `Choisis un montant ci-dessous, ou :\n` +
      `/amount 0.003\n` +
      `/buy 0xTOKEN 0.01  (achat one-shot)`,
    chatId,
    { reply_markup: amountPickKeyboard() }
  );
}

function isEnvOn(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function setEnvRuntime(key, value) {
  process.env[key] = String(value);
  // Persist into .env (best-effort)
  try {
    const envPath = path.join(__dirname, ".env");
    let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) {
      text = text.replace(re, `${key}=${value}`);
    } else {
      text = text.trimEnd() + `\n${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, text);
  } catch (err) {
    console.warn(`[TRACKER] could not persist ${key}: ${err.message}`);
  }
}

function autoBuyConfigText() {
  const sl = Number(process.env.AUTO_BUY_STOP_LOSS || "40");
  return (
    `🛒 Auto-buy: ${isEnvOn("AUTO_BUY_ENABLED") ? "ON ✅" : "OFF ⏸"}\n` +
    `Montant: ${process.env.AUTO_BUY_ETH_AMOUNT || "0.001"} ETH\n` +
    `Slippage: ${process.env.AUTO_BUY_SLIPPAGE || "3"}%\n` +
    `Take-profit: +${process.env.AUTO_BUY_TAKE_PROFIT || "100"}%\n` +
    `Stop-loss: ${sl > 0 ? `-${sl}% 🛑` : "off"}\n` +
    `Watch PnL: ${isEnvOn("AUTO_BUY_AUTO_WATCH", true) ? "oui" : "non"}\n` +
    `Dry-run: ${isEnvOn("AUTO_BUY_DRY_RUN") ? "oui 🧪" : "non (réel)"}\n` +
    `AMM only: ${isEnvOn("AUTO_BUY_AMM_ONLY", true) ? "oui" : "non"}`
  );
}

async function registerTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;
  const commands = [
    { command: "start", description: "Menu + boutons" },
    { command: "help", description: "Toutes les commandes" },
    { command: "status", description: "État du bot (RPC, wallets, autobuy)" },
    { command: "wallets", description: "Liste des wallets suivis" },
    { command: "add", description: "Ajouter: /add 0x... [label]" },
    { command: "label", description: "Renommer: /label 0x... Nom" },
    { command: "remove", description: "Retirer: /remove 0x..." },
    { command: "alerts", description: "Dernières alertes" },
    { command: "balance", description: "Balances (tous ou /balance 0x)" },
    { command: "buy", description: "Achat manuel: /buy 0xTOKEN [ETH]" },
    { command: "autobuy", description: "Auto-buy: /autobuy on|off" },
    { command: "amount", description: "Montant auto: /amount 0.001" },
    { command: "slippage", description: "Slippage %: /slippage 3" },
    { command: "tp", description: "Take-profit %: /tp 100" },
    { command: "sl", description: "Stop-loss %: /sl 40 (0=off)" },
    { command: "dryrun", description: "Dry-run: /dryrun on|off" },
    { command: "config", description: "Config auto-buy" },
    { command: "scan", description: "Scan hops/tokens: /scan 0x..." },
    { command: "export", description: "Exporter adresses" },
    { command: "ping", description: "Health check" },
  ];
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (data.ok) console.log("[TELEGRAM] command menu registered");
    else
      console.warn(
        `[TELEGRAM] setMyCommands: ${data.description || res.status}`
      );
  } catch (err) {
    console.warn(`[TELEGRAM] setMyCommands failed: ${err.message}`);
  }
}

/** Inline buttons for wallet list (max ~8 to stay readable) */
function walletsInlineKeyboard() {
  const list = [...trackedWallets];
  const rows = [];
  for (const a of list.slice(0, 12)) {
    const label = walletMeta.get(a)?.label;
    const short = label
      ? `${label.slice(0, 16)}`
      : `${a.slice(0, 6)}…${a.slice(-4)}`;
    rows.push([
      { text: `🔎 ${short}`, callback_data: `in:${a}` },
      { text: "🏷️", callback_data: `lb:${a}` },
      { text: "🗑", callback_data: `rm:${a}` },
    ]);
  }
  rows.push([
    { text: "➕ Ajouter wallet", callback_data: "menu:add" },
    { text: "🔄 Refresh", callback_data: "menu:wallets" },
  ]);
  return { inline_keyboard: rows };
}

function walletDetailKeyboard(address) {
  return {
    inline_keyboard: [
      [
        { text: "🏷️ Renommer", callback_data: `lb:${address}` },
        { text: "💰 Balance", callback_data: `bal:${address}` },
      ],
      [
        { text: "🗑 Retirer", callback_data: `rm:${address}` },
        { text: "« Liste", callback_data: "menu:wallets" },
      ],
    ],
  };
}

/**
 * Send a text message (optional reply_markup: reply or inline keyboard).
 */
async function sendTelegram(text, chatId = TELEGRAM_CHAT_ID, extra = {}) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const body = {
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
      ...extra,
    };
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.error(
        `[TELEGRAM] send failed: ${data.description || res.status}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[TELEGRAM] send error: ${err.message || err}`);
    return false;
  }
}

async function answerCallback(callbackQueryId, text = "") {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text.slice(0, 200),
          show_alert: false,
        }),
      }
    );
  } catch {
    /* ignore */
  }
}

function isAuthorizedChat(chatId) {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

async function tgShowHelp(chatId) {
  await sendTelegram(
    `🤖 Robinhood Wallet Tracker — commandes\n\n` +
      `📌 Suivi\n` +
      `/add 0x... [label] — suivre un wallet\n` +
      `/wallets — liste + boutons\n` +
      `/label 0x... Nom — renommer\n` +
      `/remove 0x... — arrêter le suivi\n` +
      `/balance — soldes ETH de tous les wallets\n` +
      `/balance 0x... — détail ETH + tokens\n` +
      `/scan 0x... — scan hops / tokens (si vide)\n` +
      `/export — copier toutes les adresses\n\n` +
      `🚨 Alertes\n` +
      `/alerts — derniers events\n` +
      `/status — état bot + RPC + autobuy\n` +
      `/ping — health\n\n` +
      `🛒 Trading auto\n` +
      `/buy 0xTOKEN [montantETH] — achat manuel\n` +
      `/autobuy on|off — activer achat auto au launch\n` +
      `/amount 0.001 — ETH par auto-buy\n` +
      `/slippage 3 — slippage %\n` +
      `/tp 100 — take-profit % (100=x2)\n` +
      `/sl 40 — stop-loss % (vend si -40%, 0=off)\n` +
      `/dryrun on|off — simuler sans broadcast\n` +
      `/config — config auto-buy\n\n` +
      `${autoBuyConfigText()}\n\n` +
      `Astuce: envoie juste 0x... pour ajouter un wallet.\n` +
      `Menu / en bas de l’écran pour les commandes.`,
    chatId,
    { reply_markup: mainReplyKeyboard() }
  );
}

async function tgShowStatus(chatId) {
  let rpcOk = "?";
  let chain = "?";
  try {
    const id = await alchemyRpc("eth_chainId", []);
    chain = String(Number(id));
    rpcOk = "OK";
  } catch (e) {
    rpcOk = `ERR ${e.message || e}`;
  }
  await sendTelegram(
    `📊 STATUS\n\n` +
      `RPC: ${rpcOk} (chain ${chain})\n` +
      `Wallets: ${trackedWallets.size}\n` +
      `Mode: ${webhooksSupported === true ? "webhook+polling" : "polling"}\n` +
      `Webhook: ${addressActivityWebhookId || "—"}\n` +
      `Port: ${PORT}\n` +
      `Network: ${ROBINHOOD_NETWORK_SLUG}\n\n` +
      `${autoBuyConfigText()}`,
    chatId,
    { reply_markup: mainReplyKeyboard() }
  );
}

async function tgShowConfig(chatId) {
  const cur = process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
  await sendTelegram(
    `⚙️ CONFIG\n\n${autoBuyConfigText()}\n\n` +
      `💵 Montant achat : ${cur} ETH\n\n` +
      `Changer:\n` +
      `/amount 0.001\n` +
      `/autobuy on|off\n` +
      `/slippage 3\n` +
      `/tp 100 · /sl 40\n` +
      `/dryrun on|off`,
    chatId,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛒 ON", callback_data: "cfg:buy:on" },
            { text: "⏸ OFF", callback_data: "cfg:buy:off" },
          ],
          [
            { text: "🧪 Dry ON", callback_data: "cfg:dry:on" },
            { text: "🔥 Dry OFF", callback_data: "cfg:dry:off" },
          ],
          [
            { text: "💵 0.001", callback_data: "cfg:amt:0.001" },
            { text: "💵 0.005", callback_data: "cfg:amt:0.005" },
            { text: "💵 0.01", callback_data: "cfg:amt:0.01" },
          ],
          [
            { text: "💵 0.02", callback_data: "cfg:amt:0.02" },
            { text: "💵 0.05", callback_data: "cfg:amt:0.05" },
            { text: "💵 0.1", callback_data: "cfg:amt:0.1" },
          ],
          [{ text: "✏️ Autre montant", callback_data: "cfg:amt:custom" }],
          [
            { text: "SL 30%", callback_data: "cfg:sl:30" },
            { text: "SL 40%", callback_data: "cfg:sl:40" },
            { text: "SL 50%", callback_data: "cfg:sl:50" },
            { text: "SL off", callback_data: "cfg:sl:0" },
          ],
          [{ text: "📊 Status", callback_data: "menu:status" }],
        ],
      },
    }
  );
}

/** Format ETH for display (trim trailing zeros) */
function formatEthShort(weiOrEther, isWei = true) {
  try {
    const eth = isWei
      ? Number(ethers.formatEther(weiOrEther))
      : Number(weiOrEther);
    if (!Number.isFinite(eth)) return "?";
    if (eth === 0) return "0";
    if (eth < 0.0001) return eth.toExponential(2);
    if (eth < 1) return eth.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return eth.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  } catch {
    return "?";
  }
}

/**
 * Fetch ETH balance (+ optional ERC20 balances via alchemy getTokenBalances if available).
 */
async function fetchWalletBalances(address) {
  const a = normalizeAddress(address);
  const ethWei = await provider.getBalance(a);
  const eth = ethers.formatEther(ethWei);
  /** @type {{ symbol: string, address: string, balance: string }[]} */
  let tokens = [];

  // Alchemy enhanced: alchemy_getTokenBalances
  try {
    const res = await alchemyRpc("alchemy_getTokenBalances", [a, "erc20"]);
    const rows = res?.tokenBalances || [];
    for (const row of rows.slice(0, 25)) {
      const raw = row.tokenBalance;
      if (!raw || raw === "0x0" || raw === "0x") continue;
      const contract = (row.contractAddress || "").toLowerCase();
      if (!contract) continue;
      let decimals = 18;
      let symbol = contract.slice(0, 8) + "…";
      try {
        const meta = await readErc20Metadata(contract);
        if (meta.decimals != null) decimals = meta.decimals;
        if (meta.symbol) symbol = meta.symbol;
      } catch {
        /* */
      }
      let balHuman = "?";
      try {
        balHuman = ethers.formatUnits(BigInt(raw), decimals);
        const n = Number(balHuman);
        if (n === 0) continue;
        if (n < 0.0001) continue; // dust
        balHuman =
          n >= 1
            ? n.toFixed(2).replace(/\.00$/, "")
            : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
      } catch {
        continue;
      }
      tokens.push({ symbol, address: contract, balance: balHuman });
    }
    // biggest first (rough numeric)
    tokens.sort((x, y) => Number(y.balance) - Number(x.balance));
    tokens = tokens.slice(0, 12);
  } catch (err) {
    console.log(
      `[BALANCE] tokenBalances unavailable for ${a}: ${err.message || err}`
    );
  }

  return {
    address: a,
    eth,
    ethShort: formatEthShort(ethWei, true),
    tokens,
    tracked: trackedWallets.has(a),
    label: walletMeta.get(a)?.label || "",
  };
}

/** Trading wallet from uniswap bot PRIVATE_KEY (if configured) */
async function fetchTradingWalletBalance() {
  try {
    const botPath =
      process.env.UNISWAP_BOT_PATH ||
      path.resolve(__dirname, "..", "robinhood-uniswap-bot");
    const envPath = path.join(botPath, ".env");
    if (!fs.existsSync(envPath)) return null;
    const text = fs.readFileSync(envPath, "utf8");
    const m = text.match(/^PRIVATE_KEY=(.+)$/m);
    if (!m) return null;
    let pk = m[1].trim().replace(/^["']|["']$/g, "");
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    if (pk.length < 66) return null;
    const w = new ethers.Wallet(pk);
    const info = await fetchWalletBalances(w.address);
    return { ...info, isTrading: true };
  } catch (err) {
    console.warn(`[BALANCE] trading wallet: ${err.message || err}`);
    return null;
  }
}

async function tgShowBalance(chatId, address) {
  try {
    const info = await fetchWalletBalances(address);
    let tokenBlock = "";
    if (info.tokens.length) {
      tokenBlock =
        "\n\nTokens:\n" +
        info.tokens
          .map((t) => `• ${t.symbol}: ${t.balance}\n  ${t.address}`)
          .join("\n");
    } else {
      tokenBlock = "\n\nTokens: (aucun ERC-20 détecté / API limitée)";
    }
    await sendTelegram(
      `💰 Balance\n` +
        `${walletLine(info.address)}\n\n` +
        `ETH: ${info.ethShort}\n` +
        `(${info.eth} exact)\n` +
        `suivi: ${info.tracked ? "oui" : "non"}` +
        tokenBlock,
      chatId,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Refresh", callback_data: `bal:${info.address}` },
              { text: "📋 Tous", callback_data: "menu:balances" },
            ],
          ],
        },
      }
    );
  } catch (err) {
    await sendTelegram(`❌ ${err.message || err}`, chatId);
  }
}

/**
 * Show ETH balances for all tracked wallets (+ trading wallet if available).
 */
async function tgShowAllBalances(chatId) {
  await sendTelegram("💰 Chargement des balances…", chatId);
  try {
    const list = [...trackedWallets];
    if (list.length === 0) {
      await sendTelegram(
        "Aucun wallet suivi.\n/add 0x... d’abord",
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
      return;
    }

    const rows = [];
    let total = 0;
    // sequential to avoid rate limits
    for (const a of list) {
      try {
        const wei = await provider.getBalance(a);
        const eth = Number(ethers.formatEther(wei));
        total += eth;
        rows.push({
          address: a,
          label: walletMeta.get(a)?.label || "",
          eth,
          short: formatEthShort(wei, true),
        });
      } catch {
        rows.push({
          address: a,
          label: walletMeta.get(a)?.label || "",
          eth: -1,
          short: "ERR",
        });
      }
    }
    rows.sort((a, b) => b.eth - a.eth);

    let body = rows
      .map((r, i) => {
        const tag = r.label ? `🏷️ ${r.label}` : r.address.slice(0, 8) + "…";
        return `${i + 1}. ${tag}\n   ${r.short} ETH\n   ${r.address}`;
      })
      .join("\n\n");

    // Trading wallet (auto-buy)
    const trade = await fetchTradingWalletBalance();
    let tradeBlock = "";
    if (trade) {
      tradeBlock =
        `\n\n🛒 Wallet trading (auto-buy)\n` +
        `${trade.ethShort} ETH\n` +
        `${trade.address}`;
      if (trade.tokens?.length) {
        tradeBlock +=
          "\n" +
          trade.tokens
            .slice(0, 6)
            .map((t) => `• ${t.symbol}: ${t.balance}`)
            .join("\n");
      }
    }

    // Inline: top wallets for detail
    const kb = {
      inline_keyboard: [
        ...rows.slice(0, 8).map((r) => [
          {
            text: `${r.short} Ξ ${r.label || r.address.slice(0, 6)}`,
            callback_data: `bal:${r.address}`,
          },
        ]),
        [{ text: "🔄 Refresh", callback_data: "menu:balances" }],
      ],
    };

    await sendTelegram(
      `💰 Balances ETH — ${rows.length} wallets\n` +
        `Total suivi ≈ ${formatEthShort(String(total), false)} ETH\n\n` +
        body +
        tradeBlock +
        `\n\nTape /balance 0x... pour le détail tokens`,
      chatId,
      { reply_markup: kb }
    );
  } catch (err) {
    await sendTelegram(`❌ ${err.message || err}`, chatId);
  }
}

/** Manual buy (forces enable + optional amount for this call only) */
async function tgManualBuy(chatId, token, amountEth) {
  const amt = amountEth || process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
  const prevAmt = process.env.AUTO_BUY_ETH_AMOUNT;
  const prevEnabled = process.env.AUTO_BUY_ENABLED;
  process.env.AUTO_BUY_ENABLED = "true";
  process.env.AUTO_BUY_ETH_AMOUNT = String(amt);
  try {
    const { boughtTokens } = require("./auto-buy");
    boughtTokens.delete(String(token).toLowerCase());
    await sendTelegram(
      `🛒 Achat manuel…\n${token}\n${amt} ETH`,
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    const result = await maybeAutoBuyToken({
      tokenAddress: token,
      symbol: "MANUAL",
      name: "Manual buy",
      launchpad: true,
      isErc20Like: true,
      fromCreate: true,
      notify: (msg) =>
        sendTelegram(msg, chatId, { reply_markup: mainReplyKeyboard() }),
    });
    if (result?.skipped) {
      await sendTelegram(
        `ℹ️ Buy skip: ${result.reason}` +
          (result.reason === "bot-missing"
            ? "\nVérifie UNISWAP_BOT_PATH"
            : ""),
        chatId
      );
    }
  } catch (err) {
    await sendTelegram(`❌ Buy failed: ${err.message || err}`, chatId);
  } finally {
    if (prevAmt !== undefined) process.env.AUTO_BUY_ETH_AMOUNT = prevAmt;
    if (prevEnabled !== undefined) process.env.AUTO_BUY_ENABLED = prevEnabled;
  }
}

async function tgShowWallets(chatId) {
  const list = [...trackedWallets];
  if (list.length === 0) {
    await sendTelegram(
      "Aucun wallet suivi.\nAppuie sur ➕ Ajouter ou envoie une adresse 0x...",
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }
  const body = list
    .map((a, i) => {
      const m = walletMeta.get(a) || {};
      const tag = m.label ? `🏷️ ${m.label}` : "—";
      return `${i + 1}. ${tag}\n   \`${a}\``;
    })
    .join("\n\n");
  await sendTelegram(
    `📋 Wallets suivis (${list.length})\n\n${body}\n\n` +
      `mode=${webhooksSupported === true ? "webhook" : "polling"}`,
    chatId,
    { reply_markup: walletsInlineKeyboard() }
  );
}

async function tgShowAlerts(chatId) {
  try {
    if (!fs.existsSync(ALERTS_LOG_PATH)) {
      await sendTelegram("Aucune alerte pour l’instant.", chatId, {
        reply_markup: mainReplyKeyboard(),
      });
      return;
    }
    const lines = fs
      .readFileSync(ALERTS_LOG_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-10)
      .reverse();
    if (lines.length === 0) {
      await sendTelegram("Aucune alerte pour l’instant.", chatId, {
        reply_markup: mainReplyKeyboard(),
      });
      return;
    }
    const parts = lines.map((line, i) => {
      try {
        const a = JSON.parse(line);
        if (a.type === "TOKEN_DEPLOY") {
          return (
            `${i + 1}. 🪙 TOKEN ${a.symbol || "?"} (${a.name || "?"})\n` +
            `   ${a.contractAddress}\n` +
            `   by ${walletDisplay(a.deployer)}`
          );
        }
        if (a.type === "NEW_WALLET" || a.direction === undefined && a.new) {
          return `${i + 1}. 🆕 ${a.new || a.address}`;
        }
        const dir = a.direction === "IN" ? "⬅️ REÇU" : "➡️ ENVOYÉ";
        return (
          `${i + 1}. ${dir} ${a.value} ${a.asset}\n` +
          `   ${walletDisplay(a.wallet)}\n` +
          `   ${a.from} → ${a.to}`
        );
      } catch {
        return `${i + 1}. ${line.slice(0, 120)}`;
      }
    });
    await sendTelegram(`🚨 Dernières alertes\n\n${parts.join("\n\n")}`, chatId, {
      reply_markup: mainReplyKeyboard(),
    });
  } catch (err) {
    await sendTelegram(`❌ ${err.message || err}`, chatId);
  }
}

async function tgShowWalletInfo(chatId, address) {
  const a = address.toLowerCase();
  if (!trackedWallets.has(a)) {
    await sendTelegram("Wallet non suivi.", chatId);
    return;
  }
  const m = walletMeta.get(a) || {};
  let bal = "?";
  try {
    bal = ethers.formatEther(await provider.getBalance(a));
  } catch {
    /* */
  }
  await sendTelegram(
    `🔎 Détail wallet\n\n` +
      `🏷️ Label : ${m.label || "(aucun)"}\n` +
      `Adresse : ${a}\n` +
      `Balance : ${bal} ETH\n` +
      `Source : ${m.source || "—"}\n` +
      `Parent : ${m.parent || "—"}\n` +
      `Ajouté : ${m.addedAt || "—"}`,
    chatId,
    { reply_markup: walletDetailKeyboard(a) }
  );
}

async function tgPromptAdd(chatId) {
  tgPending.set(String(chatId), { action: "add" });
  await sendTelegram(
    "➕ Envoie l’adresse du wallet à suivre\n" +
      "Format : `0x...`\n" +
      "Ou : `0x... MonLabel`",
    chatId,
    { reply_markup: mainReplyKeyboard() }
  );
}

async function tgPromptLabel(chatId, address) {
  tgPending.set(String(chatId), { action: "label", address });
  await sendTelegram(
    `🏷️ Nouveau nom pour\n${address}\n\nEnvoie le label (ex: Whale1, Drain3) :`,
    chatId
  );
}

/**
 * Handle inline button presses.
 */
async function handleTelegramCallback(cq) {
  const chatId = String(cq.message?.chat?.id ?? "");
  const data = cq.data || "";
  const qid = cq.id;

  if (!isAuthorizedChat(chatId)) {
    await answerCallback(qid, "Non autorisé");
    return;
  }

  console.log(`[TELEGRAM] callback ${data}`);

  if (data === "menu:wallets") {
    await answerCallback(qid);
    await tgShowWallets(chatId);
    return;
  }
  if (data === "menu:alerts") {
    await answerCallback(qid);
    await tgShowAlerts(chatId);
    return;
  }
  if (data === "menu:add") {
    await answerCallback(qid, "Envoie une adresse");
    await tgPromptAdd(chatId);
    return;
  }
  if (data === "menu:help") {
    await answerCallback(qid);
    await tgShowHelp(chatId);
    return;
  }
  if (data === "menu:status") {
    await answerCallback(qid);
    await tgShowStatus(chatId);
    return;
  }
  if (data === "menu:balances") {
    await answerCallback(qid);
    await tgShowAllBalances(chatId);
    return;
  }
  if (data === "menu:config") {
    await answerCallback(qid);
    await tgShowConfig(chatId);
    return;
  }
  if (data.startsWith("cfg:buy:")) {
    const on = data.endsWith(":on");
    setEnvRuntime("AUTO_BUY_ENABLED", on ? "true" : "false");
    await answerCallback(qid, on ? "Auto-buy ON" : "Auto-buy OFF");
    await tgShowConfig(chatId);
    return;
  }
  if (data.startsWith("cfg:dry:")) {
    const on = data.endsWith(":on");
    setEnvRuntime("AUTO_BUY_DRY_RUN", on ? "true" : "false");
    await answerCallback(qid, on ? "Dry-run ON" : "Dry-run OFF");
    await tgShowConfig(chatId);
    return;
  }
  if (data === "menu:amount") {
    await answerCallback(qid);
    await tgShowAmount(chatId);
    return;
  }
  if (data.startsWith("cfg:amt:")) {
    const amt = data.slice("cfg:amt:".length);
    if (amt === "custom") {
      tgPending.set(String(chatId), { action: "amount" });
      await answerCallback(qid, "Envoie le montant");
      await sendTelegram(
        "✏️ Envoie le montant ETH (ex: 0.003 ou 0.015)",
        chatId
      );
      return;
    }
    setEnvRuntime("AUTO_BUY_ETH_AMOUNT", amt);
    await answerCallback(qid, `${amt} ETH`);
    await sendTelegram(
      `✅ Montant d’achat = ${amt} ETH\n\n${autoBuyConfigText()}`,
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }
  // Quick buy from token alert: buy:0.001:0x... or buy:cfg:0x...
  if (data.startsWith("buy:")) {
    const rest = data.slice(4);
    const parts = rest.split(":");
    if (parts.length >= 2) {
      const amtKey = parts[0];
      const token = parts.slice(1).join(":");
      const amt =
        amtKey === "cfg"
          ? process.env.AUTO_BUY_ETH_AMOUNT || "0.001"
          : amtKey;
      await answerCallback(qid, `Buy ${amt} ETH`);
      if (!/^0x[a-f0-9]{40}$/.test(token)) {
        await sendTelegram("❌ Token invalide", chatId);
        return;
      }
      await tgManualBuy(chatId, token, amt);
      return;
    }
  }
  if (data.startsWith("cfg:sl:")) {
    const sl = data.slice("cfg:sl:".length);
    setEnvRuntime("AUTO_BUY_STOP_LOSS", sl);
    try {
      const botEnv = path.join(
        process.env.UNISWAP_BOT_PATH ||
          path.resolve(__dirname, "..", "robinhood-uniswap-bot"),
        ".env"
      );
      if (fs.existsSync(botEnv)) {
        let t = fs.readFileSync(botEnv, "utf8");
        if (/^STOP_LOSS_PCT=/m.test(t)) {
          t = t.replace(/^STOP_LOSS_PCT=.*$/m, `STOP_LOSS_PCT=${sl}`);
        } else {
          t = t.trimEnd() + `\nSTOP_LOSS_PCT=${sl}\n`;
        }
        fs.writeFileSync(botEnv, t);
      }
    } catch {
      /* */
    }
    await answerCallback(
      qid,
      Number(sl) > 0 ? `SL -${sl}%` : "SL off"
    );
    await tgShowConfig(chatId);
    return;
  }

  if (data.startsWith("in:")) {
    const addr = data.slice(3);
    await answerCallback(qid);
    await tgShowWalletInfo(chatId, addr);
    return;
  }
  if (data.startsWith("lb:")) {
    const addr = data.slice(3);
    await answerCallback(qid, "Envoie le label");
    await tgPromptLabel(chatId, addr);
    return;
  }
  if (data.startsWith("bal:")) {
    const addr = data.slice(4);
    await answerCallback(qid);
    try {
      const bal = ethers.formatEther(await provider.getBalance(addr));
      await sendTelegram(
        `💰 ${walletDisplay(addr)}\n${addr}\n\nBalance : ${bal} ETH`,
        chatId,
        { reply_markup: walletDetailKeyboard(addr) }
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }
  if (data.startsWith("rm:")) {
    const addr = data.slice(3);
    try {
      const r = await removeWallet(addr);
      await answerCallback(qid, r.removed ? "Retiré" : "Introuvable");
      await sendTelegram(
        r.removed
          ? `🗑 Retiré\n${addr}\nTotal : ${trackedWallets.size}`
          : `Wallet déjà absent.`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
      if (r.removed) await tgShowWallets(chatId);
    } catch (err) {
      await answerCallback(qid, "Erreur");
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  await answerCallback(qid, "Action inconnue");
}

/**
 * Handle one incoming Telegram message (commands + buttons + pending).
 */
async function handleTelegramMessage(msg) {
  const chatId = String(msg.chat?.id ?? "");
  const text = (msg.text || "").trim();
  if (!text) return;

  if (!isAuthorizedChat(chatId)) {
    console.warn(`[TELEGRAM] ignored unauthorized chat ${chatId}`);
    await sendTelegram("⛔ Chat non autorisé pour ce bot tracker.", chatId);
    return;
  }

  // Reply-keyboard button labels (exact match)
  if (text === "📋 Wallets" || text === "Wallets") {
    await tgShowWallets(chatId);
    return;
  }
  if (text === "🚨 Alertes" || text === "Alertes") {
    await tgShowAlerts(chatId);
    return;
  }
  if (text === "📊 Status" || text === "Status") {
    await tgShowStatus(chatId);
    return;
  }
  if (text === "➕ Ajouter" || text === "Ajouter") {
    await tgPromptAdd(chatId);
    return;
  }
  if (text === "🛒 AutoBuy" || text === "AutoBuy") {
    await tgShowConfig(chatId);
    return;
  }
  // Button shows current amount e.g. "💵 0.001 ETH"
  if (
    text === "💵 Montant" ||
    text.startsWith("💵 ") ||
    text === "Montant"
  ) {
    await tgShowAmount(chatId);
    return;
  }
  if (text === "💰 Balance" || text === "Balance") {
    await tgShowAllBalances(chatId);
    return;
  }
  if (text === "⚙️ Config" || text === "Config") {
    await tgShowConfig(chatId);
    return;
  }
  if (text === "🏷️ Labels" || text === "Labels") {
    await tgShowWallets(chatId);
    await sendTelegram(
      "Appuie sur 🏷️ à côté d’un wallet pour le renommer.\n" +
        "Ou : /label 0x... MonNom",
      chatId
    );
    return;
  }
  if (text === "ℹ️ Aide" || text === "Aide") {
    await tgShowHelp(chatId);
    return;
  }

  // Pending multi-step (add / label)
  const pending = tgPending.get(String(chatId));
  if (pending?.action === "label") {
    tgPending.delete(String(chatId));
    try {
      const meta = setWalletLabel(pending.address, text);
      await sendTelegram(
        `✅ Label enregistré\n🏷️ ${meta.label}\n${meta.address}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
      await tgShowWalletInfo(chatId, meta.address);
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }
  if (pending?.action === "add") {
    const m = text.match(/^(0x[a-fA-F0-9]{40})(?:\s+(.+))?$/);
    if (!m) {
      await sendTelegram(
        "Format invalide. Envoie :\n0xTonAdresse\nou\n0xTonAdresse MonLabel",
        chatId
      );
      return;
    }
    tgPending.delete(String(chatId));
    try {
      const result = await addWallet(m[1], {
        source: "telegram",
        label: m[2] || "",
      });
      await sendTelegram(
        result.alreadyTracked
          ? `ℹ️ Déjà suivi\n${walletLine(result.address)}`
          : `✅ Ajouté\n${walletLine(result.address)}\nTotal : ${trackedWallets.size}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }
  if (pending?.action === "balance") {
    const m = text.match(/^(0x[a-fA-F0-9]{40})$/);
    if (!m) {
      await sendTelegram("Envoie une adresse 0x… valide", chatId);
      return;
    }
    tgPending.delete(String(chatId));
    await tgShowBalance(chatId, m[1]);
    return;
  }
  if (pending?.action === "amount") {
    const m = text.replace(",", ".").match(/^([0-9]*\.?[0-9]+)$/);
    if (!m || Number(m[1]) <= 0) {
      await sendTelegram(
        "Montant invalide. Exemple : 0.001 ou 0.025",
        chatId
      );
      return;
    }
    tgPending.delete(String(chatId));
    setEnvRuntime("AUTO_BUY_ETH_AMOUNT", m[1]);
    await sendTelegram(
      `✅ Montant d’achat = ${m[1]} ETH\n\n${autoBuyConfigText()}`,
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }

  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split("@")[0];

  console.log(`[TELEGRAM] cmd=${cmd} args=${args.join(" ")}`);

  if (cmd === "/start") {
    await sendTelegram(
      `🟢 Tracker prêt\n${trackedWallets.size} wallet(s)\n\n${autoBuyConfigText()}`,
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    await tgShowHelp(chatId);
    return;
  }
  if (cmd === "/help") {
    await tgShowHelp(chatId);
    return;
  }
  if (cmd === "/status" || cmd === "/info") {
    await tgShowStatus(chatId);
    return;
  }
  if (cmd === "/ping") {
    await sendTelegram("pong ✅ bot vivant", chatId, {
      reply_markup: mainReplyKeyboard(),
    });
    return;
  }
  if (cmd === "/config") {
    await tgShowConfig(chatId);
    return;
  }
  if (cmd === "/export") {
    const list = [...trackedWallets];
    if (!list.length) {
      await sendTelegram("Aucun wallet.", chatId);
      return;
    }
    await sendTelegram(
      `📤 Export (${list.length})\n\n` + list.join("\n"),
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }

  if (cmd === "/add") {
    const address = args[0];
    const label = args.slice(1).join(" ");
    if (!address) {
      await tgPromptAdd(chatId);
      return;
    }
    try {
      const result = await addWallet(address, {
        source: "telegram",
        label,
      });
      await sendTelegram(
        result.alreadyTracked
          ? `ℹ️ Déjà suivi\n${walletLine(result.address)}`
          : `✅ Ajouté\n${walletLine(result.address)}\nTotal : ${trackedWallets.size}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      await sendTelegram(`❌ Erreur : ${err.message || err}`, chatId);
    }
    return;
  }

  if (cmd === "/label" || cmd === "/name") {
    const address = args[0];
    const label = args.slice(1).join(" ");
    if (!address || !label) {
      await sendTelegram(
        "Usage : /label 0x... MonNom\nExemple : /label 0x3bf7... Drain4",
        chatId
      );
      return;
    }
    try {
      const meta = setWalletLabel(address, label);
      await sendTelegram(
        `✅ Label OK\n🏷️ ${meta.label}\n${meta.address}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  if (cmd === "/remove" || cmd === "/rm" || cmd === "/delete") {
    const address = args[0];
    if (!address) {
      await sendTelegram("Usage : /remove 0x...", chatId);
      return;
    }
    try {
      const r = await removeWallet(address);
      await sendTelegram(
        r.removed
          ? `🗑 Retiré\n${r.address}\nTotal : ${trackedWallets.size}`
          : "Wallet non suivi.",
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  if (cmd === "/wallets" || cmd === "/list") {
    await tgShowWallets(chatId);
    return;
  }

  if (cmd === "/alerts") {
    await tgShowAlerts(chatId);
    return;
  }

  if (cmd === "/balance" || cmd === "/bal" || cmd === "/balances") {
    if (!args[0]) {
      await tgShowAllBalances(chatId);
      return;
    }
    await tgShowBalance(chatId, args[0]);
    return;
  }

  if (cmd === "/scan") {
    if (!args[0]) {
      await sendTelegram("Usage : /scan 0xWALLET", chatId);
      return;
    }
    try {
      const a = normalizeAddress(args[0]);
      if (!trackedWallets.has(a)) {
        await sendTelegram("Wallet non suivi. /add d’abord.", chatId);
        return;
      }
      await sendTelegram(`🔎 Scan de ${a}…`, chatId);
      await detectTokenDeploysAndNewWallets(a, []);
      await sendTelegram(
        `✅ Scan terminé pour\n${walletLine(a)}\nVoir /alerts`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  if (cmd === "/buy") {
    const token = args[0];
    const amount = args[1];
    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) {
      await sendTelegram(
        "Usage : /buy 0xTOKEN [montantETH]\nExemple : /buy 0x06feed… 0.001",
        chatId
      );
      return;
    }
    await tgManualBuy(chatId, token, amount);
    return;
  }

  if (cmd === "/autobuy") {
    const v = (args[0] || "").toLowerCase();
    if (v === "on" || v === "off") {
      setEnvRuntime("AUTO_BUY_ENABLED", v === "on" ? "true" : "false");
      await sendTelegram(
        `🛒 Auto-buy ${v === "on" ? "ON ✅" : "OFF ⏸"}\n\n${autoBuyConfigText()}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } else {
      await sendTelegram(
        `${autoBuyConfigText()}\n\nUsage : /autobuy on|off`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    }
    return;
  }

  if (cmd === "/amount" || cmd === "/montant") {
    if (!args[0]) {
      await tgShowAmount(chatId);
      return;
    }
    const raw = String(args[0]).replace(",", ".");
    if (Number(raw) <= 0 || Number.isNaN(Number(raw))) {
      await sendTelegram(
        `Montant actuel: ${process.env.AUTO_BUY_ETH_AMOUNT || "0.001"} ETH\n` +
          `Usage : /amount 0.001`,
        chatId
      );
      return;
    }
    setEnvRuntime("AUTO_BUY_ETH_AMOUNT", raw);
    await sendTelegram(
      `✅ Montant d’achat = ${raw} ETH\n\n` +
        `Chaque auto-buy (et /buy sans montant) utilisera ${raw} ETH.`,
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }

  if (cmd === "/slippage") {
    if (!args[0] || Number(args[0]) <= 0) {
      await sendTelegram(
        `Slippage: ${process.env.AUTO_BUY_SLIPPAGE || "3"}%\nUsage : /slippage 3`,
        chatId
      );
      return;
    }
    setEnvRuntime("AUTO_BUY_SLIPPAGE", args[0]);
    await sendTelegram(`✅ Slippage = ${args[0]}%`, chatId, {
      reply_markup: mainReplyKeyboard(),
    });
    return;
  }

  if (cmd === "/tp" || cmd === "/takeprofit") {
    if (!args[0] || Number.isNaN(Number(args[0]))) {
      await sendTelegram(
        `Take-profit: +${process.env.AUTO_BUY_TAKE_PROFIT || "100"}%\n` +
          `Usage : /tp 100  (100 = x2)`,
        chatId
      );
      return;
    }
    setEnvRuntime("AUTO_BUY_TAKE_PROFIT", args[0]);
    await sendTelegram(`✅ Take-profit = +${args[0]}%`, chatId, {
      reply_markup: mainReplyKeyboard(),
    });
    return;
  }

  if (cmd === "/sl" || cmd === "/stoploss" || cmd === "/stop-loss") {
    if (args[0] === undefined || Number.isNaN(Number(args[0]))) {
      const cur = process.env.AUTO_BUY_STOP_LOSS || "40";
      await sendTelegram(
        `Stop-loss: ${Number(cur) > 0 ? `-${cur}%` : "off"}\n` +
          `Usage : /sl 40  → vend si PnL ≤ -40%\n` +
          `/sl 0   → désactiver`,
        chatId
      );
      return;
    }
    const n = Math.abs(Number(args[0]));
    setEnvRuntime("AUTO_BUY_STOP_LOSS", String(n));
    // mirror for uniswap bot env if present
    try {
      const botEnv = path.join(
        process.env.UNISWAP_BOT_PATH ||
          path.resolve(__dirname, "..", "robinhood-uniswap-bot"),
        ".env"
      );
      if (fs.existsSync(botEnv)) {
        let t = fs.readFileSync(botEnv, "utf8");
        if (/^STOP_LOSS_PCT=/m.test(t)) {
          t = t.replace(/^STOP_LOSS_PCT=.*$/m, `STOP_LOSS_PCT=${n}`);
        } else {
          t = t.trimEnd() + `\nSTOP_LOSS_PCT=${n}\n`;
        }
        fs.writeFileSync(botEnv, t);
      }
    } catch {
      /* ignore */
    }
    await sendTelegram(
      n > 0
        ? `🛑 Stop-loss = -${n}%\n(vend auto si perte ≥ ${n}%)`
        : `Stop-loss désactivé`,
      chatId,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }

  if (cmd === "/dryrun") {
    const v = (args[0] || "").toLowerCase();
    if (v === "on" || v === "off") {
      setEnvRuntime("AUTO_BUY_DRY_RUN", v === "on" ? "true" : "false");
      await sendTelegram(
        `🧪 Dry-run ${v === "on" ? "ON (simulation)" : "OFF (achats réels)"}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } else {
      await sendTelegram(
        `Dry-run: ${isEnvOn("AUTO_BUY_DRY_RUN") ? "ON" : "OFF"}\n` +
          `Usage : /dryrun on|off`,
        chatId
      );
    }
    return;
  }

  // "0x... Label" or bare 0x → add wallet
  const bare = text.match(/^(0x[a-fA-F0-9]{40})(?:\s+(.+))?$/);
  if (bare) {
    try {
      const result = await addWallet(bare[1], {
        source: "telegram",
        label: bare[2] || "",
      });
      await sendTelegram(
        result.alreadyTracked
          ? `ℹ️ Déjà suivi\n${walletLine(result.address)}`
          : `✅ Ajouté\n${walletLine(result.address)}\nTotal : ${trackedWallets.size}`,
        chatId,
        { reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  await sendTelegram(
    "Commande inconnue.\n/help pour la liste · menu / en bas",
    chatId,
    { reply_markup: mainReplyKeyboard() }
  );
}

/**
 * Long-poll Telegram getUpdates (messages + button callbacks).
 */
function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[TELEGRAM] disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.warn(
      "[TELEGRAM] TELEGRAM_CHAT_ID missing — alerts/commands limited"
    );
  }

  let offset = 0;
  console.log(
    `[TELEGRAM] bot polling started (chat=${TELEGRAM_CHAT_ID || "?"})`
  );
  registerTelegramCommands().catch(() => {});

  const loop = async () => {
    try {
      const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
        `?timeout=30&offset=${offset}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          if (upd.callback_query) {
            await handleTelegramCallback(upd.callback_query);
          } else if (upd.message) {
            await handleTelegramMessage(upd.message);
          }
        }
      } else if (data.description) {
        console.error(`[TELEGRAM] getUpdates: ${data.description}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error(`[TELEGRAM] poll error: ${err.message || err}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    setImmediate(loop);
  };

  loop();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`[TRACKER] Robinhood Chain wallet tracker listening on :${PORT}`);
  console.log(
    `[TRACKER] Chain ID mainnet=${CHAIN_ID_MAINNET} (testnet=${CHAIN_ID_TESTNET})`
  );
  console.log(`[TRACKER] RPC ${RPC_URL.replace(ALCHEMY_API_KEY, "***")}`);
  console.log(
    `[TRACKER] Network slug=${ROBINHOOD_NETWORK_SLUG} (raw JSON-RPC; not alchemy-sdk enum)`
  );
  console.log(
    `[TRACKER] WEBHOOK_URL=${WEBHOOK_URL || "(not set — polling only)"}`
  );
  console.log(
    `[TRACKER] Telegram=${
      TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "ON" : "OFF"
    }`
  );

  // Quick connectivity check so bad API keys fail loudly at boot
  try {
    const chainIdHex = await alchemyRpc("eth_chainId", []);
    const chainId = Number(chainIdHex);
    console.log(`[TRACKER] RPC connected chainId=${chainId} (${chainIdHex})`);
    if (chainId !== CHAIN_ID_MAINNET) {
      console.warn(
        `[TRACKER] Expected chain ${CHAIN_ID_MAINNET}, got ${chainId}`
      );
    }
  } catch (err) {
    console.error(
      `[TRACKER] RPC connectivity check failed: ${err.message || err}`
    );
  }

  // Restore personalized wallets from disk, then re-register tracking
  const saved = loadWalletsDb();
  if (saved.length > 0) {
    console.log(`[TRACKER] Restoring ${saved.length} wallet(s) from disk...`);
    for (const w of saved) {
      try {
        await addWallet(w.address, {
          source: w.source || "restore",
          label: w.label || "",
          parent: w.parent || null,
        });
        if (w.note) {
          ensureWalletMeta(normalizeAddress(w.address), { note: w.note });
        }
      } catch (err) {
        console.error(
          `[TRACKER] restore ${w.address} failed: ${err.message || err}`
        );
      }
    }
    saveWalletsDb();
  }

  startTelegramBot();
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    // Delay so wallet restore can fill count a bit
    setTimeout(() => {
      sendTelegram(
        `🟢 Tracker démarré (port ${PORT})\n` +
          `${trackedWallets.size} wallet(s)\n` +
          `${autoBuyConfigText()}\n\n` +
          `Boutons 👇 · Commandes /help · Menu /`,
        TELEGRAM_CHAT_ID,
        { reply_markup: mainReplyKeyboard() }
      ).catch(() => {});
    }, 3000);
  }
});
