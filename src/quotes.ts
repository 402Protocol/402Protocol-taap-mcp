/**
 * Quote engine — smart order router (paper v1).
 *
 * Same-chain EVM: KyberSwap aggregator (+ 0x when ZEROEX_API_KEY is set).
 * Solana: Jupiter lite API.
 * Cross-chain (NEAR Intents): interface defined, Phase-2 venue.
 *
 * The 402 fee — max(50 bps, $0.50 minimum) — is applied AT THE QUOTE LAYER,
 * so it survives venue choice: the router optimizes for the user's net-of-fee
 * fill. The minimum is denominated in USD and converted into output-token
 * units at quote time; dust trades whose output can't cover it get no quote.
 * Quotes are dry (no signing, no broadcasting) and expire after QUOTE_TTL_SECONDS.
 */
import { QUOTE_TTL_SECONDS, TAAP_FEE_BPS, TAAP_MIN_FEE_USD } from './config.js';
import { resolveChain, inspectToken, NATIVE_SENTINEL, type FetchImpl } from './tokens.js';
export { NATIVE_SENTINEL };
import type { TaapDb } from './db.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface VenueQuote {
  venue: string;
  amount_out_gross_raw: string;
  eta_seconds: number;
}

export interface NetQuote {
  quote_id: string;
  venue: string;
  chain: string;
  token_in: string;
  token_out: string;
  symbol_in: string;
  symbol_out: string;
  decimals_in: number;
  decimals_out: number;
  amount_in_raw: string;
  /** Server-side USD valuation of the input leg (null when unpriceable). */
  amount_in_usd: number | null;
  amount_out_gross_raw: string;
  /** What the user actually receives: gross minus the 402 fee. */
  amount_out_net_raw: string;
  /** The 402 fee, in output-token units. */
  fee_raw: string;
  fee_bps: number;
  /** True when the $ minimum (not the bps leg) set the fee. */
  min_fee_applied: boolean;
  eta_seconds: number;
  expires_at: number;
  all_venues: VenueQuote[];
}

/** net = gross * (10000 - feeBps) / 10000, floored. Exact BigInt math. */
export function applyFee(grossRaw: string, feeBps: number = TAAP_FEE_BPS): { net: string; fee: string } {
  const gross = BigInt(grossRaw);
  const net = (gross * BigInt(10000 - feeBps)) / 10000n;
  return { net: net.toString(), fee: (gross - net).toString() };
}

export interface FeeResult {
  net: string;
  fee: string;
  min_applied: boolean;
}

/**
 * 402 fee = max(feeBps of gross, minFeeUsd), taken from the output amount.
 *
 * The minimum is denominated in USD and converted into output-token raw
 * units at the output token's quoted USD price, falling back to the input
 * leg's valuation (a swap preserves approximate value). The USD leg is
 * rounded UP so float dust never undercharges the minimum.
 *
 * Throws QUOTE_TOO_SMALL when the fee would consume the whole output
 * (dust trade — no quote, honestly), and QUOTE_UNPRICEABLE when neither
 * leg can be valued: fail closed rather than silently undercharge the fee.
 */
export function applyFeeWithMin(
  grossRaw: string,
  opts: {
    decimalsOut: number;
    outputUsdPrice: number | null | undefined;
    fallbackUsdPrice: number | null | undefined;
    feeBps?: number;
    minFeeUsd?: number;
  },
): FeeResult {
  const gross = BigInt(grossRaw);
  if (gross <= 0n) throw new Error('gross must be positive');
  const feeBps = opts.feeBps ?? TAAP_FEE_BPS;
  const minFeeUsd = opts.minFeeUsd ?? TAAP_MIN_FEE_USD;

  // bps leg — exact BigInt math.
  let fee = (gross * BigInt(feeBps)) / 10000n;
  let minApplied = false;

  if (minFeeUsd > 0) {
    const price =
      opts.outputUsdPrice && opts.outputUsdPrice > 0
        ? opts.outputUsdPrice
        : opts.fallbackUsdPrice && opts.fallbackUsdPrice > 0
          ? opts.fallbackUsdPrice
          : null;
    if (price === null) {
      throw new Error('QUOTE_UNPRICEABLE: cannot value the output for the minimum-fee computation');
    }
    const rawFloat = (minFeeUsd / price) * 10 ** opts.decimalsOut;
    let minRaw = BigInt(Math.ceil(rawFloat));
    // Correct float overshoot: step down while (minRaw - 1) still covers the minimum.
    while (minRaw > 0n && ((Number(minRaw - 1n) * price) / 10 ** opts.decimalsOut) >= minFeeUsd) minRaw -= 1n;
    if (minRaw > fee) {
      fee = minRaw;
      minApplied = true;
    }
  }

  const net = gross - fee;
  if (net <= 0n) {
    throw new Error('QUOTE_TOO_SMALL: the minimum fee would consume the entire output — trade too small');
  }
  return { net: net.toString(), fee: fee.toString(), min_applied: minApplied };
}

