/**
 * Phase 2 — Turnkey signing module.
 *
 * The signing primitive for live mode. A scoped Turnkey API credential stamps
 * requests; Turnkey's enclave enforces the policies (chain-scoped
 * SIGN_TRANSACTION_V2 allow, SIGN_RAW_PAYLOAD_V2 deny — proven live
 * 2026-09-28, see scripts/turnkey-ink-proof/proof.ts).
 *
 * Defense in depth (this module is the second layer, the Turnkey policy is
 * the first):
 *   - Only structured EIP-1559 transactions. There is NO raw-payload signing
 *     path in this module — by construction, like paper mode has no signing
 *     path at all.
 *   - Only allowlisted chain IDs (MVP chains).
 *   - The MCP tool layer requires explicit user approval per signature.
 *
 * The private key lives only in the TurnkeySigner instance (memory). It is
 * never logged, never returned by any tool, never written to disk.
 */
import { createPrivateKey, createSign } from 'node:crypto';

export const TURNKEY_BASE_URL = 'https://api.turnkey.com';

/** MVP chains the signer will sign for. */
export const SIGNABLE_CHAIN_IDS = [1, 57073, 4663] as const;

export interface TurnkeyCredentials {
  orgId: string;
  /** Compressed P-256 public key hex (66 chars, no 0x). */
  apiPublicKey: string;
  /** Raw P-256 private scalar hex (64 chars). Memory only — never logged. */
  apiPrivateKeyHex: string;
}

export interface UnsignedEip1559Tx {
  chainId: number;
  /** hex, e.g. "0x0" */
  nonce: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gas: string;
  /** 0x address */
  to: string;
  /** hex, usually "0x0" */
  value: string;
  /** hex calldata, "0x" when empty */
  data: string;
}

type FetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// ---------- RLP (EIP-1559 unsigned-tx encoding) ----------

function intToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

function hexToBytes(h: string): Uint8Array {
  let c = h.startsWith('0x') ? h.slice(2) : h;
  if (c === '') return new Uint8Array(0);
  if (!/^[0-9a-fA-F]*$/.test(c)) throw new Error(`bad hex: ${h}`);
  if (c.length % 2 !== 0) c = '0' + c; // "0x0" -> 0x00, standard padding
  return Uint8Array.from(Buffer.from(c, 'hex'));
}

function rlpEncode(input: Uint8Array | Uint8Array[]): Uint8Array {
  const encodeLen = (len: number, offset: number): Uint8Array => {
    if (len <= 55) return Uint8Array.of(offset + len);
    const bl = intToBytes(BigInt(len));
    return Uint8Array.of(offset + 55 + bl.length, ...bl);
  };
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) return input;
    return Uint8Array.of(...encodeLen(input.length, 0x80), ...input);
  }
  const joined = input.flatMap((x) => Array.from(rlpEncode(x)));
  return Uint8Array.of(...encodeLen(joined.length, 0xc0), ...joined);
}

/** 0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas, to, value, data, access_list]) */
export function encodeUnsignedEip1559(tx: UnsignedEip1559Tx): Uint8Array {
  const fields = [
    intToBytes(BigInt(tx.chainId)),
    hexToBytes(tx.nonce),
    hexToBytes(tx.maxPriorityFeePerGas),
    hexToBytes(tx.maxFeePerGas),
    hexToBytes(tx.gas),
    hexToBytes(tx.to),
    hexToBytes(tx.value),
    hexToBytes(tx.data),
    [],
  ];
  const enc = rlpEncode(fields as Uint8Array[]);
  return Uint8Array.of(0x02, ...enc);
}

