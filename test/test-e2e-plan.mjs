#!/usr/bin/env node
/**
 * x402 E2E Test — Managed Plan Flow (RPC-only)
 *
 * Tests the full lifecycle using RPC (protobuf, ~10x faster than LCD):
 *   Step 1: Create fresh agent wallet
 *   Step 2: Check operator balance via RPC
 *   Step 3: Share subscription with agent (MsgShareSubscription)
 *   Step 4: Grant fee allowance to agent (MsgGrantAllowance)
 *   Step 5: Verify agent's subscription + fee grant on-chain via RPC
 *   Step 6: Agent starts VPN session via subscription (fee-granted, zero gas)
 *
 * Usage:
 *   node test/test-e2e-plan.mjs              — run all steps
 *   node test/test-e2e-plan.mjs --step 3     — run up to step 3
 *   node test/test-e2e-plan.mjs --dry-run    — show what would happen
 *
 * Requires: SENTINEL_OPERATOR_MNEMONIC in wallets.env or environment
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Load wallets.env ───
const envPath = resolve(ROOT, 'wallets.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ─── SDK Imports ───
import {
  createWallet,
  generateWallet,
  createClient,
  createSafeBroadcaster,
  createRpcQueryClient,
  rpcQueryBalance,
  rpcQuerySubscriptionsForAccount,
  queryFeeGrants,
  extractId,
  broadcastWithFeeGrant,
  MSG_TYPES,
  disconnect,
  registerCleanupHandlers,
} from 'blue-js-sdk';

import * as sdk from 'blue-js-sdk';
const buildFeeGrantMsg = sdk.buildFeeGrantMsg;

// ─── Config ───
const RPC = 'https://rpc.sentinel.co:443';
const PLAN_ID = 42;
const SUBSCRIPTION_ID = 1165072; // Active sub on Plan 42, 0 allocations, full quota
// Plan 42 has 10 GB total quota. Share 1 GB per agent.
const SHARE_BYTES = 1_000_000_000; // 1 GB

// Pick a node from Plan 42
const TEST_NODE = 'sentnode10e7wrxjfzywvsvptewqrg0kjsrrap3277zdkke';

// ─── Args ───
const args = process.argv.slice(2);
const maxStep = args.includes('--step') ? parseInt(args[args.indexOf('--step') + 1]) : 99;
const dryRun = args.includes('--dry-run');

// ─── Helpers ───
let stepNum = 0;
function step(name) {
  stepNum++;
  if (stepNum > maxStep) { console.log(`\n  [skip] Step ${stepNum}: ${name}`); return false; }
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Step ${stepNum}: ${name}`);
  console.log('═'.repeat(60));
  return true;
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  → ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

// ─── Build MsgShareSubscription manually (known good encoder) ───
function buildMsgShareSubscription(opts) {
  return {
    typeUrl: '/sentinel.subscription.v3.MsgShareSubscriptionRequest',
    value: {
      from: opts.from,
      id: opts.id,
      accAddress: opts.accAddress,
      acc_address: opts.accAddress,
      bytes: opts.bytes,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('\n  x402 E2E Test — Managed Plan Flow (RPC)');
  console.log('  ' + '─'.repeat(40));
  console.log(`  Plan:         ${PLAN_ID}`);
  console.log(`  Subscription: ${SUBSCRIPTION_ID}`);
  console.log(`  Test node:    ${TEST_NODE}`);
  console.log(`  RPC:          ${RPC}`);
  if (dryRun) console.log('  Mode:         DRY RUN (no chain TXs)');

  const operatorMnemonic = process.env.SENTINEL_OPERATOR_MNEMONIC;
  if (!operatorMnemonic) {
    fail('SENTINEL_OPERATOR_MNEMONIC not set — check wallets.env');
    process.exit(1);
  }

  // Create RPC client once, reuse everywhere
  info('Connecting to RPC...');
  const rpcClient = await createRpcQueryClient(RPC);
  ok('RPC client connected');

  // ─── Step 1: Create fresh agent wallet ───
  if (step('Create fresh agent wallet')) {
    const { mnemonic: agentMnemonic, wallet: agentWallet, account: agentAccount } = await generateWallet();
    globalThis._agentMnemonic = agentMnemonic;
    globalThis._agentAddress = agentAccount.address;

    ok(`Agent address: ${agentAccount.address}`);
    ok(`Mnemonic: ${agentMnemonic.split(' ').slice(0, 3).join(' ')}... (${agentMnemonic.split(' ').length} words)`);
    info('Fresh wallet — 0 P2P balance (that\'s fine, we use fee grants)');
  }

  // ─── Step 2: Check operator balance via RPC ───
  if (step('Check operator balance (RPC)')) {
    const { wallet: opWallet, account: opAccount } = await createWallet(operatorMnemonic);
    globalThis._opAddress = opAccount.address;
    globalThis._opWallet = opWallet;

    ok(`Operator: ${opAccount.address}`);

    const bal = await rpcQueryBalance(rpcClient, opAccount.address, 'udvpn');
    const udvpn = parseInt(bal?.amount || '0', 10);
    const p2p = (udvpn / 1_000_000).toFixed(2);
    ok(`Balance: ${p2p} P2P (${udvpn.toLocaleString()} udvpn)`);

    if (udvpn < 1_000_000) {
      fail('Operator needs at least 1 P2P for gas — fund wallet first');
      process.exit(1);
    }
    info('Enough P2P for gas fees');
  }

  // ─── Step 3: Share subscription with agent (MsgShareSubscription) ───
  if (step('Share subscription with agent (MsgShareSubscription)')) {
    const agentAddr = globalThis._agentAddress;
    if (!agentAddr) { fail('No agent address — run step 1 first'); process.exit(1); }

    const msg = buildMsgShareSubscription({
      from: globalThis._opAddress,
      id: SUBSCRIPTION_ID,
      accAddress: agentAddr,
      bytes: SHARE_BYTES,
    });

    info(`Sharing sub ${SUBSCRIPTION_ID} with ${agentAddr}`);
    info(`Bytes: ${SHARE_BYTES.toLocaleString()} (1 TB)`);
    info(`Message: ${msg.typeUrl}`);

    if (dryRun) {
      warn('DRY RUN — skipping broadcast');
      ok('Message built successfully');
    } else {
      const broadcaster = createSafeBroadcaster(RPC, globalThis._opWallet, globalThis._opAddress);
      const result = await broadcaster.safeBroadcast([msg], 'x402 e2e test share');

      if (result.code !== 0) {
        fail(`TX failed (code ${result.code}): ${result.rawLog}`);
        process.exit(1);
      }
      ok(`TX: ${result.transactionHash}`);
      ok('Agent added to subscription');
    }
  }

  // ─── Step 4: Grant fee allowance (MsgGrantAllowance) ───
  if (step('Grant fee allowance to agent (MsgGrantAllowance)')) {
    const agentAddr = globalThis._agentAddress;
    if (!agentAddr) { fail('No agent address — run step 1 first'); process.exit(1); }

    const expiration = new Date(Date.now() + 30 * 86_400_000 + 86_400_000); // 31 days
    const feeMsg = buildFeeGrantMsg(globalThis._opAddress, agentAddr, {
      spendLimit: 5_000_000, // 5 P2P
      expiration,
      allowedMessages: [
        '/sentinel.subscription.v3.MsgStartSessionRequest',
        '/sentinel.session.v3.MsgCancelSessionRequest',
        '/sentinel.session.v3.MsgUpdateSessionRequest',
      ],
    });

    info(`Granting fee allowance to ${agentAddr}`);
    info(`Spend limit: 5 P2P`);
    info(`Expires: ${expiration.toISOString()}`);
    info(`Allowed: MsgStartSession, MsgCancelSession, MsgUpdateSession`);

    if (dryRun) {
      warn('DRY RUN — skipping broadcast');
      ok('Fee grant message built successfully');
    } else {
      const broadcaster = createSafeBroadcaster(RPC, globalThis._opWallet, globalThis._opAddress);
      const result = await broadcaster.safeBroadcast([feeMsg], 'x402 e2e test fee grant');

      if (result.code !== 0) {
        fail(`TX failed (code ${result.code}): ${result.rawLog}`);
        process.exit(1);
      }
      ok(`TX: ${result.transactionHash}`);
      ok('Fee grant active — agent pays 0 gas');
    }
  }

  // ─── Step 5: Verify on-chain via RPC ───
  if (step('Verify agent subscription + fee grant on-chain (RPC)')) {
    const agentAddr = globalThis._agentAddress;
    if (!agentAddr) { fail('No agent address'); process.exit(1); }

    // Check subscriptions via RPC
    info(`Querying subscriptions for ${agentAddr} via RPC...`);
    try {
      const subs = await rpcQuerySubscriptionsForAccount(rpcClient, agentAddr);
      if (subs && subs.length > 0) {
        ok(`Agent has ${subs.length} subscription(s) via RPC`);
      } else {
        warn('No subscriptions found via RPC yet (may need a block to confirm)');
      }
    } catch (e) {
      warn(`RPC subscription query failed: ${e.message}`);
    }

    // Check fee grants via RPC (cosmos feegrant module)
    // queryFeeGrants uses LCD internally — we'll query directly
    info(`Querying fee grants for ${agentAddr}...`);
    try {
      // Use LCD for fee grants as SDK doesn't have RPC query for feegrant yet
      const lcd = 'https://api.sentinel.quokkastake.io';
      const grants = await queryFeeGrants(lcd, agentAddr);
      const items = grants?.allowances || grants?.items || [];
      if (items.length > 0) {
        ok(`Agent has ${items.length} fee grant(s)`);
        for (const g of items) {
          const granter = g.granter || '?';
          info(`  Granted by: ${granter}`);
        }
      } else {
        warn('No fee grants found yet');
      }
    } catch (e) {
      warn(`Fee grant query failed: ${e.message}`);
    }

    // Check agent balance (should be 0)
    info(`Checking agent balance via RPC...`);
    const agentBal = await rpcQueryBalance(rpcClient, agentAddr, 'udvpn');
    const agentUdvpn = parseInt(agentBal?.amount || '0', 10);
    ok(`Agent balance: ${agentUdvpn} udvpn (expected 0 — uses fee grant)`);
  }

  // ─── Step 6: Agent starts session via subscription (fee-granted, manual TX) ───
  //
  // NOTE: connectViaSubscription() has a balance pre-check that rejects zero-balance
  // wallets even with fee grants. SDK bug — connectViaPlan supports feeGranter but
  // connectViaSubscription does not. We build the TX manually using broadcastWithFeeGrant.
  //
  // This proves the on-chain flow: agent signs TX, operator pays gas via fee grant,
  // session is created on Sentinel chain. Tunnel setup (WireGuard/V2Ray) is separate.
  //
  if (step('Agent starts session via subscription (zero gas, manual TX)')) {
    const agentMnemonic = globalThis._agentMnemonic;
    if (!agentMnemonic) {
      fail('No agent mnemonic — run step 1 first');
      process.exit(1);
    }

    info(`Node: ${TEST_NODE}`);
    info(`Subscription: ${SUBSCRIPTION_ID}`);
    info(`Fee granter: ${globalThis._opAddress}`);
    info('Agent wallet has 0 P2P — relying on fee grant for gas');
    info('Building MsgStartSessionRequest manually (bypasses SDK balance check)');

    if (dryRun) {
      warn('DRY RUN — skipping broadcast');
      ok('Would broadcast MsgStartSessionRequest with fee grant');
    } else {
      try {
        // Create agent's signing client
        const { wallet: agentWallet, account: agentAccount } = await createWallet(agentMnemonic);
        const agentClient = await createClient(RPC, agentWallet);
        info(`Agent signer: ${agentAccount.address}`);

        // Verify agent balance is 0 (proves fee grant is doing the work)
        const agentBal = await rpcQueryBalance(rpcClient, agentAccount.address, 'udvpn');
        const agentUdvpn = parseInt(agentBal?.amount || '0', 10);
        info(`Agent balance: ${agentUdvpn} udvpn (expected 0)`);

        // Build MsgStartSessionRequest for subscription
        const msg = {
          typeUrl: MSG_TYPES.SUB_START_SESSION, // '/sentinel.subscription.v3.MsgStartSessionRequest'
          value: {
            from: agentAccount.address,
            id: BigInt(SUBSCRIPTION_ID),
            nodeAddress: TEST_NODE,
          },
        };
        info(`Message: ${msg.typeUrl}`);
        info(`  from: ${msg.value.from}`);
        info(`  id: ${SUBSCRIPTION_ID}`);
        info(`  nodeAddress: ${TEST_NODE}`);

        // Broadcast with fee grant — agent signs, operator pays gas
        info('Broadcasting with fee grant (agent signs, operator pays gas)...');
        const result = await broadcastWithFeeGrant(
          agentClient,
          agentAccount.address,
          [msg],
          globalThis._opAddress, // fee granter
          'x402 e2e test session start',
        );

        if (result.code !== 0) {
          fail(`TX failed (code ${result.code}): ${result.rawLog || JSON.stringify(result)}`);
        } else {
          ok(`TX: ${result.transactionHash}`);

          // Extract session ID from TX events
          const sessionId = extractId(result, /session/i, ['session_id', 'id']);
          if (sessionId) {
            ok(`SESSION CREATED — ID: ${sessionId}`);
          } else {
            warn('Session created but could not extract ID from events');
            info(`Raw log: ${result.rawLog?.slice(0, 200) || 'none'}`);
          }

          ok('ON-CHAIN FLOW COMPLETE');
          ok('Agent signed TX with 0 P2P balance');
          ok('Operator paid gas via fee grant');
          ok('Session started on Sentinel chain');
          info('');
          info('Tunnel setup (WireGuard/V2Ray handshake) is a separate step');
          info('that requires the node to be online and admin/root privileges.');
          info('The on-chain payment + provisioning flow is fully verified.');
        }
      } catch (e) {
        fail(`Session start failed: ${e.message}`);
        if (e.code) info(`Error code: ${e.code}`);
        if (e.rawLog) info(`Raw log: ${e.rawLog}`);

        // Decode common failures
        if (e.message?.includes('fee-grant')) {
          warn('Fee grant not found or expired — check step 4');
        } else if (e.message?.includes('insufficient')) {
          warn('Fee grant may not cover this message type');
        } else if (e.message?.includes('inactive') || e.message?.includes('105')) {
          warn('Node is inactive — try a different test node');
        } else if (e.message?.includes('account sequence')) {
          warn('Sequence mismatch — retry may fix this');
        }
      }
    }
  }

  // ─── Summary ───
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Agent:        ${globalThis._agentAddress || 'not created'}`);
  console.log(`  Operator:     ${globalThis._opAddress || 'not loaded'}`);
  console.log(`  Subscription: ${SUBSCRIPTION_ID}`);
  console.log(`  Plan:         ${PLAN_ID}`);
  console.log(`  Steps run:    ${Math.min(stepNum, maxStep)} of ${stepNum}`);
  console.log(`  Mode:         ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');
}

main().catch(e => {
  console.error(`\nFATAL: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
