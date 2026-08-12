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
        `wallet: ${wallet}\n` +
        `${from} → ${to}\n` +
        `${valueStr} ${assetStr}\n` +
        `hash: ${hash || "?"}`
    );
  }
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

  if (to && trackedWallets.has(to) && to !== from) {
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
    enablePollingFallback("missing ALCHEMY_AUTH_TOKEN");
    return;
  }

  if (!WEBHOOK_URL) {
    console.warn(
      "[TRACKER] WEBHOOK_URL missing — skipping webhook registration, enabling polling"
    );
    enablePollingFallback("missing WEBHOOK_URL");
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
    enablePollingFallback(err.message || String(err));
  }
}

/**
 * Flip into polling mode and start a 15s setInterval over all tracked wallets.
 * Idempotent — calling multiple times does not stack intervals.
 */
function enablePollingFallback(reason) {
  webhooksSupported = false;
  console.warn(
    `[POLLING] Falling back to getAssetTransfers every ${POLL_INTERVAL_MS / 1000}s ` +
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
 * Handle activity for a sender:
 * 1) Alert transfers (in/out) for tracked wallets
 * 2) If sender is tracked → scan txs for TOKEN CREATION immediately
 * 3) If wallet empty → also scan for new wallets / further deploys
 */
async function handleActivityForSender(sender, activityItems = [], source = "webhook") {
  let senderNorm;
  try {
    senderNorm = normalizeAddress(sender);
  } catch {
    console.log(`[WEBHOOK] Invalid sender ${sender}`);
    return;
  }

  // Always signal transfers that touch tracked wallets (in or out)
  for (const item of activityItems) {
    try {
      await alertIfTrackedActivity(item, source);
    } catch (err) {
      console.error(`[ALERT] signal error: ${err.message || err}`);
    }
  }

  if (!trackedWallets.has(senderNorm)) {
    // Activity may still have alerted on IN to a tracked wallet above
    return;
  }

  // --- TOKEN CREATE detection on every outgoing activity (not only when empty) ---
  const hashes = new Set();
  for (const item of activityItems) {
    const h = item.hash || item.transactionHash || item.txHash;
    if (h && typeof h === "string" && h.startsWith("0x") && h.length === 66) {
      hashes.add(h.toLowerCase());
    }
  }
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

  if (balance >= EMPTY_BALANCE_WEI) {
    console.log(
      `[BALANCE] ${senderNorm} is not empty (>= 0.001 ETH); no new-wallet scan`
    );
    return;
  }

  console.log(
    `[DETECT] ${senderNorm} is empty (< 0.001 ETH) — scanning recent outgoings`
  );
  await detectTokenDeploysAndNewWallets(senderNorm, activityItems);
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
  console.log(`[TOKEN DEPLOY] 🪙 ${kind} CRÉÉ 🪙  ${ts}`);
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
    await sendTelegram(
      `🪙 TOKEN / CONTRACT CRÉÉ\n` +
        `deployer: ${deployer}\n` +
        `contract: ${contractAddress}\n` +
        `${name} (${symbol}) dec=${decimals} supply=${supply}\n` +
        `tx: ${txHash}`
    );
  }

  void key;
}

