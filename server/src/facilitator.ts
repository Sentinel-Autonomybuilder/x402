/**
 * x402 Self-Hosted Facilitator
 *
 * Runs our own facilitator instead of depending on Coinbase's CDP service.
 * Verifies EIP-3009 signatures and settles USDC transfers on Base mainnet.
 *
 * Requires: FACILITATOR_PRIVATE_KEY (EVM wallet with ETH on Base for gas)
 */

import express from 'express';
import {
  createWalletClient,
  createPublicClient,
  http,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';

// ─── Config ───

const FACILITATOR_PORT = parseInt(process.env.FACILITATOR_PORT || '4021', 10);
const EVM_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`;
const NETWORK = (process.env.BASE_NETWORK || 'eip155:8453') as `${string}:${string}`;
const BASE_RPC_URL = process.env.BASE_RPC_URL || undefined; // viem defaults to public RPC

// ─── Setup ───

export function createSelfHostedFacilitator(privateKey: `0x${string}`, network: `${string}:${string}`) {
  const chain = network === 'eip155:84532' ? baseSepolia : base;

  const account = privateKeyToAccount(privateKey);

  const viemClient = createWalletClient({
    account,
    chain,
    transport: http(BASE_RPC_URL),
  }).extend(publicActions);

  const evmSigner = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => viemClient.readContract({ ...args, args: args.args || [] }),
    verifyTypedData: (args) => viemClient.verifyTypedData(args as any),
    writeContract: (args) => viemClient.writeContract({ ...args, args: args.args || [], gas: args.gas }),
    sendTransaction: (args) => viemClient.sendTransaction(args),
    waitForTransactionReceipt: (args) => viemClient.waitForTransactionReceipt(args),
    getCode: (args) => viemClient.getCode(args),
  });

  const facilitator = new x402Facilitator();
  facilitator.register(network, new ExactEvmScheme(evmSigner));

  return { facilitator, address: account.address };
}

// ─── Express Server ───

export function startFacilitatorServer(privateKey: `0x${string}`, network: `${string}:${string}`, port: number) {
  const { facilitator, address } = createSelfHostedFacilitator(privateKey, network);

  const app = express();
  app.use(express.json());

  // GET /supported — tells resource servers what we support
  app.get('/supported', (_req, res) => {
    try {
      const supported = facilitator.getSupported();
      res.json(supported);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /verify — verify a payment signature off-chain
  app.post('/verify', async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body;
      const result = await facilitator.verify(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (err) {
      console.error('[facilitator] Verify error:', (err as Error).message);
      res.status(400).json({
        isValid: false,
        invalidReason: 'VERIFICATION_ERROR',
        invalidMessage: (err as Error).message,
      });
    }
  });

  // POST /settle — submit the transferWithAuthorization TX on-chain
  app.post('/settle', async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body;
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (err) {
      console.error('[facilitator] Settle error:', (err as Error).message);
      res.status(400).json({
        success: false,
        errorReason: 'SETTLEMENT_ERROR',
        errorMessage: (err as Error).message,
        transaction: '',
        network,
      });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', address, network });
  });

  app.listen(port, () => {
    console.log(`  Facilitator: http://localhost:${port} (self-hosted)`);
    console.log(`  Signer:      ${address}`);
    console.log(`  Network:     ${network}`);
  });

  return { app, facilitator, address, url: `http://localhost:${port}` };
}

// ─── Standalone mode ───

if (process.argv[1]?.endsWith('facilitator.ts') || process.argv[1]?.endsWith('facilitator.js')) {
  if (!EVM_PRIVATE_KEY) {
    console.error('FACILITATOR_PRIVATE_KEY required — EVM wallet with ETH on Base for gas');
    process.exit(1);
  }
  startFacilitatorServer(EVM_PRIVATE_KEY, NETWORK, FACILITATOR_PORT);
}
