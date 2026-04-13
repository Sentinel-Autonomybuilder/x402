import 'dotenv/config';

export interface Config {
  // Base (EVM)
  baseRpcUrl: string;
  baseWsUrl: string;
  paymentContractAddress: string;
  operatorEvmAddress: string;

  // Sentinel
  sentinelOperatorMnemonic: string;
  sentinelPlanId: number;
  sentinelRpcUrl: string;
  sentinelLcdUrl: string;

  // Solana (Phase 6)
  heliusApiKey: string;
  heliusWebhookSecret: string;
  operatorUsdcAta: string;
  solanaRpcUrl: string;

  // API
  port: number;
  databasePath: string;
  pricePerDayUsdc: number;
  minDays: number;
  maxDays: number;
}

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

function envInt(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw !== undefined) return parseInt(raw, 10);
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env: ${key}`);
}

export function loadConfig(): Config {
  return {
    // Base
    baseRpcUrl: env('BASE_RPC_URL', 'https://mainnet.base.org'),
    baseWsUrl: env('BASE_WS_URL', 'wss://mainnet.base.org'),
    paymentContractAddress: env('PAYMENT_CONTRACT_ADDRESS', ''),
    operatorEvmAddress: env('OPERATOR_EVM_ADDRESS', ''),

    // Sentinel
    sentinelOperatorMnemonic: env('SENTINEL_OPERATOR_MNEMONIC', ''),
    sentinelPlanId: envInt('SENTINEL_PLAN_ID', 0),
    sentinelRpcUrl: env('SENTINEL_RPC_URL', 'https://rpc.sentinel.co:443'),
    sentinelLcdUrl: env('SENTINEL_LCD_URL', 'https://lcd.sentinel.co'),

    // Solana
    heliusApiKey: env('HELIUS_API_KEY', ''),
    heliusWebhookSecret: env('HELIUS_WEBHOOK_SECRET', ''),
    operatorUsdcAta: env('OPERATOR_USDC_ATA', ''),
    solanaRpcUrl: env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),

    // API
    port: envInt('PORT', 3402),
    databasePath: env('DATABASE_PATH', './data/x402.db'),
    pricePerDayUsdc: envInt('PRICE_PER_DAY_USDC', 33333),
    minDays: envInt('MIN_DAYS', 1),
    maxDays: envInt('MAX_DAYS', 365),
  };
}

// ─── Constants ───

export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_SEPOLIA_USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const USDC_DECIMALS = 6;
export const MAX_ALLOCATIONS_PER_SUBSCRIPTION = 8;
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MEMO_PREFIX = 'x402:';
