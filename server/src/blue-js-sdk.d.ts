/**
 * Additional type declarations for blue-js-sdk functions
 * that exist at runtime but are not in published .d.ts
 */
declare module 'blue-js-sdk/protocol/messages.js' {
  interface EncodedMsg {
    typeUrl: string;
    value: Record<string, unknown> | Uint8Array;
  }

  export function buildMsgStartSubscription(opts: {
    from: string;
    id: number | bigint;
    denom?: string;
    renewalPricePolicy?: number;
  }): EncodedMsg;

  export function buildMsgShareSubscription(opts: {
    from: string;
    id: number | bigint;
    accAddress: string;
    bytes: number;
  }): EncodedMsg;

  export function buildMsgCancelSubscription(opts: {
    from: string;
    id: number | bigint;
  }): EncodedMsg;

  export const TYPE_URLS: Record<string, string>;
}

declare module 'blue-js-sdk/chain/fee-grants.js' {
  interface EncodedMsg {
    typeUrl: string;
    value: Record<string, unknown> | Uint8Array;
  }

  export function buildFeeGrantMsg(
    granter: string,
    grantee: string,
    opts?: {
      spendLimit?: number | Array<{ denom: string; amount: string }>;
      expiration?: Date | string;
      allowedMessages?: string[];
    },
  ): EncodedMsg;

  export function buildRevokeFeeGrantMsg(
    granter: string,
    grantee: string,
  ): EncodedMsg;
}