/** Import a raw 32-byte P-256 scalar as a KeyObject (SEC1 DER wrapping). */
function importPrivateKey(privHex: string) {
  const d = Buffer.from(privHex, 'hex');
  if (d.length !== 32) throw new Error('apiPrivateKeyHex must decode to 32 bytes');
  // SEC1 DER: SEQUENCE { INTEGER 1, OCTET STRING <32-byte scalar>, [0] { OID secp256r1 } }
  const der = Buffer.concat([
    Buffer.from('30310201010420', 'hex'),
    d,
    Buffer.from('a00a06082a8648ce3d030107', 'hex'),
  ]);
  return createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

// ---------- signer ----------

export class TurnkeySigner {
  private readonly creds: TurnkeyCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  constructor(
    creds: TurnkeyCredentials,
    opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {},
  ) {
    if (!creds.orgId) throw new Error('Turnkey orgId is required');
    if (!/^[0-9a-fA-F]{66}$/.test(creds.apiPublicKey)) {
      throw new Error('apiPublicKey must be 66-char compressed P-256 hex');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(creds.apiPrivateKeyHex)) {
      throw new Error('apiPrivateKeyHex must be 64-char hex');
    }
    this.creds = creds;
    this.baseUrl = opts.baseUrl ?? TURNKEY_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchImpl);
    // Import once: the raw scalar never leaves this instance, and stamp()
    // never sees it directly.
    this.privateKey = importPrivateKey(creds.apiPrivateKeyHex);
  }

  /** Truncated public-key fingerprint for status displays. Never the private key. */
  get keyFingerprint(): string {
    return `${this.creds.apiPublicKey.slice(0, 8)}…${this.creds.apiPublicKey.slice(-6)}`;
  }

  get orgId(): string {
    return this.creds.orgId;
  }

  /** Build the Turnkey API stamp for a request body. Exposed for tests. */
  stamp(body: string): string {
    const sign = createSign('sha256');
    sign.update(body);
    sign.end();
    const sig = sign.sign(this.privateKey);
    return Buffer.from(JSON.stringify({
      publicKey: this.creds.apiPublicKey,
      scheme: 'SIGNATURE_SCHEME_TK_API_P256',
      signature: sig.toString('hex'),
    })).toString('base64url');
  }

  /** Low-level: submit any Turnkey activity. */
  async submitActivity<T>(activityType: string, params: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({
      type: activityType,
      timestampMs: Date.now().toString(),
      organizationId: this.creds.orgId,
      parameters: params,
    });
    const res = await this.fetchImpl(`${this.baseUrl}/public/v1/submit/${activityType}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stamp': this.stamp(body),
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`turnkey ${activityType} -> HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Ask Turnkey to sign a structured EIP-1559 transaction.
   * Returns the signed raw transaction hex ("0x02...").
   */
  async signTransaction(walletAccount: string, tx: UnsignedEip1559Tx): Promise<string> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAccount)) throw new Error('walletAccount must be a 0x address');
    assertSignableTx(tx);
    const out = await this.submitActivity<{ activity: { result?: { signTransactionResult?: { signedTransaction?: string } } } }>(
      'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',
      {
        signWith: walletAccount,
        unsignedTransaction: Buffer.from(encodeUnsignedEip1559(tx)).toString('hex'),
        type: 'TRANSACTION_TYPE_ETHEREUM',
      },
    );
    const signed = out.activity?.result?.signTransactionResult?.signedTransaction;
    if (!signed) throw new Error('turnkey: signTransactionResult.signedTransaction missing from response');
    return signed.startsWith('0x') ? signed : `0x${signed}`;
  }

  /** eth_getTransactionCount for nonce management. */
  async getNonce(rpcUrl: string, address: string): Promise<string> {
    const res = await this.fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'pending'] }),
    });
    if (!res.ok) throw new Error(`rpc eth_getTransactionCount -> HTTP ${res.status}`);
    const data = (await res.json()) as { result?: string; error?: { message?: string } };
    if (data.error) throw new Error(`rpc error: ${data.error.message}`);
    if (!data.result) throw new Error('rpc: no result for eth_getTransactionCount');
    return data.result;
  }

  /** Broadcast a signed tx. Returns the transaction hash. */
  async broadcast(rpcUrl: string, signedTxHex: string): Promise<string> {
    if (!/^0x[0-9a-fA-F]+$/.test(signedTxHex)) throw new Error('signedTxHex must be 0x hex');
    const res = await this.fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signedTxHex] }),
    });
    if (!res.ok) throw new Error(`rpc eth_sendRawTransaction -> HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { result?: string; error?: { message?: string } };
    if (data.error) throw new Error(`rpc error: ${data.error.message}`);
    if (!data.result) throw new Error('rpc: no result for eth_sendRawTransaction');
    return data.result;
  }

  /**
   * Full flow with defense-in-depth checks: allowlisted chain, well-formed
   * fields, then Turnkey sign (policy-enforced server-side), then broadcast.
   */
  async signAndBroadcast(
    walletAccount: string,
    rpcUrl: string,
    tx: UnsignedEip1559Tx,
  ): Promise<{ txHash: string; signedTx: string }> {
    const signedTx = await this.signTransaction(walletAccount, tx);
    const txHash = await this.broadcast(rpcUrl, signedTx);
    return { txHash, signedTx };
  }
}

/** Local guards before a signature is even requested. The Turnkey policy is the primary enforcement. */
export function assertSignableTx(tx: UnsignedEip1559Tx): void {
  if (!(SIGNABLE_CHAIN_IDS as readonly number[]).includes(tx.chainId)) {
    throw new Error(`CHAIN_NOT_ALLOWLISTED: chain ${tx.chainId} is not in [${SIGNABLE_CHAIN_IDS.join(', ')}]`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error('tx.to must be a 0x address');
  for (const [name, v] of [['nonce', tx.nonce], ['maxFeePerGas', tx.maxFeePerGas], ['maxPriorityFeePerGas', tx.maxPriorityFeePerGas], ['gas', tx.gas], ['value', tx.value], ['data', tx.data]] as const) {
    if (!/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`tx.${name} must be 0x hex`);
  }
}
