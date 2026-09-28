/**
 * token_resolve — the CA-paste inspection. This is the visible face of the
 * Layer 1 safety floor: before any trade talk, the agent reports red flags
 * and facts, then asks what the user wants to do. The agent NEVER says
 * "looks safe" — it reports the checks and the numbers.
 *
 * Data:
 *   DexScreener (free, no key) — price, liquidity, volume, txns, market cap.
 *   GoPlus token_security (free, no key) — honeypot, taxes, mintable,
 *     proxy, ownership. EVM + Solana.
 *
 * Layer 1 gates (deterministic, enforced at execution time, not just here):
 *   - honeypot (buy AND sell simulation via GoPlus) -> BLOCKED
 *   - buy/sell tax above threshold -> red flag
 *   - liquidity too thin relative to trade size -> red flag (checked with size at quote/execute time)
 */
export type FetchImpl = typeof fetch;

export interface ChainInfo {
  /** DexScreener chain slug */
  ds: string;
  /** GoPlus chain id */
  gp: string;
  /** KyberSwap chain slug (EVM only) */
  kyber?: string;
  isSolana: boolean;
}

export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { ds: 'ethereum', gp: '1', kyber: 'ethereum', isSolana: false },
  base: { ds: 'base', gp: '8453', kyber: 'base', isSolana: false },
  arbitrum: { ds: 'arbitrum', gp: '42161', kyber: 'arbitrum', isSolana: false },
  bsc: { ds: 'bsc', gp: '56', kyber: 'bsc', isSolana: false },
  ink: { ds: 'ink', gp: '57073', kyber: undefined, isSolana: false }, // Kyber does not serve Ink (verified 2026-09-28)
  robinhood: { ds: 'robinhood', gp: '4663', kyber: 'robinhood', isSolana: false },
  solana: { ds: 'solana', gp: 'solana', isSolana: true },
};

export function resolveChain(chain?: string): ChainInfo & { name: string } {
  const name = (chain ?? 'ethereum').trim().toLowerCase();
  const info = CHAINS[name];
  if (!info) {
    throw new Error(
      `unsupported chain "${chain}" (supported: ${Object.keys(CHAINS).join(', ')})`,
    );
  }
  return { ...info, name };
}

export function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isSolanaAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export interface SafetyCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface TokenInspection {
  ok: true;
  token: {
    address: string;
    chain: string;
    name: string;
    symbol: string;
    decimals: number | null;
  };
  facts: {
    price_usd: number | null;
    liquidity_usd: number | null;
    volume_24h_usd: number | null;
    market_cap_usd: number | null;
    txns_24h: { buys: number; sells: number } | null;
    pair_address: string | null;
    dex: string | null;
    pair_created_at: string | null;
    pair_age_days: number | null;
  };
  safety: {
    checks: SafetyCheck[];
    red_flags: string[];
    verdict: 'BLOCKED' | 'REVIEW_REQUIRED' | 'NO_RED_FLAGS_DETECTED';
  };
  disclaimer: string;
}

const DISCLAIMER =
  'Automated checks only — not financial advice. A clean inspection does not mean a token is safe; ' +
  'contracts can be upgraded and liquidity can be pulled after this check. ' +
  'Layer 1 gates re-run at execution time.';

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

/** The MCP's sentinel for "the chain's native gas token" (not a contract). */
export const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function nativeSymbol(chain: string): string {
  return chain === 'solana' ? 'SOL' : 'ETH';
}

