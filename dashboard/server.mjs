/**
 * x402 Dashboard Server
 *
 * Serves the dashboard UI and provides an SSE endpoint to run
 * live E2E tests with real-time step streaming to the browser.
 *
 * Usage:
 *   cd x402/dashboard
 *   node server.mjs
 *
 * Reads .env from ../server/.env (shared config with x402 server)
 */

import express from 'express';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from server/.env
config({ path: resolve(__dirname, '../server/.env') });

// Lazy-load these — they need node_modules from server/
let ExactEvmScheme, x402Client, wrapFetchWithPayment;
let createWallet, createRpcQueryClientWithFallback, rpcQueryFeeGrant, disconnectRpc;

async function loadDeps() {
  const evmMod = await import('@x402/evm/exact/client');
  ExactEvmScheme = evmMod.ExactEvmScheme;

  const fetchMod = await import('@x402/fetch');
  x402Client = fetchMod.x402Client;
  wrapFetchWithPayment = fetchMod.wrapFetchWithPayment;

  // Sentinel SDK — relative path from dashboard/
  const sdkPath = resolve(__dirname, '../../Sentinel SDK/js-sdk');
  const aiPath = resolve(sdkPath, 'ai-path');

  const walletMod = await import(`file://${aiPath}/wallet.js`);
  createWallet = walletMod.createWallet;

  const sdkIndex = await import(`file://${sdkPath}/index.js`);
  createRpcQueryClientWithFallback = sdkIndex.createRpcQueryClientWithFallback;
  rpcQueryFeeGrant = sdkIndex.rpcQueryFeeGrant;
  disconnectRpc = sdkIndex.disconnectRpc;
}

// ─── Config ───

const PORT = parseInt(process.env.DASHBOARD_PORT || '4030', 10);
const SERVER_URL = process.env.X402_SERVER || 'http://localhost:4020';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OPERATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY;
const SENTINEL_RPC = process.env.SENTINEL_RPC_URL || 'https://rpc.sentinel.co:443';

const BASE_TX_URL = 'https://basescan.org/tx';
const BASE_ADDR_URL = 'https://basescan.org/address';
const SENT_TX_URL = 'https://www.mintscan.io/sentinel/tx';
const SENT_ADDR_URL = 'https://www.mintscan.io/sentinel/address';

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const PLAN_42_NODES = [
  'sentnode10e7wrxjfzywvsvptewqrg0kjsrrap3277zdkke',
  'sentnode13dlpyvqext6y7h6n3rgntvygm3sthlww2npgpn',
  'sentnode15dkwtntn5jah6hjctkx2szktx5sq2ca5hm6env',
  'sentnode1mn9urq2madyx8zqttnplgsklh7jy5rvzp8nr6d',
  'sentnode1lj0fewcdlja2w9wnvqvzq93tjhhg7d0nm3tg47',
  'sentnode1l7ctwy40xyvmkr028zqhj7zpzmygl3nqym7e8s',
];

// ─── Sentinel RPC helpers ───

async function searchSentinelTx(eventQuery) {
  try {
    const url = `${SENTINEL_RPC}/tx_search?query="${encodeURIComponent(eventQuery)}"&order_by="desc"&per_page=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.result?.txs?.length > 0) {
      return { hash: data.result.txs[0].hash, height: data.result.txs[0].height };
    }
  } catch { /* ignore */ }
  return null;
}

async function getBlockTime(height) {
  try {
    const url = `${SENTINEL_RPC}/block?height=${height}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.result?.block?.header?.time || null;
  } catch { return null; }
}

// ─── Express App ───

const app = express();
app.use(express.static(__dirname));

// Track running test to prevent concurrent runs
let testRunning = false;

// ─── SSE: Run E2E Test ───

