/**
 * x402 Server — Sentinel Chain Operations
 *
 * Handles all Sentinel chain interactions:
 * - Wallet creation from operator mnemonic
 * - Subscription sharing (add agent to plan)
 * - Fee grant creation (agent pays 0 gas on Sentinel)
 * - Subscription pool management (8 allocations per subscription)
 */

import {
  createWallet,
  createSafeBroadcaster,
  querySubscriptions,
  hasActiveSubscription,
} from 'blue-js-sdk';

// buildMsg* functions are exported from blue-js-sdk at runtime but lack type declarations.
// Import the full module and extract them with type assertions.
import * as sdk from 'blue-js-sdk';

// ─── Types ───

type EncodedMsg = { typeUrl: string; value: unknown };
type BroadcastResult = { code: number; transactionHash: string; rawLog?: string };

// Build MsgShareSubscription manually — the SDK version has a camelCase/snake_case mismatch
// between buildMsgShareSubscription (outputs acc_address) and encodeMsgShareSubscription
// (reads accAddress), plus field 4 wire type bug (varint vs string for cosmossdk.io/math.Int).
function buildMsgShareSubscription(opts: {
  from: string; id: number; accAddress: string; bytes: number;
}): EncodedMsg {
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

const buildMsgStartSubscription = (sdk as any).buildMsgStartSubscription as (opts: {
  from: string; id: number; denom?: string; renewalPricePolicy?: number;
}) => EncodedMsg;

const buildFeeGrantMsg = (sdk as any).buildFeeGrantMsg as (
  granter: string, grantee: string, opts?: {
    spendLimit?: number; expiration?: Date; allowedMessages?: string[];
  },
) => EncodedMsg;

// ─── Config ───

const SENTINEL_RPC = process.env.SENTINEL_RPC_URL || 'https://rpc.sentinel.co:443';
const SENTINEL_LCD = process.env.SENTINEL_LCD_URL || 'https://lcd.sentinel.co';
const PLAN_ID = parseInt(process.env.SENTINEL_PLAN_ID || '42', 10);

// Bytes to allocate per share — effectively unlimited for time-based access
const SHARE_BYTES = 1_000_000_000_000; // 1 TB

// Fee grant budget per agent — covers ~25 session starts
const FEE_GRANT_SPEND_LIMIT = 5_000_000; // 5 P2P (udvpn)

// Allowed messages for fee grant — only session operations
const FEE_GRANT_ALLOWED_MESSAGES = [
  '/sentinel.subscription.v3.MsgStartSessionRequest',
  '/sentinel.session.v3.MsgCancelSessionRequest',
  '/sentinel.session.v3.MsgUpdateSessionRequest',
];

// ─── State ───

let operatorAddress = '';
let safeBroadcast: ((msgs: EncodedMsg[], memo?: string) => Promise<BroadcastResult>) | null = null;

interface SubscriptionSlot {
  id: number;
  allocations: number;
}

const subscriptionPool: SubscriptionSlot[] = [];

// ─── Initialize ───

export async function initSentinel(): Promise<{ address: string; planId: number }> {
  const mnemonic = process.env.SENTINEL_OPERATOR_MNEMONIC;
  if (!mnemonic) {
    throw new Error('SENTINEL_OPERATOR_MNEMONIC is required — operator wallet with P2P for gas');
  }

  // Verify buildMsg functions loaded
  if (!buildMsgShareSubscription || !buildMsgStartSubscription || !buildFeeGrantMsg) {
    throw new Error('blue-js-sdk missing required exports (buildMsgShareSubscription, buildFeeGrantMsg)');
  }

  const { wallet, account } = await createWallet(mnemonic);
  operatorAddress = account.address;

  const broadcaster = createSafeBroadcaster(SENTINEL_RPC, wallet, operatorAddress);
  safeBroadcast = broadcaster.safeBroadcast as unknown as typeof safeBroadcast;

  // Load existing subscriptions for pool management
  await refreshSubscriptionPool();

  console.log(`  Sentinel:    ${operatorAddress}`);
  console.log(`  Plan:        ${PLAN_ID}`);
  console.log(`  Subs pool:   ${subscriptionPool.length} active`);

  return { address: operatorAddress, planId: PLAN_ID };
}

// ─── Subscription Pool ───

async function refreshSubscriptionPool(): Promise<void> {
  try {
    const result = await querySubscriptions(SENTINEL_LCD, operatorAddress, { status: 'active' });
    const subs = (result as any).items || (result as any).subscriptions || [];

    subscriptionPool.length = 0;
    for (const sub of subs) {
      const id = Number(sub.id || sub.base_subscription?.id);
      if (id > 0) {
        subscriptionPool.push({ id, allocations: 0 });
      }
    }
  } catch (err) {
    console.warn('[sentinel] Failed to refresh subscription pool:', (err as Error).message);
  }
}

/**
 * Get a subscription with available slots (< 8 allocations).
 * If none available, create a new one.
 */
async function getAvailableSubscription(): Promise<number> {
  for (const slot of subscriptionPool) {
    if (slot.allocations < 7) {
      return slot.id;
    }
  }

  // No available slots — create new subscription to the plan
  console.log(`[sentinel] All subscriptions full, creating new one for plan ${PLAN_ID}...`);
  const msg = buildMsgStartSubscription({
    from: operatorAddress,
    id: PLAN_ID,
    denom: 'udvpn',
    renewalPricePolicy: 0,
  });

  const result = await safeBroadcast!([msg], 'x402 new subscription');
  if (result.code !== 0) {
    throw new Error(`Failed to create subscription: ${result.rawLog}`);
  }

  const subId = parseSubscriptionIdFromLog(result.rawLog || '');
  if (!subId) {
    await refreshSubscriptionPool();
    if (subscriptionPool.length > 0) {
      return subscriptionPool[subscriptionPool.length - 1].id;
    }
    throw new Error('Created subscription but could not determine ID');
  }

  subscriptionPool.push({ id: subId, allocations: 0 });
  console.log(`[sentinel] Created subscription ${subId}`);
  return subId;
}

function parseSubscriptionIdFromLog(rawLog: string): number | null {
  const match = rawLog.match(/subscription[_-]id[":\s]+(\d+)/i)
    || rawLog.match(/"id":"(\d+)"/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Provisioning ───

export interface ProvisionResult {
  provisioned: boolean;
  sentinelAddr: string;
  days: number;
  subscriptionId: number;
  sentinelTxHash: string;
  expiresAt: string;
  operatorAddress: string;
  instructions: string;
}

/**
 * Provision VPN access for an agent on the Sentinel chain.
 *
 * 1. Get available subscription (or create one)
 * 2. Share subscription with agent's Sentinel address
 * 3. Grant fee allowance so agent pays 0 gas
 *
 * Both messages batched into a single TX for atomicity.
 */
export async function provisionAgent(
  sentinelAddr: string,
  days: number,
): Promise<ProvisionResult> {
  if (!safeBroadcast) {
    throw new Error('Sentinel not initialized — call initSentinel() first');
  }

  if (!sentinelAddr || !sentinelAddr.startsWith('sent1')) {
    throw new Error('Invalid Sentinel address — must start with sent1');
  }

  const subscriptionId = await getAvailableSubscription();

  const shareMsg = buildMsgShareSubscription({
    from: operatorAddress,
    id: subscriptionId,
    accAddress: sentinelAddr,
    bytes: SHARE_BYTES,
  });

  const expirationDate = new Date(Date.now() + days * 86_400_000 + 86_400_000);
  const feeGrantMsg = buildFeeGrantMsg(operatorAddress, sentinelAddr, {
    spendLimit: FEE_GRANT_SPEND_LIMIT,
    expiration: expirationDate,
    allowedMessages: FEE_GRANT_ALLOWED_MESSAGES,
  });

  console.log(`[sentinel] Provisioning ${days}d for ${sentinelAddr} (sub ${subscriptionId})...`);
  const result = await safeBroadcast([shareMsg, feeGrantMsg], `x402 provision ${days}d`);

  if (result.code !== 0) {
    throw new Error(`Sentinel TX failed (code ${result.code}): ${result.rawLog}`);
  }

  const slot = subscriptionPool.find(s => s.id === subscriptionId);
  if (slot) slot.allocations++;

  console.log(`[sentinel] Provisioned! TX: ${result.transactionHash}`);

  return {
    provisioned: true,
    sentinelAddr,
    days,
    subscriptionId,
    sentinelTxHash: result.transactionHash,
    expiresAt: expirationDate.toISOString(),
    operatorAddress,
    instructions: 'Use blue-ai-connect with your Sentinel mnemonic to start a VPN session. Fee grant active — zero gas on Sentinel chain.',
  };
}

/**
 * Check if an agent already has an active allocation.
 */
export async function checkAgentStatus(sentinelAddr: string): Promise<{
  hasSubscription: boolean;
  subscriptionId?: number;
}> {
  try {
    const result = await hasActiveSubscription(sentinelAddr, PLAN_ID, SENTINEL_LCD);
    return {
      hasSubscription: result.has,
      subscriptionId: result.subscription
        ? Number((result.subscription as any).id || (result.subscription as any).base_subscription?.id)
        : undefined,
    };
  } catch {
    return { hasSubscription: false };
  }
}