/**
 * Detect token/contract creation in a transaction from a tracked wallet.
 *
 * Strategies:
 *  A) Classic CREATE: receipt.contractAddress is set (tx.to == null)
 *  B) Factory / mint: logs contain ERC-20 Transfer(from=0x0, ...) → token address = log.address
 *     and we only keep it if code exists and looks like ERC-20
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

  // --- A) Direct contract creation ---
  if (receipt.contractAddress) {
    const c = receipt.contractAddress.toLowerCase();
    console.log(
      `[TOKEN DEPLOY] CREATE detected: ${c} by ${deployer} in ${txHash}`
    );
    const meta = await readErc20Metadata(c);
    await signalTokenDeploy({
      deployer,
      contractAddress: c,
      txHash,
      meta,
      source,
    });
    found.push(c);
  }

  // --- B) Transfer from zero address = mint (often right after factory deploy) ---
  // ERC-20 Transfer(address,address,uint256) topic0
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO_TOPIC =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const mintCandidates = new Set();
  for (const log of receipt.logs || []) {
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    // from = topics[1] must be zero for a mint
    if (log.topics[1] && log.topics[1].toLowerCase() === ZERO_TOPIC) {
      if (log.address) mintCandidates.add(log.address.toLowerCase());
    }
  }

  for (const tokenAddr of mintCandidates) {
    if (found.includes(tokenAddr)) continue;
    if (detectedTokenContracts.has(tokenAddr)) continue;

    // Only alert mints if this tx was sent by our deployer (factory pattern)
    // and the token looks like ERC-20
    let code;
    try {
      code = await provider.getCode(tokenAddr);
    } catch {
      continue;
    }
    if (!code || code === "0x" || code === "0x0") continue;

    const meta = await readErc20Metadata(tokenAddr);
    if (!meta.isErc20Like) {
      console.log(
        `[TOKEN DEPLOY] mint log at ${tokenAddr} but not ERC-20-like — skip`
      );
      continue;
    }

    // Prefer mints where deployer is involved: contract create above, OR
    // tx from deployer (always true here) — factory deploys count.
    console.log(
      `[TOKEN DEPLOY] MINT/factory token detected: ${tokenAddr} (tx ${txHash})`
    );
    await signalTokenDeploy({
      deployer,
      contractAddress: tokenAddr,
      txHash,
      meta,
      source,
    });
    found.push(tokenAddr);
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
    return true;
  } catch {
    return false;
  }
}

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
    return { address, alreadyTracked: true };
  }

  trackedWallets.add(address);
  console.log(
    `[TRACKER] Added wallet ${address}` +
      (meta.source ? ` (source=${meta.source}` : "") +
      (meta.parent ? ` parent=${meta.parent}` : "") +
      (meta.source ? ")" : "")
  );
  if (meta.source === "auto-detect") {
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

  // Ensure polling is running even if webhook succeeded (belt-and-suspenders
  // while Notify support for Robinhood is uneven across accounts).
  if (webhooksSupported !== true) {
    enablePollingFallback(
      webhooksSupported === false
        ? "webhook unavailable"
        : "webhook not confirmed — polling until proven"
    );
  }

  return { address, alreadyTracked: false };
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
  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "Body must include string 'address'" });
  }

  try {
    const result = await addWallet(address, { source: "api" });
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
 * GET /wallets
 */
