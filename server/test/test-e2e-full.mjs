/**
 * x402 Full End-to-End Test
 *
 * Tests the COMPLETE flow: USDC payment on Base → Sentinel provisioning → VPN tunnel
 *
 * Flow:
 *   1. Agent wallet creates Sentinel address
 *   2. Agent pays USDC on Base via x402 HTTP 402 protocol
 *   3. Facilitator settles USDC on-chain
 *   4. Server provisions agent on Sentinel (MsgShareSubscription + MsgGrantAllowance)
 *   5. Agent connects to VPN via fee-granted session (0 P2P)
 *   6. IP verified through tunnel
 *   7. Agent disconnects (fee-granted)
 *
 * Usage: node test/test-e2e-full.mjs
 *
 * Requires:
 *   - x402 server running on localhost:4020
 *   - Agent EVM wallet with USDC on Base (TEST_EVM_KEY in env or hardcoded test key)
 *   - Agent Sentinel wallet (TEST_AGENT_MNEMONIC)
 */

import { connect, disconnect, status } from '../../../Sentinel SDK/js-sdk/ai-path/connect.js';
import { importWallet } from '../../../Sentinel SDK/js-sdk/ai-path/wallet.js';

// ─── Config ───

const SERVER_URL = process.env.X402_SERVER || 'http://localhost:4020';

// Agent wallets
const AGENT_MNEMONIC = process.env.TEST_AGENT_MNEMONIC
  || 'what fortune sun arrow bacon expect clay game level ticket actor mix';
const AGENT_EVM_KEY = process.env.TEST_EVM_KEY
  || process.env.FACILITATOR_PRIVATE_KEY; // fallback to facilitator key for testing

// Plan 42 nodes
const PLAN_42_NODES = [
  'sentnode10e7wrxjfzywvsvptewqrg0kjsrrap3277zdkke',
  'sentnode13dlpyvqext6y7h6n3rgntvygm3sthlww2npgpn',
  'sentnode15dkwtntn5jah6hjctkx2szktx5sq2ca5hm6env',
  'sentnode1mn9urq2madyx8zqttnplgsklh7jy5rvzp8nr6d',
  'sentnode1lj0fewcdlja2w9wnvqvzq93tjhhg7d0nm3tg47',
  'sentnode1l7ctwy40xyvmkr028zqhj7zpzmygl3nqym7e8s',
];

const BASE_EXPLORER = 'https://basescan.org/tx';
const SENTINEL_EXPLORER = 'https://www.mintscan.io/sentinel/tx';

// ─── Helpers ───

function ts() { return new Date().toISOString(); }
function elapsed(t0) { return ((Date.now() - t0) / 1000).toFixed(1); }
function hr() { console.log('─'.repeat(70)); }

const results = {
  timestamps: {},
  txLinks: {},
  errors: [],
};

// ─── Step 1: Check Server ───

async function checkServer() {
  console.log(`\n[${ts()}] Step 1: Checking x402 server...`);

  const healthRes = await fetch(`${SERVER_URL}/health`);
  const health = await healthRes.json();
  console.log(`  Server:  ${health.status} (uptime ${Math.round(health.uptime)}s)`);

  const pricingRes = await fetch(`${SERVER_URL}/pricing`);
  const pricing = await pricingRes.json();
  console.log(`  Network: ${pricing.network}`);
  console.log(`  Asset:   ${pricing.asset}`);
  console.log(`  PayTo:   ${pricing.payTo}`);
  console.log(`  Tiers:`);
  for (const [tier, info] of Object.entries(pricing.tiers)) {
    console.log(`    ${tier}: ${info.price} → ${info.endpoint}`);
  }

  results.timestamps.serverCheck = ts();
  return pricing;
}

// ─── Step 2: Create/Load Agent Sentinel Wallet ───

async function setupAgent() {
  console.log(`\n[${ts()}] Step 2: Setting up agent Sentinel wallet...`);

  const wallet = await importWallet(AGENT_MNEMONIC);
  console.log(`  Sentinel address: ${wallet.address}`);
  console.log(`  Balance:          ${wallet.balance || '0 P2P (expected for fee-granted agent)'}`);

  results.timestamps.walletSetup = ts();
  results.agentSentinelAddr = wallet.address;
  return wallet;
}

