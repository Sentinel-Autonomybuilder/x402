import { config } from 'dotenv';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import { HTTPFacilitatorClient, type FacilitatorConfig } from '@x402/core/server';
import { initSentinel, provisionAgent, checkAgentStatus } from './sentinel.js';
import { createSelfHostedFacilitator, startFacilitatorServer } from './facilitator.js';

config();

// ─── Config ───

const operatorAddress = process.env.OPERATOR_ADDRESS as `0x${string}`;
if (!operatorAddress) {
  console.error('OPERATOR_ADDRESS is required — this is where USDC payments go');
  process.exit(1);
}

const port = parseInt(process.env.PORT || '4020', 10);

// Network: eip155:8453 = Base mainnet (default), eip155:84532 = Base Sepolia (testnet)
const network = (process.env.BASE_NETWORK || 'eip155:8453') as `${string}:${string}`;
const networkLabel = network === 'eip155:8453' ? 'Base mainnet' : 'Base Sepolia (testnet)';

// ─── x402 Facilitator Setup ───
// Priority: 1) Self-hosted (FACILITATOR_PRIVATE_KEY) — fully decentralized
//           2) CDP (CDP_API_KEY_ID) — Coinbase hosted
//           3) Public x402.org — Sepolia only

let facilitatorConfig: FacilitatorConfig;
const facilitatorPort = parseInt(process.env.FACILITATOR_PORT || '4021', 10);

if (process.env.FACILITATOR_PRIVATE_KEY) {
  // Self-hosted: we run our own facilitator, no third party dependency
  const facServer = startFacilitatorServer(
    process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
    network,
    facilitatorPort,
  );
  facilitatorConfig = { url: facServer.url };
} else if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
  facilitatorConfig = createFacilitatorConfig(
    process.env.CDP_API_KEY_ID,
    process.env.CDP_API_KEY_SECRET,
  );
  console.log('  Facilitator: CDP (api.cdp.coinbase.com)');
} else if (network === 'eip155:84532') {
  facilitatorConfig = { url: 'https://x402.org/facilitator' };
  console.log('  Facilitator: x402.org (Sepolia only)');
} else {
  console.error('Base mainnet requires either:');
  console.error('  FACILITATOR_PRIVATE_KEY — self-hosted (recommended)');
  console.error('  CDP_API_KEY_ID + CDP_API_KEY_SECRET — Coinbase hosted');
  process.exit(1);
}

const facilitator = new HTTPFacilitatorClient(facilitatorConfig);

const resourceServer = new x402ResourceServer(facilitator)
  .register(network, new ExactEvmScheme());

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
          network,
          payTo: operatorAddress,
        }],
        description: '1 day of private VPN access through 900+ decentralized nodes',
        mimeType: 'application/json',
      },
      'POST /vpn/connect/7days': {
        accepts: [{
          scheme: 'exact',
          price: '$0.233',
          network,
          payTo: operatorAddress,
        }],
        description: '7 days of private VPN access',
        mimeType: 'application/json',
      },
      'POST /vpn/connect/30days': {
        accepts: [{
          scheme: 'exact',
          price: '$1.00',
          network,
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
  try {
    const result = await provisionVpn(1, req.body);
    res.json(result);
  } catch (err) {
    console.error('[x402] Provision failed:', (err as Error).message);
    res.status(500).json({ error: 'Provisioning failed', detail: (err as Error).message });
  }
});

app.post('/vpn/connect/7days', async (req, res) => {
  try {
    const result = await provisionVpn(7, req.body);
    res.json(result);
  } catch (err) {
    console.error('[x402] Provision failed:', (err as Error).message);
    res.status(500).json({ error: 'Provisioning failed', detail: (err as Error).message });
  }
});

app.post('/vpn/connect/30days', async (req, res) => {
  try {
    const result = await provisionVpn(30, req.body);
    res.json(result);
  } catch (err) {
    console.error('[x402] Provision failed:', (err as Error).message);
    res.status(500).json({ error: 'Provisioning failed', detail: (err as Error).message });
  }
});

// ─── Free Endpoints (no payment required) ───

app.get('/pricing', (_req, res) => {
  res.json({
    protocol: 'x402',
    network,
    asset: 'USDC',
    payTo: operatorAddress,
    tiers: {
      '1day': { price: '$0.033', endpoint: '/vpn/connect/1day' },
      '7days': { price: '$0.233', endpoint: '/vpn/connect/7days' },
      '30days': { price: '$1.00', endpoint: '/vpn/connect/30days' },
    },
    nodes: '900+',
    countries: '70+',
    protocols: ['wireguard', 'v2ray'],
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Agent status check — free, no payment needed
app.get('/agent/:sentinelAddr', async (req, res) => {
  try {
    const status = await checkAgentStatus(req.params.sentinelAddr);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── VPN Provisioning ───

async function provisionVpn(days: number, body: Record<string, unknown>) {
  const sentinelAddr = body.sentinelAddr as string;

  if (!sentinelAddr || !sentinelAddr.startsWith('sent1')) {
    return {
      error: 'Include sentinelAddr (sent1...) in request body',
      example: { sentinelAddr: 'sent1abc...' },
    };
  }

  console.log(`[x402] Payment settled. Provisioning ${days} days for ${sentinelAddr}...`);
  const result = await provisionAgent(sentinelAddr, days);
  return result;
}

// ─── Start ───

async function start() {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  x402 VPN Server');
  console.log('══════════════════════════════════════');

  try {
    await initSentinel();
  } catch (err) {
    console.error(`  Sentinel:    FAILED — ${(err as Error).message}`);
    console.error('  Server will start but provisioning will fail.');
    console.error('  Set SENTINEL_OPERATOR_MNEMONIC in .env');
  }

  console.log(`  Port:        ${port}`);
  console.log(`  Operator:    ${operatorAddress}`);
  console.log(`  Facilitator: ${facilitatorConfig.url}`);
  console.log(`  Network:     ${networkLabel} (${network})`);
  console.log('');
  console.log('  x402 Endpoints (payment required):');
  console.log('    POST /vpn/connect/1day    $0.033');
  console.log('    POST /vpn/connect/7days   $0.233');
  console.log('    POST /vpn/connect/30days  $1.00');
  console.log('');
  console.log('  Free Endpoints:');
  console.log('    GET  /pricing');
  console.log('    GET  /health');
  console.log('    GET  /agent/:sentinelAddr');
  console.log('══════════════════════════════════════');

  app.listen(port, () => {
    console.log(`\n  Listening on http://localhost:${port}\n`);
  });
}

start();
