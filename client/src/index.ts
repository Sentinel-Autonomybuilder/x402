import { config } from 'dotenv';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

config();

// ─── Agent Configuration ───

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const serverUrl = process.env.SERVER_URL || 'http://localhost:4020';

if (!evmPrivateKey) {
  console.error('EVM_PRIVATE_KEY is required — agent wallet with USDC on Base');
  process.exit(1);
}

// ─── x402 Client Setup ───

const account = privateKeyToAccount(evmPrivateKey);
console.log(`Agent wallet: ${account.address}`);

const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(account));

// Wrap fetch — auto-handles 402 responses with payment
const payFetch = wrapFetchWithPayment(fetch, client);

// ─── Connect to VPN ───

async function connectVpn(days: number, sentinelAddr: string) {
  const endpoint = days <= 1 ? '1day' : days <= 7 ? '7days' : '30days';
  const url = `${serverUrl}/vpn/connect/${endpoint}`;

  console.log(`\nRequesting ${days}-day VPN access...`);
  console.log(`Endpoint: ${url}`);
  console.log(`Sentinel address: ${sentinelAddr}`);

  // This single fetch call:
  // 1. Hits the server → gets 402 Payment Required
  // 2. Signs EIP-3009 transferWithAuthorization (off-chain, no gas)
  // 3. Retries with PAYMENT-SIGNATURE header
  // 4. Facilitator settles USDC on Base (facilitator pays gas)
  // 5. Server provisions VPN access
  // 6. Returns the result
  const response = await payFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentinelAddr }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Server returned ${response.status}: ${error}`);
  }

  const result = await response.json();
  console.log('\nVPN access provisioned:');
  console.log(JSON.stringify(result, null, 2));

  // Check payment settlement details
  const httpClient = new x402HTTPClient(client);
  const paymentResponse = httpClient.getPaymentSettleResponse(
    (name: string) => response.headers.get(name),
  );
  if (paymentResponse) {
    console.log('\nPayment settlement:');
    console.log(JSON.stringify(paymentResponse, null, 2));
  }

  return result;
}

// ─── Run ───

const sentinelAddr = process.env.SENTINEL_ADDRESS || 'sent1...';
const days = parseInt(process.env.DAYS || '1', 10);

connectVpn(days, sentinelAddr).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
