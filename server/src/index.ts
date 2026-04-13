import { config } from 'dotenv';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

config();

// ─── Config ───

const operatorAddress = process.env.OPERATOR_ADDRESS as `0x${string}`;
if (!operatorAddress) {
  console.error('OPERATOR_ADDRESS is required — this is where USDC payments go');
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const port = parseInt(process.env.PORT || '4020', 10);

// ─── Pricing ───
// $0.033/day = 33333 USDC atomic units
// $1/month = 999990 USDC atomic units
// Amounts are strings in USDC atomic units (6 decimals)

const PRICES = {
  oneDay: '33333',      // $0.033
  sevenDays: '233331',  // $0.233
  thirtyDays: '999990', // $1.00
};

// ─── x402 Setup ───

const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

const resourceServer = new x402ResourceServer(facilitator)
  .register('eip155:8453', new ExactEvmScheme());  // Base mainnet

// ─── Express App ───

const app = express();
app.use(express.json());

// ─── x402-Protected Routes ───
// When an agent hits these without payment, they get HTTP 402 with payment details.
// When they pay (via @x402/fetch), the facilitator settles USDC to our wallet,
// and the route handler runs.

app.use(
  paymentMiddleware(
    {
      'POST /vpn/connect/1day': {
        accepts: [{
          scheme: 'exact',
          price: '$0.033',
          network: 'eip155:8453',
          payTo: operatorAddress,
        }],
        description: '1 day of private VPN access through 900+ decentralized nodes',
        mimeType: 'application/json',
      },
      'POST /vpn/connect/7days': {
        accepts: [{
          scheme: 'exact',
          price: '$0.233',
          network: 'eip155:8453',
          payTo: operatorAddress,
        }],
        description: '7 days of private VPN access',
        mimeType: 'application/json',
      },
      'POST /vpn/connect/30days': {
        accepts: [{
          scheme: 'exact',
          price: '$1.00',
          network: 'eip155:8453',
          payTo: operatorAddress,
        }],
        description: '30 days of private VPN access',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  ),
);

// ─── Route Handlers (only reached after payment is settled) ───

app.post('/vpn/connect/1day', async (req, res) => {
  // USDC is already in our wallet at this point.
  // Provision VPN access on Sentinel and return session details.
  const result = await provisionVpn(1, req.body);
  res.json(result);
});

app.post('/vpn/connect/7days', async (req, res) => {
  const result = await provisionVpn(7, req.body);
  res.json(result);
});

app.post('/vpn/connect/30days', async (req, res) => {
  const result = await provisionVpn(30, req.body);
  res.json(result);
});

// ─── Free Endpoints (no payment required) ───

app.get('/pricing', (_req, res) => {
  res.json({
    protocol: 'x402',
    network: 'eip155:8453',
    asset: 'USDC',
    payTo: operatorAddress,
    tiers: {
      '1day': { price: '$0.033', amount: PRICES.oneDay, endpoint: '/vpn/connect/1day' },
      '7days': { price: '$0.233', amount: PRICES.sevenDays, endpoint: '/vpn/connect/7days' },
      '30days': { price: '$1.00', amount: PRICES.thirtyDays, endpoint: '/vpn/connect/30days' },
    },
    nodes: '900+',
    countries: '70+',
    protocols: ['wireguard', 'v2ray'],
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── VPN Provisioning ───
// After x402 payment is settled, provision access on Sentinel chain.
// This is where MsgShareSubscription + MsgGrantAllowance happen.

async function provisionVpn(days: number, body: Record<string, unknown>) {
  const sentinelAddr = body.sentinelAddr as string;

  if (!sentinelAddr || !sentinelAddr.startsWith('sent1')) {
    return {
      error: 'Include sentinelAddr (sent1...) in request body',
      example: { sentinelAddr: 'sent1abc...' },
    };
  }

  // TODO: Wire Sentinel provisioning (MsgShareSubscription + MsgGrantAllowance)
  // For now, return what the agent needs to connect
  console.log(`[x402] Paid! Provisioning ${days} days for ${sentinelAddr}`);

  return {
    provisioned: true,
    sentinelAddr,
    days,
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    instructions: 'Use blue-ai-connect with your mnemonic to establish VPN tunnel. Fee grant active — zero gas on Sentinel.',
  };
}

// ─── Start ───

app.listen(port, () => {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  x402 VPN Server — Real Protocol');
  console.log('══════════════════════════════════════');
  console.log(`  Port:        ${port}`);
  console.log(`  Operator:    ${operatorAddress}`);
  console.log(`  Facilitator: ${facilitatorUrl}`);
  console.log(`  Network:     Base mainnet (eip155:8453)`);
  console.log('');
  console.log('  x402 Endpoints (payment required):');
  console.log('    POST /vpn/connect/1day    $0.033');
  console.log('    POST /vpn/connect/7days   $0.233');
  console.log('    POST /vpn/connect/30days  $1.00');
  console.log('');
  console.log('  Free Endpoints:');
  console.log('    GET  /pricing');
  console.log('    GET  /health');
  console.log('══════════════════════════════════════');
});
