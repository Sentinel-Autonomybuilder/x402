/**
 * x402 Sentinel Provisioning Test
 *
 * Tests Sentinel chain operations WITHOUT the x402 payment layer:
 * 1. Load operator wallet from mnemonic
 * 2. Query active subscriptions
 * 3. Generate throwaway test wallet
 * 4. Run full provision flow (share subscription + fee grant)
 *
 * Usage: npx tsx test/test-sentinel.ts
 * Requires: SENTINEL_OPERATOR_MNEMONIC in server/.env
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env manually to avoid dotenv dependency at root
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../server/.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.error(`  Could not load ${envPath}`);
}

import {
  createWallet,
  querySubscriptions,
  generateWallet,
} from 'blue-js-sdk';

const LCD = process.env.SENTINEL_LCD_URL || 'https://lcd.sentinel.co';
const PLAN_ID = parseInt(process.env.SENTINEL_PLAN_ID || '42', 10);

let passed = 0;
let failed = 0;

function log(pass: boolean, name: string, detail: string) {
  const icon = pass ? '  PASS' : '  FAIL';
  console.log(`${icon}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  pass ? passed++ : failed++;
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  x402 Sentinel Provisioning Test');
  console.log('══════════════════════════════════════');
  console.log('');

  // ─── 1. Load operator wallet ───

  const mnemonic = process.env.SENTINEL_OPERATOR_MNEMONIC;
  if (!mnemonic) {
    console.error('  SENTINEL_OPERATOR_MNEMONIC not set in server/.env');
    process.exit(1);
  }

  try {
    const { wallet, account } = await createWallet(mnemonic);
    log(true, 'Load operator wallet', `address=${account.address}`);
  } catch (err) {
    log(false, 'Load operator wallet', (err as Error).message);
    process.exit(1);
  }

  // ─── 2. Query subscriptions ───

  const { account } = await createWallet(mnemonic);

  try {
    const result = await querySubscriptions(LCD, account.address, { status: 'active' });
    const subs = (result as any).items || (result as any).subscriptions || [];
    log(subs.length > 0, 'Query active subscriptions', `count=${subs.length}`);

    for (const sub of subs.slice(0, 3)) {
      const id = sub.id || sub.base_subscription?.id;
      console.log(`        sub ${id}`);
    }
  } catch (err) {
    log(false, 'Query active subscriptions', (err as Error).message);
  }

  // ─── 3. Generate test wallet ───

  let testAddress = '';
  try {
    const testAgent = await generateWallet();
    testAddress = testAgent.account.address;
    log(testAddress.startsWith('sent1'), 'Generate test agent wallet', `address=${testAddress}`);
  } catch (err) {
    log(false, 'Generate test agent wallet', (err as Error).message);
    process.exit(1);
  }

  // ─── 4. Full provision flow ───

  try {
    // Import sentinel module from server
    const { initSentinel, provisionAgent } = await import('../server/src/sentinel.ts');

    const info = await initSentinel();
    log(true, 'Initialize Sentinel', `operator=${info.address} plan=${info.planId}`);

    console.log('');
    console.log('  Provisioning 1-day access for test agent...');
    const result = await provisionAgent(testAddress, 1);

    log(result.provisioned === true, 'Provision 1-day VPN', `tx=${result.sentinelTxHash}`);
    console.log(`        subscription=${result.subscriptionId}`);
    console.log(`        expires=${result.expiresAt}`);
  } catch (err) {
    log(false, 'Provision 1-day VPN', (err as Error).message);
    console.error('');
    console.error('  Possible causes:');
    console.error('  - Operator wallet has insufficient P2P for gas');
    console.error('  - All subscriptions full (8 allocations each)');
    console.error('  - Sentinel RPC unreachable');
  }

  // ─── Summary ───

  const total = passed + failed;
  console.log('');
  console.log('──────────────────────────────────────');
  console.log(`  ${passed}/${total} tests passed`);
  if (failed > 0) console.log(`  ${failed} FAILED`);
  console.log('──────────────────────────────────────');
  process.exit(failed > 0 ? 1 : 0);
}

main();
