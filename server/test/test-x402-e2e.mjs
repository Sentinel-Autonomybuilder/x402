/**
 * x402 Full E2E Test — Real USDC Payment → Facilitator Settlement → Sentinel Provisioning
 *
 * Flow:
 *   1. Generate fresh EVM wallet (agent)
 *   2. Fund it from operator (USDC + gas ETH)
 *   3. Generate fresh Sentinel wallet
 *   4. Call POST /vpn/connect/1day via @x402/fetch (auto-handles 402 → payment → retry)
 *   5. Verify Sentinel provisioning (subscription share + fee grant)
 *
 * Prereqs:
 *   - Server running on :4020 with facilitator on :4021
 *   - Operator wallet funded with USDC + ETH on Base
 */

import { config } from 'dotenv';
import {
  createWalletClient,
  createPublicClient,
  http,
  formatUnits,
  parseUnits,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base } from 'viem/chains';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { generateWallet } from 'blue-js-sdk';

config({ path: '../.env' });
config(); // server .env

// ─── Config ───

const SERVER_URL = 'http://localhost:4020';
const OPERATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'eip155:8453';

// Minimal ERC-20 ABI
const ERC20_ABI = [
  { inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'transfer', outputs: [{ type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], name: 'allowance', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
];

// ─── Helpers ───

function step(n, msg) {
  console.log(`\n  [${'='.repeat(n)}${' '.repeat(6 - n)}] Step ${n}: ${msg}`);
}

function ok(msg) { console.log(`    ✓ ${msg}`); }
function info(msg) { console.log(`    · ${msg}`); }
function fail(msg) { console.error(`    ✗ ${msg}`); }

// ─── Main ───

async function main() {
  console.log('\n══════════════════════════════════════');
  console.log('  x402 Full E2E Test');
  console.log('  USDC on Base → Facilitator → Sentinel');
  console.log('══════════════════════════════════════\n');

  if (!OPERATOR_KEY) {
    fail('FACILITATOR_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  // Shared public client
  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  // ─── Step 1: Generate fresh EVM wallet (agent) ───
  step(1, 'Generate agent EVM wallet');

  const agentKey = generatePrivateKey();
  const agentAccount = privateKeyToAccount(agentKey);
  ok(`Address: ${agentAccount.address}`);
  info(`Key: ${agentKey.slice(0, 10)}...${agentKey.slice(-6)}`);

  // ─── Step 2: Fund agent wallet (USDC + ETH from operator) ───
  step(2, 'Fund agent wallet from operator');

  const operatorAccount = privateKeyToAccount(OPERATOR_KEY);
  const operatorWallet = createWalletClient({
    account: operatorAccount,
    chain: base,
    transport: http(),
  });

  // Transfer 0.05 USDC (50000 atomic) — enough for the $0.033 1-day tier + buffer
  const usdcAmount = parseUnits('0.05', 6);
  info(`Transferring 0.05 USDC to agent...`);

  const usdcTx = await operatorWallet.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [agentAccount.address, usdcAmount],
  });
  ok(`USDC transfer TX: ${usdcTx}`);

  // Wait for USDC transfer to confirm
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcTx });
  ok(`USDC transfer confirmed (block ${usdcReceipt.blockNumber})`);

  // x402 uses EIP-3009 (off-chain signatures) — agent does NOT need ETH for gas.
  // The facilitator settles the transferWithAuthorization on behalf of the agent.
  info('No ETH needed — x402 uses off-chain EIP-3009 signatures');

  // Verify USDC balance (wait a moment for state to propagate)
  await new Promise(r => setTimeout(r, 2000));
  const agentUsdc = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [agentAccount.address],
  });
  ok(`Agent USDC: ${formatUnits(agentUsdc, 6)}`);

  // ─── Step 3: Generate fresh Sentinel wallet ───
  step(3, 'Generate agent Sentinel wallet');

  const { wallet: sentWallet, account: sentAccount, mnemonic: sentMnemonic } = await generateWallet();
  ok(`Sentinel address: ${sentAccount.address}`);
  info(`Mnemonic: ${sentMnemonic.split(' ').slice(0, 3).join(' ')}...`);

  // ─── Step 4: Call x402 server — pay USDC and get VPN provisioned ───
  step(4, 'Call x402 server (POST /vpn/connect/1day)');

  // Create x402 payment scheme — account has .address + .signTypedData
  const evmScheme = new ExactEvmScheme(agentAccount);

  // Wrap fetch with x402 payment handling
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{
      network: NETWORK,
      client: evmScheme,
    }],
  });

  info('Sending request (will get 402 → sign payment → retry with proof)...');

  const startTime = Date.now();
  const response = await fetchWithPayment(`${SERVER_URL}/vpn/connect/1day`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sentinelAddr: sentAccount.address,
    }),
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  info(`Response: ${response.status} (${elapsed}s)`);

  if (!response.ok) {
    const text = await response.text();
    fail(`Server returned ${response.status}: ${text}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log('\n    ── Provisioning Result ──');
  console.log(JSON.stringify(result, null, 2).split('\n').map(l => '    ' + l).join('\n'));

  if (result.provisioned) {
    ok(`VPN provisioned for ${result.days} day(s)!`);
    ok(`Subscription: ${result.subscriptionId}`);
    ok(`Sentinel TX: ${result.sentinelTxHash}`);
    ok(`Expires: ${result.expiresAt}`);
  } else if (result.error) {
    fail(result.error);
    if (result.detail) fail(result.detail);
  }

  // ─── Step 5: Verify Sentinel state ───
  step(5, 'Verify Sentinel provisioning');

  // Check agent status via our API
  const statusRes = await fetch(`${SERVER_URL}/agent/${sentAccount.address}`);
  const status = await statusRes.json();
  ok(`Has subscription: ${status.hasSubscription}`);
  if (status.subscriptionId) ok(`Subscription ID: ${status.subscriptionId}`);

  // Check fee grant on Sentinel LCD
  const LCD = 'https://lcd.sentinel.co';
  try {
    const grantRes = await fetch(`${LCD}/cosmos/feegrant/v1beta1/allowances/${sentAccount.address}`);
    const grantData = await grantRes.json();
    const grants = grantData.allowances || [];
    if (grants.length > 0) {
      ok(`Fee grants: ${grants.length}`);
      for (const g of grants) {
        info(`  Granter: ${g.granter} → Grantee: ${g.grantee}`);
      }
    } else {
      info('No fee grants found yet (may be pending)');
    }
  } catch (err) {
    info(`Fee grant check failed: ${err.message}`);
  }

  // ─── Step 6: Verify USDC settlement ───
  step(6, 'Verify USDC settlement on Base');

  const [opUsdcAfter, agentUsdcAfter] = await Promise.all([
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [operatorAccount.address],
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [agentAccount.address],
    }),
  ]);
  ok(`Operator USDC after: ${formatUnits(opUsdcAfter, 6)}`);
  ok(`Agent USDC after:    ${formatUnits(agentUsdcAfter, 6)}`);
  info(`Agent spent: ${formatUnits(agentUsdc - agentUsdcAfter, 6)} USDC`);

  // ─── Summary ───
  console.log('\n══════════════════════════════════════');
  console.log('  E2E Test Complete');
  console.log('══════════════════════════════════════');
  console.log(`  Agent EVM:      ${agentAccount.address}`);
  console.log(`  Agent Sentinel: ${sentAccount.address}`);
  console.log(`  USDC paid:      ${formatUnits(agentUsdc - agentUsdcAfter, 6)}`);
  console.log(`  Provisioned:    ${result.provisioned ? 'YES' : 'NO'}`);
  if (result.sentinelTxHash) {
    console.log(`  Sentinel TX:    ${result.sentinelTxHash}`);
  }
  console.log(`  Total time:     ${elapsed}s`);
  console.log('══════════════════════════════════════\n');

  // Save test wallet info for potential future use
  console.log('  Test wallets (disposable):');
  console.log(`    EVM key:          ${agentKey}`);
  console.log(`    Sentinel mnemonic: ${sentMnemonic}`);
  console.log('');
}

main().catch(err => {
  console.error('\n  FATAL:', err.message);
  if (err.cause) console.error('  Cause:', err.cause);
  console.error(err.stack);
  process.exit(1);
});
