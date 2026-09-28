/**
 * Paper execution engine.
 *
 * There is deliberately NO signing code path anywhere in this file. Paper
 * fills simulate execution at the quoted net price: balances move in the
 * paper ledger, the 402 fee accrues in the paper fee ledger, and every
 * fill is tagged with a `paper:` reference that can never be confused with
 * a real transaction hash.
 *
 * Execution-time safety (spec + TaaP brief §4): Layer 1 gates re-run HERE,
 * at execution time — not just at inspection time. A token that turned
 * malicious between "looks fine" and "buy" gets blocked at the fill.
 */
import type { TaapDb, Trader } from './db.js';
import { executionGate, resolveChain, type FetchImpl } from './tokens.js';

export interface PaperFill {
  trade_id: string;
  paper_ref: string;
  venue: string;
  symbol_in: string;
  symbol_out: string;
  amount_in_raw: string;
  amount_out_raw: string;
  fee_raw: string;
  status: 'SUCCESS';
}

export function provisionTrader(db: TaapDb): Trader {
  return db.createTrader();
}

/** Credit play funds. Paper mode only — the sandbox faucet. */
export function paperFaucet(
  db: TaapDb,
  trader_id: string,
  chain: string,
  token_address: string,
  symbol: string,
  decimals: number,
  amountHuman: string,
): string {
  const trader = db.getTrader(trader_id);
  if (!trader) throw new Error('unknown trader_id — call get_started first');
  const { name: chainName } = resolveChain(chain);
  if (!/^\d+(\.\d+)?$/.test(amountHuman)) throw new Error('amount must be a positive decimal');
  const [whole, frac = ''] = amountHuman.split('.');
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
  const next = db.adjustBalance(trader_id, chainName, token_address, symbol, decimals, raw);
  db.markFunded(trader_id);
  return next;
}

export interface ExecuteOpts {
  /** The agent sets this true only when the user approved OR the trade is under the auto-approve threshold with green safety. The server re-verifies. */
  user_approved: boolean;
  fetchImpl?: FetchImpl;
}

export async function executePaperQuote(
  db: TaapDb,
  trader_id: string,
  quote_id: string,
  opts: ExecuteOpts,
): Promise<PaperFill> {
  const trader = db.getTrader(trader_id);
  if (!trader) throw new Error('unknown trader_id — call get_started first');
  if (trader.paused) throw new Error('trading_paused — kill switch is engaged. Call resume_trading to lift it.');

  const quote = db.getQuote(quote_id);
  if (!quote || quote.trader_id !== trader_id) throw new Error('unknown or foreign quote_id');
  const now = Math.floor(Date.now() / 1000);
  if (quote.expires_at < now) throw new Error('quote_expired — quotes live 60 seconds; request a fresh swap_quote');

  // Approval, enforced by the server — never by trusting the agent's claim.
  // Two paths:
  //   1. user_approved=true: the user explicitly approved this trade.
  //   2. auto-approve: the trader set a threshold via set_auto_approve (that
  //      setting IS the standing approval), the trade's server-side USD
  //      value is known and at/under it, and the execution-time inspection
  //      is fully green. Anything else needs an explicit yes.
  if (!opts.user_approved) {
    const threshold = trader.auto_approve_threshold_usd;
    if (!(threshold > 0)) {
      throw new Error(
        'user_approved=false and no auto-approve threshold is set — the user must approve this trade explicitly ' +
        '(or set a threshold with set_auto_approve for under-threshold green trades)',
      );
    }
    if (quote.amount_in_usd == null) {
      throw new Error('user_approved=false and the trade USD value is unknown — explicit approval required');
    }
    if (quote.amount_in_usd > threshold) {
      throw new Error(
        `user_approved=false: trade value $${quote.amount_in_usd.toFixed(2)} exceeds the auto-approve threshold ` +
        `$${threshold} — explicit approval required`,
      );
    }
  }

  // Execution-time Layer 1 gate: re-inspect the token being BOUGHT, now.
  const gate = await executionGate(quote.token_out, quote.chain, opts.fetchImpl);
  if (!gate.pass) throw new Error(gate.reason);

  // Red flags always need an explicit yes — regardless of size. A green
  // threshold never auto-approves a REVIEW_REQUIRED token.
  if (!opts.user_approved && gate.verdict !== 'NO_RED_FLAGS_DETECTED') {
    throw new Error(
      `auto-approve refused: execution-time inspection is ${gate.verdict} — red flags need explicit per-trade approval regardless of size`,
    );
  }

  // Atomic fill: quote claim (single-use) + both balance moves + trade and
  // fee records in one transaction.
  const trade = db.fillQuoteAtomic({
    quote_id: quote.quote_id,
    trader_id,
    venue: quote.venue,
    chain: quote.chain,
    token_in: quote.token_in,
    symbol_in: quote.symbol_in,
    decimals_in: quote.decimals_in,
    amount_in_raw: quote.amount_in_raw,
    token_out: quote.token_out,
    symbol_out: quote.symbol_out,
    decimals_out: quote.decimals_out,
    amount_out_net_raw: quote.amount_out_net_raw,
    fee_raw: quote.fee_raw,
  });

  return {
    trade_id: trade.trade_id,
    paper_ref: trade.paper_ref,
    venue: quote.venue,
    symbol_in: quote.symbol_in,
    symbol_out: quote.symbol_out,
    amount_in_raw: quote.amount_in_raw,
    amount_out_raw: quote.amount_out_net_raw,
    fee_raw: quote.fee_raw,
    status: 'SUCCESS',
  };
}