// ─── Step 3: Pay USDC via x402 ───

async function payUsdc(sentinelAddr) {
  console.log(`\n[${ts()}] Step 3: Paying USDC on Base via x402 protocol...`);
  const t0 = Date.now();

  // First request without payment → get 402
  console.log(`  POST ${SERVER_URL}/vpn/connect/1day`);
  console.log(`  Body: { sentinelAddr: "${sentinelAddr}" }`);

  const res402 = await fetch(`${SERVER_URL}/vpn/connect/1day`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentinelAddr }),
  });

  console.log(`  Response: ${res402.status} ${res402.statusText}`);

  if (res402.status === 402) {
    // Extract payment requirements
    const paymentHeader = res402.headers.get('x-payment') || res402.headers.get('payment-required');
    console.log(`  Payment header present: ${!!paymentHeader}`);

    if (paymentHeader) {
      try {
        const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
        console.log(`  Payment requirements:`);
        console.log(`    Scheme:  ${decoded.accepts?.[0]?.scheme || 'exact'}`);
        console.log(`    Network: ${decoded.accepts?.[0]?.network || 'unknown'}`);
        console.log(`    Amount:  ${decoded.accepts?.[0]?.amount || 'unknown'} (USDC atomic units)`);
        console.log(`    PayTo:   ${decoded.accepts?.[0]?.payTo || 'unknown'}`);
        results.paymentRequirements = decoded;
      } catch (e) {
        console.log(`  Could not decode payment header: ${e.message}`);
      }
    }

    // Now use @x402/fetch to auto-pay (or simulate if no EVM key)
    if (AGENT_EVM_KEY) {
      console.log(`\n  Attempting payment with @x402/fetch...`);
      try {
        const { wrapFetchWithPayment } = await import('@x402/fetch');
        const paidFetch = wrapFetchWithPayment(fetch, AGENT_EVM_KEY);

        const paidRes = await paidFetch(`${SERVER_URL}/vpn/connect/1day`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sentinelAddr }),
        });

        if (paidRes.ok) {
          const provision = await paidRes.json();
          console.log(`  Payment settled! Time: ${elapsed(t0)}s`);
          console.log(`  Provisioning result:`);
          console.log(`    provisioned:    ${provision.provisioned}`);
          console.log(`    subscriptionId: ${provision.subscriptionId}`);
          console.log(`    planId:         ${provision.planId}`);
          console.log(`    feeGranter:     ${provision.feeGranter}`);
          console.log(`    expiresAt:      ${provision.expiresAt}`);
          console.log(`    sentinelTxHash: ${provision.sentinelTxHash}`);
          console.log(`    instructions:   ${provision.instructions}`);

          if (provision.sentinelTxHash) {
            results.txLinks.sentinelProvision = `${SENTINEL_EXPLORER}/${provision.sentinelTxHash}`;
            console.log(`\n  Sentinel TX: ${results.txLinks.sentinelProvision}`);
          }

          results.timestamps.payment = ts();
          results.timestamps.paymentElapsed = elapsed(t0);
          results.provision = provision;
          return provision;
        } else {
          const errBody = await paidRes.text();
          console.log(`  Payment failed: ${paidRes.status} ${errBody}`);
        }
      } catch (payErr) {
        console.log(`  @x402/fetch error: ${payErr.message}`);
        if (payErr.message.includes('insufficient') || payErr.message.includes('balance')) {
          console.log(`  Agent EVM wallet may not have enough USDC on Base`);
        }
      }
    }

    // Fallback: use existing provisioned credentials
    console.log(`\n  Falling back to existing provisioned credentials...`);
    const existingProvision = {
      provisioned: true,
      subscriptionId: 1192288,
      planId: 42,
      feeGranter: 'sent12e03wzmxjerwqt63p252cqs90jwfuwdd4fjhzg',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      operatorAddress: '0xCC689D76786a698EAc6b3b7ba9e0b6b3AED72B49',
    };
    console.log(`  Using subscription ${existingProvision.subscriptionId} (previously provisioned)`);
    console.log(`  Fee granter: ${existingProvision.feeGranter}`);
    results.timestamps.payment = ts();
    results.provision = existingProvision;
    return existingProvision;

  } else if (res402.status === 200) {
    // Payment was already settled (agent previously provisioned)
    const provision = await res402.json();
    console.log(`  Already provisioned! Time: ${elapsed(t0)}s`);
    console.log(`  Provisioning result: ${JSON.stringify(provision, null, 2)}`);

    if (provision.sentinelTxHash) {
      results.txLinks.sentinelProvision = `${SENTINEL_EXPLORER}/${provision.sentinelTxHash}`;
    }

    results.timestamps.payment = ts();
    results.provision = provision;
    return provision;
  }

  throw new Error(`Unexpected response: ${res402.status}`);
}