async function fetchJson(f: FetchImpl, url: string): Promise<unknown> {
  const res = await f(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function inspectToken(
  contractAddress: string,
  chainName: string | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<TokenInspection> {
  const { name: chain, ds, gp } = resolveChain(chainName);
  const addr = contractAddress.trim();
  const evm = !CHAINS[chain].isSolana;
  if (evm && !isEvmAddress(addr)) throw new Error('contract_address must be a 0x EVM address for this chain');
  if (!evm && !isSolanaAddress(addr)) throw new Error('contract_address must be a Solana mint address for solana');

  const checks: SafetyCheck[] = [];
  const red_flags: string[] = [];

  // ---- Native gas token: no contract to audit ----
  // The sentinel means "the chain's gas token" (ETH/SOL) — there is no token
  // contract, so honeypot/tax/mint/ownership checks don't apply. Looking it
  // up on DexScreener/GoPlus would just produce phantom "no data" red flags.
  if (addr.toLowerCase() === NATIVE_SENTINEL) {
    const sym = nativeSymbol(chain);
    checks.push({
      name: 'native_asset',
      pass: true,
      detail: `Native gas token (${sym}) — no contract to audit: cannot be a honeypot, has no taxes, no mint function, no owner`,
    });
    return {
      ok: true,
      token: { address: addr, chain, name: `native ${sym}`, symbol: sym, decimals: chain === 'solana' ? 9 : 18 },
      facts: {
        price_usd: null, liquidity_usd: null, volume_24h_usd: null, market_cap_usd: null,
        txns_24h: null, pair_address: null, dex: null, pair_created_at: null, pair_age_days: null,
      },
      safety: { checks, red_flags, verdict: 'NO_RED_FLAGS_DETECTED' },
      disclaimer: DISCLAIMER + ' Native gas token: holding it involves no token contract.',
    };
  }

  // ---- DexScreener: market facts ----
  let dsPair: DexPair | null = null;
  try {
    const dsUrl = `https://api.dexscreener.com/tokens/v1/${ds}/${addr}`;
    const dsData = (await fetchJson(fetchImpl, dsUrl)) as DexPair[];
    if (Array.isArray(dsData) && dsData.length > 0) {
      // Most liquid pair first.
      dsPair = dsData.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    }
  } catch {
    // DexScreener miss: token may be too new or illiquid. Not fatal — the
    // safety verdict degrades to REVIEW_REQUIRED on missing market data.
  }

  const token = {
    address: addr,
    chain,
    name: dsPair?.baseToken.name ?? 'unknown',
    symbol: dsPair?.baseToken.symbol ?? 'unknown',
    decimals: null as number | null,
  };
  const pairCreatedAtMs = dsPair?.pairCreatedAt ?? null;
  const facts: TokenInspection['facts'] = {
    price_usd: dsPair?.priceUsd ? Number(dsPair.priceUsd) : null,
    liquidity_usd: dsPair?.liquidity?.usd ?? null,
    volume_24h_usd: dsPair?.volume?.h24 ?? null,
    market_cap_usd: dsPair?.marketCap ?? null,
    txns_24h: dsPair?.txns?.h24
      ? { buys: dsPair.txns.h24.buys ?? 0, sells: dsPair.txns.h24.sells ?? 0 }
      : null,
    pair_address: dsPair?.pairAddress ?? null,
    dex: dsPair?.dexId ?? null,
    pair_created_at: pairCreatedAtMs ? new Date(pairCreatedAtMs).toISOString() : null,
    pair_age_days: pairCreatedAtMs ? Math.floor((Date.now() - pairCreatedAtMs) / 86400000) : null,
  };

  if (dsPair) {
    checks.push({ name: 'market_data', pass: true, detail: `priced on ${dsPair.dexId} with $${Math.round(dsPair.liquidity?.usd ?? 0).toLocaleString()} liquidity` });
    if (pairCreatedAtMs) {
      const ageDays = facts.pair_age_days!;
      checks.push({
        name: 'pair_age',
        pass: ageDays >= 7,
        detail: `pair created ${facts.pair_created_at} (${ageDays} days ago)`,
      });
      if (ageDays < 7) {
        red_flags.push(`Very new pair: created ${ageDays} day${ageDays === 1 ? '' : 's'} ago — brand-new pairs are a classic rug vector.`);
      }
    }
    // LP lock/burn: neither DexScreener nor GoPlus token_security reports
    // it. Stated as a coverage gap rather than a pass — the agent/user must
    // verify LP lock on the explorer before sizing up.
    checks.push({
      name: 'lp_lock',
      pass: false,
      detail: 'LP lock/burn status is not reported by DexScreener or GoPlus — verify on the explorer before sizing up',
    });
  } else {
    checks.push({ name: 'market_data', pass: false, detail: 'no DexScreener pair found — token may be brand new or have no liquid market' });
    red_flags.push('No liquid market found on DexScreener — cannot verify price or liquidity.');
  }

  // ---- GoPlus: contract safety ----
  try {
    const gpUrl = `https://api.gopluslabs.io/api/v1/token_security/${gp}?contract_addresses=${addr}`;
    const gpData = (await fetchJson(fetchImpl, gpUrl)) as {
      code: number;
      result?: Record<string, Record<string, string>>;
    };
    const r = gpData.result?.[addr.toLowerCase()] ?? gpData.result?.[addr];
    if (r) {
      const isHoneypot = r.is_honeypot === '1';
      checks.push({
        name: 'honeypot',
        // GoPlus runs the buy AND sell simulation on their side; this is
        // their result, not a local simulation.
        pass: !isHoneypot,
        detail: isHoneypot ? 'SELL SIMULATION FAILED — GoPlus flags this token as a honeypot' : 'GoPlus buy/sell simulation passed (not a honeypot)',
      });
      if (isHoneypot) red_flags.push('HONEYPOT: sell simulation failed — you likely cannot sell this token.');

      const buyTax = Number(r.buy_tax ?? '0');
      const sellTax = Number(r.sell_tax ?? '0');
      const taxBad = buyTax > 10 || sellTax > 10;
      checks.push({
        name: 'token_taxes',
        pass: !taxBad,
        detail: `buy tax ${buyTax}%, sell tax ${sellTax}%`,
      });
      if (taxBad) red_flags.push(`High token tax: buy ${buyTax}% / sell ${sellTax}% — eats into every trade.`);

      if (r.is_mintable === '1') {
        checks.push({ name: 'mintable', pass: false, detail: 'contract owner can mint new tokens (supply not fixed)' });
        red_flags.push('Mintable: the owner can print more tokens at will.');
      } else {
        checks.push({ name: 'mintable', pass: true, detail: 'supply is fixed (not mintable)' });
      }

      if (r.can_take_back_ownership === '1') {
        checks.push({ name: 'ownership', pass: false, detail: 'owner can reclaim ownership after renouncing' });
        red_flags.push('Ownership can be taken back by the deployer even if renounced.');
      } else if (!r.owner_address || r.owner_address === '0x0000000000000000000000000000000000000000') {
        checks.push({ name: 'ownership', pass: true, detail: 'ownership renounced (no owner)' });
      } else {
        checks.push({ name: 'ownership', pass: true, detail: `owned by ${r.owner_address.slice(0, 10)}… (not renounced)` });
      }

      if (r.is_proxy === '1') {
        checks.push({ name: 'proxy', pass: false, detail: 'upgradeable proxy — logic can change after this check' });
        red_flags.push('Upgradeable proxy: contract logic can be swapped after inspection.');
      } else {
        checks.push({ name: 'proxy', pass: true, detail: 'not a proxy' });
      }

      const holders = r.holder_count ? Number(r.holder_count) : null;
      if (holders !== null) {
        checks.push({ name: 'holders', pass: holders >= 50, detail: `${holders.toLocaleString()} holders` });
        if (holders < 50) red_flags.push(`Only ${holders} holders — thin holder base, easy to manipulate.`);
      }
    } else {
      checks.push({ name: 'contract_safety', pass: false, detail: 'GoPlus returned no security data for this token' });
      red_flags.push('No contract safety data available — cannot verify honeypot/tax status.');
    }
  } catch {
    checks.push({ name: 'contract_safety', pass: false, detail: 'GoPlus lookup failed — safety data unavailable' });
    red_flags.push('Contract safety lookup failed — cannot verify honeypot/tax status.');
  }

  const blocked = checks.some((c) => c.name === 'honeypot' && !c.pass);
  const verdict: TokenInspection['safety']['verdict'] = blocked
    ? 'BLOCKED'
    : red_flags.length > 0
      ? 'REVIEW_REQUIRED'
      : 'NO_RED_FLAGS_DETECTED';

  return { ok: true, token, facts, safety: { checks, red_flags, verdict }, disclaimer: DISCLAIMER };
}

/** Execution-time gate: re-run inspection on the token being bought. */
export async function executionGate(
  contractAddress: string,
  chain: string | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<{ pass: boolean; reason: string; verdict: TokenInspection['safety']['verdict'] }> {
  const inspection = await inspectToken(contractAddress, chain, fetchImpl);
  if (inspection.safety.verdict === 'BLOCKED') {
    return { pass: false, reason: `execution blocked: ${inspection.safety.red_flags.join(' ')}`, verdict: 'BLOCKED' };
  }
  return { pass: true, reason: `inspection verdict: ${inspection.safety.verdict}`, verdict: inspection.safety.verdict };
}
