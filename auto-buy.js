/**
 * Auto-buy bridge: when the wallet tracker detects a token launch/create
 * from a tracked wallet, spawn robinhood-uniswap-bot to buy with ETH.
 *
 * Env (in wallet-tracker .env or uniswap bot .env):
 *   AUTO_BUY_ENABLED=true|false
 *   AUTO_BUY_ETH_AMOUNT=0.001
 *   AUTO_BUY_SLIPPAGE=3
 *   AUTO_BUY_TAKE_PROFIT=100
 *   AUTO_BUY_STOP_LOSS=40          # sell if PnL <= -40% (0 = off)
 *   AUTO_BUY_AUTO_WATCH=true
 *   AUTO_BUY_DRY_RUN=false
 *   AUTO_BUY_AMM_ONLY=true
 *   AUTO_BUY_ONLY_LAUNCHPAD=false
 *   UNISWAP_BOT_PATH=/root/robinhood-uniswap-bot
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const boughtTokens = new Set();
const buyingNow = new Set();

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function loadUniswapEnv(botPath) {
  const envPath = path.join(botPath, ".env");
  const extra = {};
  if (!fs.existsSync(envPath)) return extra;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    // Tracker env wins if already set
    if (process.env[k] === undefined) extra[k] = v;
  }
  return extra;
}

/**
 * @param {object} opts
 * @param {string} opts.tokenAddress
 * @param {string} [opts.deployer]
 * @param {string} [opts.symbol]
 * @param {string} [opts.name]
 * @param {string} [opts.txHash]
 * @param {boolean} [opts.launchpad]
 * @param {boolean} [opts.isErc20Like]
 * @param {(msg: string) => Promise<void>|void} [opts.notify]
 */