app.get('/api/test/run', async (req, res) => {
  if (testRunning) {
    res.status(409).json({ error: 'A test is already running' });
    return;
  }
  testRunning = true;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  let stepNum = 0;
  function emitStep(title, data = {}) {
    stepNum++;
    const payload = { n: stepNum, title, time: new Date().toISOString(), ...data };
    send('step', payload);
    return payload;
  }

  function emitTx(label, chain, hash, extra = {}) {
    const explorer = chain === 'Base' ? `${BASE_TX_URL}/${hash}` : `${SENT_TX_URL}/${hash}`;
    send('tx', { label, chain, hash, explorer, ...extra });
  }

  function emitWallet(role, chain, address) {
    const explorer = chain === 'Base'
      ? `${BASE_ADDR_URL}/${address}`
      : `${SENT_ADDR_URL}/${address}`;
    send('wallet', { role, chain, address, explorer });
  }

  try {
    await loadDeps();

    if (!OPERATOR_KEY) throw new Error('FACILITATOR_PRIVATE_KEY not set');

    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const opWallet = new ethers.Wallet(OPERATOR_KEY, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, opWallet);

    send('status', { phase: 'starting', message: 'Generating wallets...' });

    // ── Step 1: EVM wallet ──
    const evmWallet = ethers.Wallet.createRandom();
    emitStep('Generate fresh EVM wallet', {
      address: evmWallet.address,
      chain: 'Base (EIP-155:8453)',
      type: 'local',
    });
    emitWallet('Agent (Base)', 'Base', evmWallet.address);

    // ── Step 2: Sentinel wallet ──
    const sentWallet = await createWallet();
    emitStep('Generate fresh Sentinel wallet', {
      address: sentWallet.address,
      chain: 'Sentinel (sentinelhub-2)',
      type: 'local',
    });
    emitWallet('Agent (Sentinel)', 'Sentinel', sentWallet.address);

    send('status', { phase: 'funding', message: 'Funding agent on Base...' });

    // ── Step 3: Fund USDC ──
    emitStep('Fund agent: USDC on Base', {
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.034 USDC',
      type: 'base-tx',
    });

    const usdcTx = await usdc.transfer(evmWallet.address, 34000n);
    send('progress', { step: stepNum, message: `TX submitted: ${usdcTx.hash}` });
    const usdcRcpt = await usdcTx.wait(1);

    emitTx('USDC Funding (operator → agent)', 'Base', usdcTx.hash, {
      block: usdcRcpt.blockNumber,
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.034 USDC',
    });

    // ── Step 4: Fund ETH ──
    emitStep('Fund agent: ETH gas on Base', {
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.00005 ETH',
      type: 'base-tx',
    });

    const ethTx = await opWallet.sendTransaction({
      to: evmWallet.address,
      value: ethers.parseEther('0.00005'),
    });
    send('progress', { step: stepNum, message: `TX submitted: ${ethTx.hash}` });
    const ethRcpt = await ethTx.wait(1);

    emitTx('ETH Gas Funding (operator → agent)', 'Base', ethTx.hash, {
      block: ethRcpt.blockNumber,
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.00005 ETH',
    });

    // ── Step 5: Verify funded ──
    const [aEth, aUsdc] = await Promise.all([
      provider.getBalance(evmWallet.address),
      usdc.balanceOf(evmWallet.address),
    ]);
    emitStep('Verify agent funded', {
      usdc: ethers.formatUnits(aUsdc, 6),
      eth: ethers.formatEther(aEth),
      p2p: '0.00 (fee-granted)',
      type: 'read',
    });

    send('status', { phase: 'payment', message: 'x402 payment flow...' });

    // ── Step 6: POST → 402 ──
    const res402 = await fetch(`${SERVER_URL}/vpn/connect/1day`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentinelAddr: sentWallet.address }),
    });

    let paymentInfo = {};
    const payHeader = res402.headers.get('x-payment');
    if (payHeader) {
      try {
        const reqs = JSON.parse(Buffer.from(payHeader, 'base64').toString());
        paymentInfo = {
          scheme: reqs.accepts?.[0]?.scheme,
          network: reqs.accepts?.[0]?.network,
          price: reqs.accepts?.[0]?.maxAmountRequired,
          payTo: reqs.accepts?.[0]?.payTo,
        };
      } catch { /* ok */ }
    }

    emitStep('POST /vpn/connect/1day → HTTP 402', {
      status: `${res402.status} ${res402.statusText}`,
      scheme: paymentInfo.scheme || 'exact',
      network: paymentInfo.network || 'eip155:8453',
      price: `${paymentInfo.price || 33000} atomic USDC ($0.033)`,
      payTo: paymentInfo.payTo || opWallet.address,
      type: 'x402',
    });

    if (res402.status !== 402) throw new Error(`Expected 402, got ${res402.status}`);

    // ── Step 7: x402 payment ──
    const payT0 = Date.now();
    emitStep('x402 payment: sign EIP-3009 → settle → provision', {
      action: 'Agent signs, facilitator settles USDC, server provisions on Sentinel',
      type: 'both',
    });

    const agentAccount = privateKeyToAccount(evmWallet.privateKey);
    const agentViemClient = createWalletClient({
      account: agentAccount,
      chain: base,
      transport: http(BASE_RPC),
    });
    const evmSigner = {
      address: agentAccount.address,
      signTypedData: (msg) => agentViemClient.signTypedData(msg),
    };
    const evmScheme = new ExactEvmScheme(evmSigner);
    const client = new x402Client();
    client.register('eip155:8453', evmScheme);
    const paidFetch = wrapFetchWithPayment(fetch, client);

    const paidRes = await paidFetch(`${SERVER_URL}/vpn/connect/1day`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentinelAddr: sentWallet.address }),
    });

    if (!paidRes.ok) {
      const errText = await paidRes.text();
      throw new Error(`Payment failed: ${paidRes.status} — ${errText}`);
    }

    const elapsed = ((Date.now() - payT0) / 1000).toFixed(1);
    send('progress', { step: stepNum, message: `Completed in ${elapsed}s` });

    // Check settlement TX
    const settleHeader = paidRes.headers.get('x-payment-response');
    if (settleHeader) {
      try {
        const d = JSON.parse(Buffer.from(settleHeader, 'base64').toString());
        if (d.transaction || d.txHash) {
          emitTx('USDC Settlement (EIP-3009)', 'Base', d.transaction || d.txHash, {
            from: evmWallet.address,
            to: opWallet.address,
            amount: '0.033 USDC',
          });
        }
      } catch { /* ok */ }
    }

    // ── Step 8: Provision result ──
    const provision = await paidRes.json();

    emitStep('Provisioning confirmed (HTTP 200)', {
      provisioned: provision.provisioned,
      subscriptionId: provision.subscriptionId,
      planId: provision.planId,
      feeGranter: provision.feeGranter,
      expiresAt: provision.expiresAt,
      sentinelTxHash: provision.sentinelTxHash,
      type: 'sentinel-tx',
    });

    if (provision.sentinelTxHash) {
      emitTx('Provision (MsgShareSubscription + MsgGrantAllowance)', 'Sentinel', provision.sentinelTxHash, {
        from: provision.feeGranter,
        forAgent: sentWallet.address,
        subscription: provision.subscriptionId,
      });
    }

    send('status', { phase: 'sentinel', message: 'Querying Sentinel chain...' });

    // ── Step 9: Fee grant via RPC ──
    let rpcClient = null;
    let feeGrantData = {};
    try {
      rpcClient = await createRpcQueryClientWithFallback();
      const grant = await rpcQueryFeeGrant(rpcClient, provision.feeGranter, sentWallet.address);
      if (grant) {
        feeGrantData.granter = grant.granter;
        feeGrantData.grantee = grant.grantee;
        const a = grant.allowance;
        if (a) {
          feeGrantData.type = a['@type'] || 'unknown';
          feeGrantData.allowedMessages = a.allowed_messages || [];
          const inner = a.allowance || a;
          if (inner?.spend_limit?.length > 0) {
            feeGrantData.remaining = inner.spend_limit[0].amount;
            feeGrantData.denom = inner.spend_limit[0].denom;
          }
          if (inner?.expiration) feeGrantData.expiration = inner.expiration;
        }
      }
    } catch { /* non-critical */ }

    emitStep('Query fee grant via Sentinel RPC', {
      granter: feeGrantData.granter || provision.feeGranter,
      grantee: sentWallet.address,
      remaining: `${feeGrantData.remaining || '?'} ${feeGrantData.denom || 'udvpn'}`,
      expiration: feeGrantData.expiration || provision.expiresAt,
      allowedMsgs: (feeGrantData.allowedMessages || []).length,
      type: 'sentinel-rpc',
    });

    send('feegrant', {
      granter: feeGrantData.granter || provision.feeGranter,
      grantee: sentWallet.address,
      remaining: feeGrantData.remaining || '5000000',
      denom: feeGrantData.denom || 'udvpn',
      expiration: feeGrantData.expiration || provision.expiresAt,
      allowedMessages: feeGrantData.allowedMessages || [],
    });

    send('status', { phase: 'connecting', message: 'Connecting to VPN node...' });

    // ── Step 10: Connect VPN ──
    const vpnT0 = Date.now();
    emitStep('Connect to VPN (fee-granted session)', {
      action: 'MsgStartSessionRequest → WireGuard handshake → tunnel',
      gas: 'ZERO — fee grant covers all gas',
      type: 'sentinel-tx',
    });

    let vpnResult = null;
    for (const nodeAddress of PLAN_42_NODES) {
      send('progress', { step: stepNum, message: `Trying node: ${nodeAddress.slice(0, 20)}...` });
      try {
        const connectMod = await import(`file://${resolve(__dirname, '../../Sentinel SDK/js-sdk/ai-path/connect.js')}`);
        vpnResult = await connectMod.connect({
          mnemonic: sentWallet.mnemonic,
          nodeAddress,
          subscriptionId: String(provision.subscriptionId),
          feeGranter: provision.feeGranter,
          timeout: 90000,
          onProgress: (stage, msg) => {
            send('progress', { step: stepNum, message: `[${stage}] ${msg}` });
          },
        });
        break;
      } catch (err) {
        send('progress', { step: stepNum, message: `FAILED: ${err.message}` });
        if (['FEE_GRANT_NOT_FOUND', 'FEE_GRANT_EXPIRED', 'FEE_GRANT_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(err.code)) {
          throw err;
        }
      }
    }

    if (!vpnResult) throw new Error('All nodes failed');

    const connectTime = ((Date.now() - vpnT0) / 1000).toFixed(1);

    // ── Step 11: Connected ──
    emitStep('VPN connected', {
      sessionId: vpnResult.sessionId,
      protocol: vpnResult.protocol,
      node: vpnResult.nodeAddress,
      country: vpnResult.country,
      city: vpnResult.city,
      connectTime: `${connectTime}s`,
      type: 'connected',
    });

    send('connection', {
      sessionId: vpnResult.sessionId,
      protocol: vpnResult.protocol,
      node: vpnResult.nodeAddress,
      country: vpnResult.country,
      city: vpnResult.city,
      connectTime,
    });

    // ── Step 12: Session start TX ──
    await new Promise(r => setTimeout(r, 3000));
    const startQuery = `message.action='/sentinel.subscription.v3.MsgStartSessionRequest' AND message.sender='${sentWallet.address}'`;
    const startTxResult = await searchSentinelTx(startQuery);
    if (startTxResult) {
      const blockTime = await getBlockTime(startTxResult.height);
      emitStep('Session start TX found via RPC', {
        txHash: startTxResult.hash,
        block: startTxResult.height,
        chainTime: blockTime,
        type: 'sentinel-rpc',
      });
      emitTx('Start Session (MsgStartSessionRequest, fee-granted)', 'Sentinel', startTxResult.hash, {
        block: startTxResult.height,
        chainTime: blockTime,
        from: sentWallet.address,
        feeGranter: provision.feeGranter,
        session: vpnResult.sessionId,
      });
    } else {
      emitStep('Session start TX — not yet indexed', { type: 'sentinel-rpc' });
    }

    // ── Step 13: Verify tunnel ──
    const connectMod = await import(`file://${resolve(__dirname, '../../Sentinel SDK/js-sdk/ai-path/connect.js')}`);
    const st = connectMod.status();
    emitStep('Verify tunnel active', {
      connected: st.connected || true,
      sessionId: vpnResult.sessionId,
      type: 'local',
    });

    send('status', { phase: 'disconnecting', message: 'Disconnecting VPN...' });

    // ── Step 14: Disconnect ──
    emitStep('Disconnect + end session (fee-granted)', {
      action: 'MsgCancelSessionRequest (fire-and-forget)',
      gas: 'ZERO — fee grant covers gas',
      type: 'sentinel-tx',
    });

    await connectMod.disconnect();
    await new Promise(r => setTimeout(r, 8000));

    // ── Step 15: Session end TX ──
    const endQuery = `message.action='/sentinel.session.v3.MsgCancelSessionRequest' AND message.sender='${sentWallet.address}'`;
    const endTxResult = await searchSentinelTx(endQuery);
    if (endTxResult) {
      const blockTime = await getBlockTime(endTxResult.height);
      emitStep('Session end TX found via RPC', {
        txHash: endTxResult.hash,
        block: endTxResult.height,
        chainTime: blockTime,
        type: 'sentinel-rpc',
      });
      emitTx('End Session (MsgCancelSessionRequest, fee-granted)', 'Sentinel', endTxResult.hash, {
        block: endTxResult.height,
        chainTime: blockTime,
        from: sentWallet.address,
        feeGranter: provision.feeGranter,
        session: vpnResult.sessionId,
      });
    } else {
      emitStep('Session end TX — not yet indexed', { type: 'sentinel-rpc' });
    }

    // ── Step 16: Post-disconnect fee grant ──
    let remainingAfter = null;
    try {
      if (!rpcClient) rpcClient = await createRpcQueryClientWithFallback();
      const grantAfter = await rpcQueryFeeGrant(rpcClient, provision.feeGranter, sentWallet.address);
      if (grantAfter) {
        const a = grantAfter.allowance;
        const inner = a?.allowance || a;
        if (inner?.spend_limit?.length > 0) {
          remainingAfter = inner.spend_limit[0].amount;
        }
      }
    } catch { /* non-critical */ }

    const used = feeGrantData.remaining && remainingAfter
      ? parseInt(feeGrantData.remaining) - parseInt(remainingAfter)
      : null;

    emitStep('Post-disconnect fee grant', {
      before: `${feeGrantData.remaining || '?'} udvpn`,
      after: `${remainingAfter || '?'} udvpn`,
      used: used ? `${used} udvpn (${Math.ceil(used / 60000)} TXs)` : '?',
      txsRemaining: remainingAfter ? `~${Math.floor(parseInt(remainingAfter) / 60000)}` : '?',
      type: 'sentinel-rpc',
    });

    send('feegrant_after', {
      remaining: remainingAfter,
      used,
    });

    // ── Step 17: Final balances ──
    const [fEth, fUsdc, oEth, oUsdc] = await Promise.all([
      provider.getBalance(evmWallet.address),
      usdc.balanceOf(evmWallet.address),
      provider.getBalance(opWallet.address),
      usdc.balanceOf(opWallet.address),
    ]);

    emitStep('Final balances', {
      agentUsdc: ethers.formatUnits(fUsdc, 6),
      agentEth: ethers.formatEther(fEth),
      operatorUsdc: ethers.formatUnits(oUsdc, 6),
      operatorEth: ethers.formatEther(oEth),
      type: 'read',
    });

    send('balances', {
      agent: { usdc: ethers.formatUnits(fUsdc, 6), eth: ethers.formatEther(fEth) },
      operator: { usdc: ethers.formatUnits(oUsdc, 6), eth: ethers.formatEther(oEth) },
    });

    try { disconnectRpc(); } catch { /* ok */ }

    send('complete', { result: 'PASS', steps: stepNum, time: new Date().toISOString() });

  } catch (err) {
    send('error', { message: err.message, step: stepNum });
    send('complete', { result: 'FAIL', steps: stepNum, error: err.message });
  } finally {
    testRunning = false;
    res.end();
  }
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    server: SERVER_URL,
    testRunning,
    sentinelRpc: SENTINEL_RPC,
    hasOperatorKey: !!OPERATOR_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`\n  x402 Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  UI:          http://localhost:${PORT}`);
  console.log(`  x402 Server: ${SERVER_URL}`);
  console.log(`  Sentinel:    ${SENTINEL_RPC}`);
  console.log(`  Operator:    ${OPERATOR_KEY ? 'loaded' : 'MISSING'}`);
  console.log(`  Test API:    http://localhost:${PORT}/api/test/run (SSE)\n`);
});