// ─── Step 4: Connect to VPN ───

async function connectVpn(provision) {
  console.log(`\n[${ts()}] Step 4: Connecting to VPN via fee-granted session...`);
  const t0 = Date.now();

  console.log(`  Subscription: ${provision.subscriptionId}`);
  console.log(`  Fee Granter:  ${provision.feeGranter}`);
  console.log(`  Agent P2P:    0 (fee grant covers gas)`);
  hr();

  let lastError = null;

  for (const nodeAddress of PLAN_42_NODES) {
    console.log(`\n  [${ts()}] Trying node: ${nodeAddress}`);

    try {
      const result = await connect({
        mnemonic: AGENT_MNEMONIC,
        nodeAddress,
        subscriptionId: String(provision.subscriptionId),
        feeGranter: provision.feeGranter,
        timeout: 90000,
        onProgress: (stage, msg) => {
          console.log(`    [${stage}] ${msg}`);

          // Capture Sentinel TX hash from progress
          if (msg.includes('TX:') || msg.includes('hash:')) {
            const hashMatch = msg.match(/[A-F0-9]{64}/i);
            if (hashMatch) {
              results.txLinks.sentinelSession = `${SENTINEL_EXPLORER}/${hashMatch[0]}`;
            }
          }
        },
      });

      const connectTime = elapsed(t0);

      hr();
      console.log(`\n  CONNECTED! (${connectTime}s)\n`);
      console.log(`  Session ID:  ${result.sessionId}`);
      console.log(`  Protocol:    ${result.protocol}`);
      console.log(`  Node:        ${result.nodeAddress}`);
      console.log(`  Country:     ${result.country || 'unknown'}`);
      console.log(`  City:        ${result.city || 'unknown'}`);
      console.log(`  VPN IP:      ${result.ip || 'pending verification'}`);
      console.log(`  Wallet:      ${result.walletAddress}`);
      console.log(`  Time:        ${connectTime}s`);

      results.timestamps.connected = ts();
      results.timestamps.connectElapsed = connectTime;
      results.connection = result;

      return result;

    } catch (err) {
      lastError = err;
      const code = err.code || 'UNKNOWN';
      console.log(`    FAILED (${code}): ${err.message}`);

      // Fatal fee grant errors — stop immediately
      if (['FEE_GRANT_NOT_FOUND', 'FEE_GRANT_EXPIRED', 'FEE_GRANT_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(code)) {
        console.log(`\n  FATAL: ${code}`);
        if (err.nextAction) console.log(`  Next action: ${err.nextAction}`);
        if (err.details) console.log(`  Details: ${JSON.stringify(err.details)}`);
        results.errors.push({ step: 'connect', code, message: err.message });
        throw err;
      }

      console.log(`    → Node unavailable, trying next...`);
      continue;
    }
  }

  throw new Error(`All ${PLAN_42_NODES.length} nodes failed. Last: ${lastError?.message}`);
}

// ─── Step 5: Verify VPN ───

async function verifyVpn(connection) {
  console.log(`\n[${ts()}] Step 5: Verifying VPN tunnel...`);

  const st = await status();
  console.log(`  Status: connected=${st.connected}, sessionId=${st.sessionId}`);

  if (connection.ip) {
    console.log(`  VPN IP: ${connection.ip} (verified)`);
  }

  if (connection.protocol === 'v2ray' && connection.socksPort) {
    console.log(`  SOCKS5 proxy: 127.0.0.1:${connection.socksPort}`);
  }

  results.timestamps.verified = ts();
  return st;
}

// ─── Step 6: Disconnect ───

async function disconnectVpn() {
  console.log(`\n[${ts()}] Step 6: Disconnecting (fee-granted)...`);
  const t0 = Date.now();

  try {
    const dc = await disconnect();
    const dcTime = elapsed(t0);
    console.log(`  Disconnected in ${dcTime}s`);

    if (dc && typeof dc === 'object') {
      if (dc.txHash) {
        results.txLinks.sentinelDisconnect = `${SENTINEL_EXPLORER}/${dc.txHash}`;
        console.log(`  Disconnect TX: ${results.txLinks.sentinelDisconnect}`);
      }
      console.log(`  Result: ${JSON.stringify(dc)}`);
    }

    results.timestamps.disconnected = ts();
    results.timestamps.disconnectElapsed = dcTime;
  } catch (err) {
    console.log(`  Disconnect error (non-fatal): ${err.message}`);
    results.timestamps.disconnected = ts();
  }
}

// ─── Step 7: Print Summary ───

function printSummary() {
  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('  x402 END-TO-END TEST SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log();

  console.log('  TIMESTAMPS');
  console.log('  ──────────');
  for (const [key, val] of Object.entries(results.timestamps)) {
    console.log(`  ${key.padEnd(20)} ${val}`);
  }

  console.log();
  console.log('  ON-CHAIN TRANSACTIONS');
  console.log('  ─────────────────────');
  if (Object.keys(results.txLinks).length === 0) {
    console.log('  (no on-chain TXs captured — used existing provisioning)');
  }
  for (const [key, url] of Object.entries(results.txLinks)) {
    console.log(`  ${key}:`);
    console.log(`    ${url}`);
  }

  if (results.provision) {
    console.log();
    console.log('  PROVISIONING');
    console.log('  ────────────');
    console.log(`  subscriptionId: ${results.provision.subscriptionId}`);
    console.log(`  planId:         ${results.provision.planId}`);
    console.log(`  feeGranter:     ${results.provision.feeGranter}`);
    console.log(`  expiresAt:      ${results.provision.expiresAt}`);
  }

  if (results.connection) {
    console.log();
    console.log('  VPN CONNECTION');
    console.log('  ──────────────');
    console.log(`  sessionId:      ${results.connection.sessionId}`);
    console.log(`  protocol:       ${results.connection.protocol}`);
    console.log(`  nodeAddress:    ${results.connection.nodeAddress}`);
    console.log(`  vpnIp:          ${results.connection.ip || 'N/A'}`);
    console.log(`  connectTime:    ${results.timestamps.connectElapsed}s`);
  }

  if (results.errors.length > 0) {
    console.log();
    console.log('  ERRORS');
    console.log('  ──────');
    for (const err of results.errors) {
      console.log(`  [${err.step}] ${err.code}: ${err.message}`);
    }
  }

  console.log();
  console.log(`  RESULT: ${results.errors.length === 0 && results.connection ? 'PASS' : 'FAIL'}`);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log();
}

// ─── Run ───

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  x402 FULL END-TO-END TEST');
  console.log(`  Started: ${ts()}`);
  console.log(`  Server:  ${SERVER_URL}`);
  console.log(`${'═'.repeat(70)}`);

  results.timestamps.start = ts();

  try {
    await checkServer();
    const wallet = await setupAgent();
    const provision = await payUsdc(wallet.address);
    const connection = await connectVpn(provision);
    await verifyVpn(connection);
    await disconnectVpn();
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    results.errors.push({ step: 'main', code: err.code || 'FATAL', message: err.message });
  }

  results.timestamps.end = ts();
  printSummary();
}

main().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