async function maybeAutoBuyToken(opts) {
  const {
    tokenAddress,
    deployer,
    symbol = "?",
    name = "?",
    txHash = "",
    launchpad = false,
    isErc20Like = false,
    notify,
  } = opts;

  if (!envBool("AUTO_BUY_ENABLED", false)) {
    console.log("[AUTO-BUY] disabled (set AUTO_BUY_ENABLED=true)");
    return { skipped: true, reason: "disabled" };
  }

  if (!isErc20Like) {
    console.log("[AUTO-BUY] skip non-ERC20 contract");
    return { skipped: true, reason: "not-erc20" };
  }

  // If ONLY_LAUNCHPAD=true, buy only launchpad-style mints (router create+liq).
  // CREATE classic is still allowed via fromCreate.
  if (
    envBool("AUTO_BUY_ONLY_LAUNCHPAD", false) &&
    !launchpad &&
    !opts.fromCreate
  ) {
    console.log("[AUTO-BUY] skip (ONLY_LAUNCHPAD and not launchpad/create)");
    return { skipped: true, reason: "only-launchpad" };
  }

  const token = String(tokenAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) {
    return { skipped: true, reason: "bad-address" };
  }

  if (boughtTokens.has(token) || buyingNow.has(token)) {
    console.log(`[AUTO-BUY] already bought/buying ${token}`);
    return { skipped: true, reason: "duplicate" };
  }

  const botPath =
    process.env.UNISWAP_BOT_PATH ||
    path.resolve(__dirname, "..", "robinhood-uniswap-bot");
  if (!fs.existsSync(path.join(botPath, "src", "index.ts"))) {
    console.error(`[AUTO-BUY] Uniswap bot not found at ${botPath}`);
    if (notify) {
      await notify(
        `❌ AUTO-BUY: bot Uniswap introuvable\npath=${botPath}`
      );
    }
    return { skipped: true, reason: "bot-missing" };
  }

  let amount = process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
  const slippage = String(envNum("AUTO_BUY_SLIPPAGE", 3));
  const takeProfit = String(envNum("AUTO_BUY_TAKE_PROFIT", 100));
  const stopLoss = String(envNum("AUTO_BUY_STOP_LOSS", 40));
  const interval = String(envNum("AUTO_BUY_WATCH_INTERVAL", 10));
  const dryRun = envBool("AUTO_BUY_DRY_RUN", false);
  const ammOnly = envBool("AUTO_BUY_AMM_ONLY", true);
  const autoWatch = envBool("AUTO_BUY_AUTO_WATCH", true);

  // Pre-check trading wallet ETH balance (need amount + gas reserve)
  try {
    const { ethers } = require("ethers");
    const uniEnv = loadUniswapEnv(botPath);
    let pk = uniEnv.PRIVATE_KEY || process.env.PRIVATE_KEY || "";
    pk = pk.trim().replace(/^["']|["']$/g, "");
    if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
    const rpc =
      uniEnv.RPC_URL ||
      process.env.RPC_URL ||
      "https://rpc.mainnet.chain.robinhood.com";
    if (pk && pk.length >= 66) {
      const provider = new ethers.JsonRpcProvider(rpc, 4663);
      const wallet = new ethers.Wallet(pk, provider);
      const balWei = await provider.getBalance(wallet.address);
      const balEth = Number(ethers.formatEther(balWei));
      const want = Number(amount);
      // Keep ~0.00015 ETH for gas on Robinhood L2
      const gasReserve = Number(process.env.AUTO_BUY_GAS_RESERVE || "0.00015");
      const maxSpend = Math.max(0, balEth - gasReserve);
      if (maxSpend < 0.00005) {
        const msg =
          `❌ AUTO-BUY impossible — wallet trading à sec\n` +
          `${wallet.address}\n` +
          `Balance: ${balEth} ETH\n` +
          `Demandé: ${amount} ETH (+ gas)\n` +
          `→ Envoie de l'ETH sur ce wallet`;
        console.error(`[AUTO-BUY] ${msg.replace(/\n/g, " | ")}`);
        if (notify) await notify(msg);
        return { skipped: true, reason: "insufficient-balance", balEth };
      }
      if (want > maxSpend) {
        // Auto-reduce amount to what we can afford
        const reduced = Math.floor(maxSpend * 1e6) / 1e6; // 6 decimals
        console.warn(
          `[AUTO-BUY] reducing amount ${want} → ${reduced} ETH (bal=${balEth})`
        );
        amount = String(reduced);
        if (notify) {
          await notify(
            `⚠️ Balance faible — montant réduit\n` +
              `${balEth.toFixed(6)} ETH dispo\n` +
              `Achat ajusté: ${amount} ETH (au lieu de ${want})\n` +
              `${wallet.address}`
          );
        }
      }
    }
  } catch (err) {
    console.warn(`[AUTO-BUY] balance precheck failed: ${err.message || err}`);
  }

  const logsDir = path.join(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const safeSym =
    String(symbol).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "tok";
  const logFile = path.join(
    logsDir,
    `autobuy-${safeSym}-${token.slice(2, 10)}.log`
  );

  buyingNow.add(token);

  const header =
    `\n======== AUTO-BUY FAST ${new Date().toISOString()} ========\n` +
    `token=${token} symbol=${symbol} name=${name}\n` +
    `deployer=${deployer || "?"} launchTx=${txHash || "?"}\n` +
    `amount=${amount} ETH slippage=${slippage}% dryRun=${dryRun}\n` +
    `mode=fast-buy (in-process Uniswap API)\n` +
    `====================================================\n`;
  fs.appendFileSync(logFile, header);

  console.log(
    `[AUTO-BUY] 🛒 FAST buying ${symbol} (${token}) with ${amount} ETH` +
      (dryRun ? " [DRY-RUN]" : "")
  );

  if (notify) {
    await notify(
      `🛒 AUTO-BUY (fast)\n` +
        `${name} (${symbol})\n` +
        `${token}\n` +
        `montant: ${amount} ETH\n` +
        `TP +${takeProfit}% · SL -${stopLoss}%\n` +
        `deployer: ${deployer || "?"}`
    );
  }

  try {
    const { fastBuyTokenEth } = require("./fast-buy");
    const result = await fastBuyTokenEth({
      tokenAddress: token,
      amountEth: amount,
      slippage: Number(slippage),
      dryRun,
      botPath,
    });
    fs.appendFileSync(logFile, JSON.stringify(result, null, 2) + "\n");
    boughtTokens.add(token);
    buyingNow.delete(token);

    if (result.dryRun) {
      if (notify) {
        await notify(
          `🧪 FAST-BUY dry-run OK\n${symbol}\n${result.ms || "?"}ms`
        );
      }
      return { ok: true, dryRun: true, ...result, logFile };
    }

    if (notify) {
      await notify(
        `✅ ACHAT CONFIRMÉ (fast)\n` +
          `${name} (${symbol})\n` +
          `${amount} ETH\n` +
          `tx: ${result.txHash}\n` +
          `⏱ ${result.ms}ms\n` +
          `block ${result.blockNumber || "?"}`
      );
    }

    // Start watch-pnl in background (TP/SL) without blocking
    if (autoWatch && !dryRun) {
      startWatchPnl({
        botPath,
        token,
        takeProfit,
        stopLoss,
        interval,
        logFile,
      });
    }

    return { ok: true, ...result, logFile, token, amount };
  } catch (err) {
    buyingNow.delete(token);
    const msg = err.message || String(err);
    fs.appendFileSync(logFile, `ERROR: ${msg}\n`);
    console.error(`[AUTO-BUY] fast-buy failed: ${msg}`);
    if (notify) await notify(`❌ AUTO-BUY échoué\n${symbol}\n${msg}`);

    // Fallback: old spawn path once
    if (envBool("AUTO_BUY_SPAWN_FALLBACK", true)) {
      console.log("[AUTO-BUY] fallback spawn uniswap-bot…");
      return spawnUniswapBuy({
        botPath,
        token,
        amount,
        slippage,
        takeProfit,
        stopLoss,
        interval,
        dryRun,
        autoWatch,
        symbol,
        name,
        deployer,
        txHash,
        logFile,
        notify,
      });
    }
    return { ok: false, error: msg, logFile };
  }
}

/** Background watch-pnl only (after fast buy) */
function startWatchPnl({
  botPath,
  token,
  takeProfit,
  stopLoss,
  interval,
  logFile,
}) {
  const tsxBin = path.join(botPath, "node_modules", ".bin", "tsx");
  const useTsx = fs.existsSync(tsxBin) ? tsxBin : "npx";
  const args =
    useTsx === "npx"
      ? [
          "tsx",
          "src/index.ts",
          "watch-pnl",
          "--token",
          token,
          "--take-profit",
          takeProfit,
          "--stop-loss",
          stopLoss,
          "--interval",
          interval,
        ]
      : [
          "src/index.ts",
          "watch-pnl",
          "--token",
          token,
          "--take-profit",
          takeProfit,
          "--stop-loss",
          stopLoss,
          "--interval",
          interval,
        ];

  // Need a position recorded — watch-pnl with --token --cost imports from balance
  // After buy, tokens are in wallet; import cost = amount spent
  // Actually watch-pnl --token --cost only if no open position.
  // recordBuy happens inside swap command, not fast-buy — so we pass cost:
  const amount = process.env.AUTO_BUY_ETH_AMOUNT || "0.001";
  if (useTsx === "npx") {
    args.push("--cost", amount);
  } else {
    args.push("--cost", amount);
  }

  const logFd = fs.openSync(logFile, "a");
  fs.writeSync(
    logFd,
    `\n--- watch-pnl start ${new Date().toISOString()} ---\n`
  );
  const child = spawn(useTsx, args, {
    cwd: botPath,
    env: { ...process.env, ...loadUniswapEnv(botPath) },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  child.on("exit", () => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* */
    }
  });
  console.log(`[AUTO-BUY] watch-pnl started pid=${child.pid} token=${token}`);
  return child;
}

/** Legacy spawn full swap+watch (fallback) */
function spawnUniswapBuy(opts) {
  const {
    botPath,
    token,
    amount,
    slippage,
    takeProfit,
    stopLoss,
    interval,
    dryRun,
    autoWatch,
    symbol,
    logFile,
    notify,
  } = opts;
  const tsxBin = path.join(botPath, "node_modules", ".bin", "tsx");
  const useTsx = fs.existsSync(tsxBin) ? tsxBin : "npx";
  const baseArgs = [
    "src/index.ts",
    "swap",
    "--in",
    "ETH",
    "--out",
    token,
    "--amount",
    amount,
    "--slippage",
    slippage,
    "--take-profit",
    takeProfit,
    "--stop-loss",
    stopLoss,
  ];
  const args = useTsx === "npx" ? ["tsx", ...baseArgs] : baseArgs;
  args.push("--amm-only");
  if (dryRun) args.push("--dry-run");
  if (autoWatch && !dryRun) args.push("--auto-watch", "--interval", interval);

  buyingNow.add(token);
  const logFd = fs.openSync(logFile, "a");
  fs.writeSync(logFd, `FALLBACK SPAWN: ${useTsx} ${args.join(" ")}\n`);

  return new Promise((resolve) => {
    const child = spawn(useTsx, args, {
      cwd: botPath,
      env: { ...process.env, ...loadUniswapEnv(botPath) },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.on("error", async (err) => {
      buyingNow.delete(token);
      if (notify) await notify(`❌ fallback spawn: ${err.message}`);
      resolve({ ok: false, error: err.message, logFile });
    });
    child.unref();
    setTimeout(() => {
      buyingNow.delete(token);
      boughtTokens.add(token);
      if (notify) {
        notify(`⚠️ Fallback spawn OK\n${symbol} pid=${child.pid}`);
      }
      resolve({ ok: true, pid: child.pid, logFile, token, amount, fallback: true });
    }, 2000);
    child.on("exit", () => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* */
      }
    });
  });
}

module.exports = {
  maybeAutoBuyToken,
  boughtTokens,
};