app.get("/wallets", (_req, res) => {
  res.json({
    wallets: [...trackedWallets],
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

// ---------------------------------------------------------------------------
// Telegram bot — alerts + commands (/add, /wallets, /alerts)
// ---------------------------------------------------------------------------

/**
 * Send a text message to the configured Telegram chat (or a specific chatId).
 */
async function sendTelegram(text, chatId = TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text).slice(0, 4000),
          disable_web_page_preview: true,
        }),
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

/**
 * Handle one incoming Telegram message (commands only from allowed chat).
 */
async function handleTelegramMessage(msg) {
  const chatId = String(msg.chat?.id ?? "");
  const text = (msg.text || "").trim();
  if (!text) return;

  // Security: only the configured chat can control the bot
  if (String(TELEGRAM_CHAT_ID) && chatId !== String(TELEGRAM_CHAT_ID)) {
    console.warn(
      `[TELEGRAM] ignored message from unauthorized chat ${chatId}`
    );
    await sendTelegram(
      "⛔ Chat non autorisé pour ce bot tracker.",
      chatId
    );
    return;
  }

  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split("@")[0]; // /add@botname → /add

  console.log(`[TELEGRAM] cmd=${cmd} args=${args.join(" ")}`);

  if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(
      `🤖 Robinhood Wallet Tracker\n\n` +
        `Commandes :\n` +
        `/add 0x... — ajouter un wallet\n` +
        `/wallets — lister les wallets suivis\n` +
        `/alerts — dernières alertes\n` +
        `/help — cette aide\n\n` +
        `Tu reçois aussi auto les alertes transferts + tokens.`,
      chatId
    );
    return;
  }

  if (cmd === "/add") {
    const address = args[0];
    if (!address) {
      await sendTelegram(
        "Usage : /add 0xTonWallet\nExemple : /add 0x67A64dB3...",
        chatId
      );
      return;
    }
    try {
      const result = await addWallet(address, { source: "telegram" });
      if (result.alreadyTracked) {
        await sendTelegram(
          `ℹ️ Déjà suivi\n${result.address}\nTotal : ${trackedWallets.size}`,
          chatId
        );
      } else {
        await sendTelegram(
          `✅ Wallet ajouté\n${result.address}\nTotal : ${trackedWallets.size}\nMode : ${
            webhooksSupported === true ? "webhook" : "polling"
          }`,
          chatId
        );
      }
    } catch (err) {
      await sendTelegram(`❌ Erreur : ${err.message || err}`, chatId);
    }
    return;
  }

  if (cmd === "/wallets" || cmd === "/list") {
    const list = [...trackedWallets];
    if (list.length === 0) {
      await sendTelegram("Aucun wallet suivi. Utilise /add 0x...", chatId);
      return;
    }
    const body = list.map((a, i) => `${i + 1}. ${a}`).join("\n");
    await sendTelegram(
      `📋 Wallets suivis (${list.length})\n\n${body}\n\n` +
        `mode=${webhooksSupported === true ? "webhook" : "polling"} ` +
        `webhook=${addressActivityWebhookId || "—"}`,
      chatId
    );
    return;
  }

  if (cmd === "/alerts") {
    try {
      if (!fs.existsSync(ALERTS_LOG_PATH)) {
        await sendTelegram("Aucune alerte pour l’instant.", chatId);
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
        await sendTelegram("Aucune alerte pour l’instant.", chatId);
        return;
      }
      const parts = lines.map((line, i) => {
        try {
          const a = JSON.parse(line);
          if (a.type === "TOKEN_DEPLOY") {
            return (
              `${i + 1}. 🪙 TOKEN ${a.symbol || "?"} (${a.name || "?"})\n` +
              `   ${a.contractAddress}\n` +
              `   by ${a.deployer}`
            );
          }
          const dir = a.direction === "IN" ? "⬅️ REÇU" : "➡️ ENVOYÉ";
          return (
            `${i + 1}. ${dir} ${a.value} ${a.asset}\n` +
            `   ${a.from} → ${a.to}\n` +
            `   wallet ${a.wallet}`
          );
        } catch {
          return `${i + 1}. ${line.slice(0, 120)}`;
        }
      });
      await sendTelegram(`🚨 Dernières alertes\n\n${parts.join("\n\n")}`, chatId);
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  // Bare 0x address → treat as /add
  if (/^0x[a-fA-F0-9]{40}$/.test(cmdRaw)) {
    try {
      const result = await addWallet(cmdRaw, { source: "telegram" });
      await sendTelegram(
        result.alreadyTracked
          ? `ℹ️ Déjà suivi\n${result.address}`
          : `✅ Ajouté\n${result.address}\nTotal : ${trackedWallets.size}`,
        chatId
      );
    } catch (err) {
      await sendTelegram(`❌ ${err.message || err}`, chatId);
    }
    return;
  }

  await sendTelegram("Commande inconnue. Envoie /help", chatId);
}

/**
 * Long-poll Telegram getUpdates loop (commands).
 * Runs forever in the background while the server is up.
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
          if (upd.message) {
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
    // continue
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

  // Start Telegram command listener + notify that bot is online
  startTelegramBot();
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    sendTelegram(
      `🟢 Tracker démarré (port ${PORT})\n` +
        `Commandes : /add 0x... | /wallets | /alerts | /help`
    ).catch(() => {});
  }
});
