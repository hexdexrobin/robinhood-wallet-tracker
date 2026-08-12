/**
 * Fast in-process Uniswap Trading API buy (no tsx cold start).
 * Saves ~5–15s vs spawning robinhood-uniswap-bot for each swap.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const NATIVE = "0x0000000000000000000000000000000000000000";
const API_URL =
  process.env.UNISWAP_API_URL || "https://trade-api.gateway.uniswap.org/v1";

function loadBotEnv(botPath) {
  const envPath = path.join(botPath, ".env");
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    const k = t.slice(0, i).trim();
    out[k] = v;
  }
  return out;
}

async function apiPost(apiKey, p, body, extraHeaders = {}) {
  const res = await fetch(`${API_URL}${p}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-universal-router-version": "2.1.1",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status} ${p}`;
    const err = new Error(msg);
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * Buy token with ETH as fast as possible.
 * @returns {{ txHash: string, amountEth: string, wallet: string, quote?: object }}
 */
async function fastBuyTokenEth({
  tokenAddress,
  amountEth,
  slippage = 3,
  dryRun = false,
  botPath,
}) {
  const t0 = Date.now();
  // Prefer uniswap-bot .env for trading keys (tracker .env must not override empty)
  const botEnv = loadBotEnv(
    botPath || process.env.UNISWAP_BOT_PATH || ""
  );
  const env = { ...process.env, ...botEnv };
  let pk = (botEnv.PRIVATE_KEY || process.env.PRIVATE_KEY || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!pk) throw new Error("PRIVATE_KEY missing (uniswap bot .env)");
  if (!pk.startsWith("0x")) pk = "0x" + pk;

  const apiKey = botEnv.UNISWAP_API_KEY || process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new Error("UNISWAP_API_KEY missing");

  const rpc =
    env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const chainId = Number(env.CHAIN_ID || 4663);
  const provider = new ethers.JsonRpcProvider(rpc, chainId);
  const wallet = new ethers.Wallet(pk, provider);
  const swapper = await wallet.getAddress();
  const token = ethers.getAddress(tokenAddress);
  const amountWei = ethers.parseEther(String(amountEth)).toString();

  const bal = await provider.getBalance(swapper);
  if (bal < BigInt(amountWei)) {
    throw new Error(
      `Balance insuffisante: ${ethers.formatEther(bal)} < ${amountEth} ETH`
    );
  }

  console.log(
    `[FAST-BUY] ${amountEth} ETH → ${token} wallet=${swapper} t+0ms`
  );

  // Quote (AMM only — best for fresh pools.trade / v4 launches)
  const quoteRes = await apiPost(
    apiKey,
    "/quote",
    {
      tokenIn: NATIVE,
      tokenOut: token,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      type: "EXACT_INPUT",
      amount: amountWei,
      swapper,
      slippageTolerance: Number(slippage),
      routingPreference: env.ROUTING_PREFERENCE || "BEST_PRICE",
      protocols: ["V2", "V3", "V4"],
      permitAmount: "EXACT",
    },
    { "x-erc20eth-enabled": "true" }
  );

  console.log(
    `[FAST-BUY] quote ok routing=${quoteRes.routing} t+${Date.now() - t0}ms`
  );

  const { quote, permitData, routing } = quoteRes;
  let signature;
  if (permitData) {
    const types = { ...permitData.types };
    delete types.EIP712Domain;
    signature = await wallet.signTypedData(
      permitData.domain,
      types,
      permitData.values
    );
  }

  if (!["CLASSIC", "WRAP", "UNWRAP", "BRIDGE"].includes(routing)) {
    throw new Error(`Routing non supporté en fast-buy: ${routing}`);
  }

  const swapBody = { quote, refreshGasPrice: true };
  if (signature && permitData) {
    swapBody.signature = signature;
    swapBody.permitData = permitData;
  }

  const swapRes = await apiPost(apiKey, "/swap", swapBody);
  const tx = swapRes.swap;
  if (!tx?.to || !tx?.data) throw new Error("Swap tx invalide (data/to manquant)");

  if (dryRun) {
    return {
      dryRun: true,
      wallet: swapper,
      amountEth: String(amountEth),
      token,
      ms: Date.now() - t0,
    };
  }

  const gasLimit = tx.gasLimit
    ? (BigInt(tx.gasLimit) * 150n) / 100n
    : 500_000n;
  const txReq = {
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit,
  };
  if (tx.maxFeePerGas)
    txReq.maxFeePerGas = (BigInt(tx.maxFeePerGas) * 130n) / 100n;
  if (tx.maxPriorityFeePerGas)
    txReq.maxPriorityFeePerGas =
      (BigInt(tx.maxPriorityFeePerGas) * 130n) / 100n;

  // Skip eth_call simulation for speed (saves 1 round-trip)
  const sent = await wallet.sendTransaction(txReq);
  console.log(`[FAST-BUY] broadcast ${sent.hash} t+${Date.now() - t0}ms`);
  const receipt = await sent.wait();
  if (receipt && Number(receipt.status) === 0) {
    throw new Error(`Swap reverted on-chain ${sent.hash}`);
  }
  console.log(
    `[FAST-BUY] confirmed block=${receipt?.blockNumber} t+${Date.now() - t0}ms`
  );

  return {
    dryRun: false,
    txHash: sent.hash,
    wallet: swapper,
    amountEth: String(amountEth),
    token,
    ms: Date.now() - t0,
    blockNumber: receipt?.blockNumber,
  };
}

module.exports = { fastBuyTokenEth, loadBotEnv };