async function getJson(f: FetchImpl, url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await f(url, { headers: { Accept: 'application/json', ...(headers ?? {}) } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function kyberQuote(
  chain: string,
  kyberChain: string,
  tokenIn: string,
  tokenOut: string,
  amountInRaw: string,
  f: FetchImpl,
): Promise<VenueQuote> {
  const url =
    `https://aggregator-api.kyberswap.com/${kyberChain}/api/v1/routes` +
    `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountInRaw}&gasInclude=true`;
  const data = (await getJson(f, url)) as {
    code?: number;
    message?: string;
    data?: { routeSummary?: { amountOut?: string; gas?: string } };
  };
  const amountOut = data.data?.routeSummary?.amountOut;
  if (!amountOut) throw new Error(`kyberswap: no route (${data.message ?? 'empty'})`);
  return { venue: 'kyberswap', amount_out_gross_raw: amountOut, eta_seconds: 5 };
}

/**
 * 0x v2 — indicative price (read-only, no taker needed, no calldata).
 * Projects stay separate: TaaP never routes through The Hub.
 * Requires ZEROEX_API_KEY (free at https://dashboard.0x.org).
 */
async function zeroExQuote(
  chain: string,
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountInRaw: string,
  apiKey: string,
  f: FetchImpl,
): Promise<VenueQuote> {
  const url =
    `https://api.0x.org/swap/allowance-holder/price?chainId=${chainId}` +
    `&sellToken=${tokenIn}&buyToken=${tokenOut}&sellAmount=${amountInRaw}`;
  const data = (await getJson(f, url, { '0x-api-key': apiKey, '0x-version': 'v2' })) as {
    buyAmount?: string;
    liquidityAvailable?: boolean;
    reason?: string;
    message?: string;
  };
  if (!data.buyAmount) {
    throw new Error(`0x: no quote (${data.reason ?? data.message ?? 'empty'})`);
  }
  if (data.liquidityAvailable === false) throw new Error('0x: no liquidity for this pair');
  return { venue: '0x', amount_out_gross_raw: data.buyAmount, eta_seconds: 5 };
}

async function jupiterQuote(
  tokenIn: string,
  tokenOut: string,
  amountInRaw: string,
  f: FetchImpl,
): Promise<VenueQuote> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${tokenIn}&outputMint=${tokenOut}` +
    `&amount=${amountInRaw}&slippageBps=50`;
  const data = (await getJson(f, url)) as { outAmount?: string; error?: string };
  if (!data.outAmount) throw new Error(`jupiter: no quote (${data.error ?? 'empty'})`);
  return { venue: 'jupiter', amount_out_gross_raw: data.outAmount, eta_seconds: 3 };
}

const EVM_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  bsc: 56,
  ink: 57073,
  robinhood: 4663,
};

export interface QuoteRequest {
  trader_id: string;
  chain: string;
  token_in: string;
  token_out: string;
  symbol_in: string;
  symbol_out: string;
  decimals_in: number;
  decimals_out: number;
  amount_in_raw: string;
}

export async function getNetQuote(
  db: TaapDb,
  req: QuoteRequest,
  opts: { fetchImpl?: FetchImpl; zeroExApiKey?: string } = {},
): Promise<NetQuote> {
  const f = opts.fetchImpl ?? fetch;
  const { name: chain, kyber, isSolana } = resolveChain(req.chain);
  if (BigInt(req.amount_in_raw) <= 0n) throw new Error('amount_in must be positive');

  // Layer 1, quote time: BLOCKED means no quote, ever. (The execution-time
  // gate re-runs this at fill; this is the earlier tripwire the tool docs
  // promise.) Fail closed: if the inspection itself errors, there is no
  // quote — we cannot prove the token isn't a honeypot.
  const buySide = await inspectToken(req.token_out, chain, f);
  if (buySide.safety.verdict === 'BLOCKED') {
    throw new Error(
      `swap_quote refused: ${buySide.token.symbol} is BLOCKED (${buySide.safety.red_flags.join(' ')}) — no quote, no fill, ever`,
    );
  }

  // Server-side USD valuation of the input leg. The auto-approve threshold
  // is enforced against THIS number — never against an agent's claim.
  // Null when unpriceable: then explicit approval is always required.
  let amount_in_usd: number | null = null;
  try {
    const inInspection = await inspectToken(req.token_in, chain, f);
    if (inInspection.facts.price_usd && inInspection.facts.price_usd > 0) {
      amount_in_usd = (Number(req.amount_in_raw) / 10 ** req.decimals_in) * inInspection.facts.price_usd;
    }
  } catch {
    amount_in_usd = null;
  }

  const attempts: Promise<VenueQuote>[] = [];
  if (isSolana) {
    attempts.push(jupiterQuote(req.token_in, req.token_out, req.amount_in_raw, f));
  } else {
    if (kyber) attempts.push(kyberQuote(chain, kyber, req.token_in, req.token_out, req.amount_in_raw, f));
    if (opts.zeroExApiKey && EVM_CHAIN_IDS[chain]) {
      attempts.push(
        zeroExQuote(chain, EVM_CHAIN_IDS[chain], req.token_in, req.token_out, req.amount_in_raw, opts.zeroExApiKey, f),
      );
    }
    // NEAR Intents cross-chain: Phase-2 venue (interface reserved).
  }
  if (attempts.length === 0) throw new Error(`no venues available for chain "${chain}"`);

  const settled = await Promise.allSettled(attempts);
  const venues: VenueQuote[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') venues.push(s.value);
  }
  if (venues.length === 0) {
    const reasons = settled
      .map((s) => (s.status === 'rejected' ? (s.reason as Error).message : ''))
      .join('; ');
    throw new Error(`all venues failed: ${reasons}`);
  }

  // Minimum-fee valuation: prefer the output token's own USD price, fall back
  // to the input leg (a swap preserves approximate value).
  const outputUsdPrice = buySide.facts.price_usd ?? null;
  let fallbackUsdPrice: number | null = null;
  if (amount_in_usd && amount_in_usd > 0 && Number(req.amount_in_raw) > 0) {
    fallbackUsdPrice = amount_in_usd / (Number(req.amount_in_raw) / 10 ** req.decimals_in);
  }

  // Best net-of-fee fill wins. A venue whose gross can't cover the minimum
  // fee is skipped; if none can, the trade is dust — say so honestly.
  const feeOpts = { decimalsOut: req.decimals_out, outputUsdPrice, fallbackUsdPrice };
  const ranked: { v: VenueQuote; net: string; fee: string; min_applied: boolean }[] = [];
  for (const v of venues) {
    try {
      ranked.push({ v, ...applyFeeWithMin(v.amount_out_gross_raw, feeOpts) });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('QUOTE_TOO_SMALL')) continue;
      throw e;
    }
  }
  if (ranked.length === 0) {
    throw new Error('QUOTE_TOO_SMALL: trade too small — the minimum fee would consume the entire output');
  }
  ranked.sort((a, b) => (BigInt(b.net) > BigInt(a.net) ? 1 : -1));
  const best = ranked[0];
  const now = Math.floor(Date.now() / 1000);

  const saved = db.saveQuote({
    trader_id: req.trader_id,
    venue: best.v.venue,
    chain,
    token_in: req.token_in,
    token_out: req.token_out,
    symbol_in: req.symbol_in,
    symbol_out: req.symbol_out,
    decimals_in: req.decimals_in,
    decimals_out: req.decimals_out,
    amount_in_raw: req.amount_in_raw,
    amount_out_gross_raw: best.v.amount_out_gross_raw,
    amount_out_net_raw: best.net,
    fee_raw: best.fee,
    amount_in_usd,
    expires_at: now + QUOTE_TTL_SECONDS,
  });

  return {
    quote_id: saved.quote_id,
    venue: best.v.venue,
    chain,
    token_in: req.token_in,
    token_out: req.token_out,
    symbol_in: req.symbol_in,
    symbol_out: req.symbol_out,
    decimals_in: req.decimals_in,
    decimals_out: req.decimals_out,
    amount_in_raw: req.amount_in_raw,
    amount_in_usd,
    amount_out_gross_raw: best.v.amount_out_gross_raw,
    amount_out_net_raw: best.net,
    fee_raw: best.fee,
    fee_bps: TAAP_FEE_BPS,
    min_fee_applied: best.min_applied,
    eta_seconds: best.v.eta_seconds,
    expires_at: saved.expires_at,
    all_venues: venues,
  };
}
