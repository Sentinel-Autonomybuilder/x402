/**
 * x402 Server Test Suite
 *
 * Tests the running server endpoints:
 * 1. /health — server alive
 * 2. /pricing — correct structure + pricing
 * 3. POST /vpn/connect/* — returns HTTP 402 with x402 payment details
 * 4. /agent/:addr — sentinel status check
 * 5. Facilitator /supported — if self-hosted facilitator is running
 *
 * Usage: npx tsx test/test-server.ts
 * Requires: server running (cd server && npm run dev)
 */

const SERVER = process.env.SERVER_URL || 'http://localhost:4020';
const FACILITATOR = process.env.FACILITATOR_URL || 'http://localhost:4021';

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function log(pass: boolean, name: string, detail: string) {
  const icon = pass ? '  PASS' : '  FAIL';
  console.log(`${icon}  ${name}`);
  if (!pass) console.log(`        ${detail}`);
  results.push({ name, passed: pass, detail });
}

// ─── Tests ───

async function testHealth() {
  try {
    const res = await fetch(`${SERVER}/health`);
    const data = await res.json();
    log(res.ok && data.status === 'ok', '/health', `uptime=${data.uptime?.toFixed(1)}s`);
  } catch (err) {
    log(false, '/health', (err as Error).message);
  }
}

async function testPricing() {
  try {
    const res = await fetch(`${SERVER}/pricing`);
    const data = await res.json() as any;

    const checks = [
      data.protocol === 'x402',
      data.network?.includes('eip155:'),
      data.asset === 'USDC',
      data.payTo?.startsWith('0x'),
      data.tiers?.['1day']?.price === '$0.033',
      data.tiers?.['7days']?.price === '$0.233',
      data.tiers?.['30days']?.price === '$1.00',
    ];
    const allPass = checks.every(Boolean);
    log(allPass, '/pricing', `network=${data.network} payTo=${data.payTo?.slice(0, 10)}...`);
  } catch (err) {
    log(false, '/pricing', (err as Error).message);
  }
}

async function test402(endpoint: string) {
  try {
    const res = await fetch(`${SERVER}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentinelAddr: 'sent1test' }),
    });

    const is402 = res.status === 402;
    let detail = `status=${res.status}`;

    if (is402) {
      // x402 v2 puts payment requirements in PAYMENT-REQUIRED header (base64 JSON)
      const paymentHeader = res.headers.get('payment-required');
      if (paymentHeader) {
        const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
        const scheme = decoded.accepts?.[0]?.scheme;
        const amount = decoded.accepts?.[0]?.amount;
        const network = decoded.accepts?.[0]?.network;
        detail = `scheme=${scheme} amount=${amount} network=${network}`;
        log(!!scheme, `POST ${endpoint} → 402`, detail);
      } else {
        // Fallback: check body for older x402 versions
        const body = await res.json() as any;
        const scheme = body.accepts?.[0]?.scheme;
        log(!!scheme, `POST ${endpoint} → 402`, `body scheme=${scheme}`);
      }
    } else {
      log(false, `POST ${endpoint} → 402`, detail);
    }
  } catch (err) {
    log(false, `POST ${endpoint} → 402`, (err as Error).message);
  }
}

async function testAgentStatus() {
  try {
    const res = await fetch(`${SERVER}/agent/sent1testaddress12345678901234567890abc`);
    const data = await res.json() as any;
    log(res.ok && typeof data.hasSubscription === 'boolean', '/agent/:addr', `hasSubscription=${data.hasSubscription}`);
  } catch (err) {
    log(false, '/agent/:addr', (err as Error).message);
  }
}

async function testFacilitatorHealth() {
  try {
    const res = await fetch(`${FACILITATOR}/health`);
    const data = await res.json() as any;
    log(res.ok && data.address, 'Facilitator /health', `signer=${data.address?.slice(0, 10)}...`);
  } catch {
    log(true, 'Facilitator /health', 'not running (optional)');
  }
}

async function testFacilitatorSupported() {
  try {
    const res = await fetch(`${FACILITATOR}/supported`);
    if (!res.ok) { log(true, 'Facilitator /supported', 'not running (optional)'); return; }
    const data = await res.json() as any;
    const hasKinds = data.kinds && data.kinds.length > 0;
    const scheme = data.kinds?.[0]?.scheme;
    const network = data.kinds?.[0]?.network;
    log(hasKinds, 'Facilitator /supported', `scheme=${scheme} network=${network}`);
  } catch {
    log(true, 'Facilitator /supported', 'not running (optional)');
  }
}

// ─── Run ───

async function main() {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  x402 Server Test Suite');
  console.log(`  Server:      ${SERVER}`);
  console.log(`  Facilitator: ${FACILITATOR}`);
  console.log('══════════════════════════════════════');
  console.log('');

  // Check server reachable
  try {
    await fetch(`${SERVER}/health`);
  } catch {
    console.error(`  Server not reachable at ${SERVER}`);
    console.error('  Start it: cd server && npm run dev');
    process.exit(1);
  }

  await testHealth();
  await testPricing();
  await test402('/vpn/connect/1day');
  await test402('/vpn/connect/7days');
  await test402('/vpn/connect/30days');
  await testAgentStatus();
  await testFacilitatorHealth();
  await testFacilitatorSupported();

  // Summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log('');
  console.log('──────────────────────────────────────');
  console.log(`  ${passed}/${total} tests passed`);
  if (passed < total) {
    console.log('  FAILED:');
    results.filter(r => !r.passed).forEach(r => console.log(`    - ${r.name}: ${r.detail}`));
  }
  console.log('──────────────────────────────────────');
  process.exit(passed === total ? 0 : 1);
}

main();
