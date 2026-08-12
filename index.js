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

const {
  ALCHEMY_API_KEY,
  ALCHEMY_AUTH_TOKEN,
  WEBHOOK_URL,
  PORT = 3000,
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

      await handleActivityForSender(wallet, [
        {
          fromAddress: transfer.from,
          toAddress: transfer.to,
          hash: transfer.hash,
          asset: transfer.asset,
          category: transfer.category,
          value: transfer.value,
        },
      ]);
    } catch (err) {
      console.error(
        `[POLLING] Failed for ${wallet}: ${err.message || err}`
      );
    }
  }
}

/**
 * Check ETH balance of `sender`. If below threshold, run detection on its
 * last N outgoing external transactions (token deploy / new wallet).
 */
async function handleActivityForSender(sender, activityItems = []) {
  const senderNorm = normalizeAddress(sender);

  if (!trackedWallets.has(senderNorm)) {
    console.log(`[WEBHOOK] Ignoring untracked sender ${senderNorm}`);
    return;
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
      `[BALANCE] ${senderNorm} is not empty (>= 0.001 ETH); no detection run`
    );
    return;
  }

  console.log(
    `[DETECT] ${senderNorm} is empty (< 0.001 ETH) — scanning recent outgoings`
  );
  await detectTokenDeploysAndNewWallets(senderNorm, activityItems);
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

  if (receipt.contractAddress) {
    console.log(
      `[TOKEN DEPLOY] ${emptyWallet} deployed contract ${receipt.contractAddress} ` +
        `in tx ${txHash}`
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

    // Still scan contract-creation receipts even for non-ETH
    if (!isEthAsset) {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt?.contractAddress) {
          console.log(
            `[TOKEN DEPLOY] ${emptyWallet} deployed contract ${receipt.contractAddress} ` +
              `in tx ${txHash}`
          );
        }
      } catch (err) {
        console.error(
          `[DETECT] receipt fetch failed for tx ${txHash}: ${err.message || err}`
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
      await handleActivityForSender(sender, items);
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
});
