/**
 * Trigger engine — standing strategies ("sell half my FUG if it doubles").
 *
 * set_trigger stores the strategy with the price baseline at set time.
 * checkTriggers() polls the live price (DexScreener) for each active trigger
 * and, when the condition trips, paper-executes within the trigger's caps
 * and marks it fired (one-shot). A cron or the agent calls check_triggers
 * on a schedule; the tool is also exposed for dogfooding.
 *
 * Paper v1 actions: sell_pct (sell N% of the token balance for USDC).
 */
import type { TaapDb, Trigger } from './db.js';
import { inspectToken, resolveChain, type FetchImpl } from './tokens.js';
import { getNetQuote } from './quotes.js';
import { executePaperQuote } from './paper.js';

export interface TriggerCondition {
  type: 'price_up_pct';
  /** e.g. 100 = "if it doubles" */
  pct: number;
}

export interface TriggerAction {
  type: 'sell_pct';
  /** e.g. 50 = "sell half" */
  pct: number;
  /** USDC (or chain-native stable) token address to sell into */
  stable_token: string;
  stable_symbol: string;
  stable_decimals: number;
}

export async function setTrigger(
  db: TaapDb,
  args: {
    trader_id: string;
    chain: string;
    token_address: string;
    action: TriggerAction;
    condition: TriggerCondition;
    fetchImpl?: FetchImpl;
  },
): Promise<Trigger> {
  const trader = db.getTrader(args.trader_id);
  if (!trader) throw new Error('unknown trader_id — call get_started first');
  if (trader.paused) throw new Error('trading_paused — cannot arm triggers while the kill switch is engaged');
  const { name: chain } = resolveChain(args.chain);
  if (args.action.pct <= 0 || args.action.pct > 100) throw new Error('sell pct must be 1-100');
  if (args.condition.pct <= 0) throw new Error('price_up_pct must be positive');

  // Baseline = live price NOW, from the same inspection path as token_resolve.
  const inspection = await inspectToken(args.token_address, chain, args.fetchImpl);
  const baseline = inspection.facts.price_usd;
  if (!baseline || baseline <= 0) throw new Error('cannot arm trigger: no live price for this token');
  if (inspection.safety.verdict === 'BLOCKED') {
    throw new Error(`cannot arm trigger: token is BLOCKED (${inspection.safety.red_flags.join(' ')})`);
  }

  return db.createTrigger({
    trader_id: args.trader_id,
    chain,
    token_address: args.token_address,
    symbol: inspection.token.symbol,
    action: JSON.stringify(args.action),
    condition: JSON.stringify(args.condition),
    baseline_price_usd: baseline,
  });
}

export interface TriggerFireReport {
  trigger_id: string;
  fired: boolean;
  detail: string;
  trade_id?: string;
}

/** Poll every active trigger once. Returns one report per trigger checked. */
export async function checkTriggers(
  db: TaapDb,
  opts: { fetchImpl?: FetchImpl; zeroExApiKey?: string } = {},
): Promise<TriggerFireReport[]> {
  const reports: TriggerFireReport[] = [];
  for (const trg of db.activeTriggers()) {
    try {
      const condition = JSON.parse(trg.condition) as TriggerCondition;
      const action = JSON.parse(trg.action) as TriggerAction;
      const inspection = await inspectToken(trg.token_address, trg.chain, opts.fetchImpl);
      const price = inspection.facts.price_usd;
      if (!price || price <= 0) {
        reports.push({ trigger_id: trg.trigger_id, fired: false, detail: 'no live price — skipped' });
        continue;
      }
      const target = trg.baseline_price_usd * (1 + condition.pct / 100);
      if (price < target) {
        reports.push({
          trigger_id: trg.trigger_id,
          fired: false,
          detail: `watching: $${price} vs target $${target} (+${condition.pct}% from $${trg.baseline_price_usd})`,
        });
        continue;
      }
      // The price poll already re-inspected the token: if it turned
      // BLOCKED since arming, retire the trigger instead of simulating a
      // sale that could never execute onchain.
      if (inspection.safety.verdict === 'BLOCKED') {
        db.fireTrigger(trg.trigger_id);
        reports.push({
          trigger_id: trg.trigger_id,
          fired: true,
          detail: `token turned BLOCKED (${inspection.safety.red_flags.join(' ')}) — trigger retired without selling`,
        });
        continue;
      }
      // Condition tripped — execute within caps.
      const trader = db.getTrader(trg.trader_id);
      if (!trader || trader.paused) {
        reports.push({ trigger_id: trg.trigger_id, fired: false, detail: 'trader paused or gone — skipped' });
        continue;
      }
      const bal = db.getBalance(trg.trader_id, trg.chain, trg.token_address);
      if (!bal || BigInt(bal.amount_raw) <= 0n) {
        db.fireTrigger(trg.trigger_id);
        reports.push({ trigger_id: trg.trigger_id, fired: true, detail: 'condition tripped but balance was zero — trigger retired' });
        continue;
      }
      const sellRaw = (BigInt(bal.amount_raw) * BigInt(Math.round(action.pct * 100))) / 10000n;
      if (sellRaw <= 0n) {
        reports.push({ trigger_id: trg.trigger_id, fired: false, detail: 'dust balance — skipped' });
        continue;
      }
      const quote = await getNetQuote(
        db,
        {
          trader_id: trg.trader_id,
          chain: trg.chain,
          token_in: trg.token_address,
          token_out: action.stable_token,
          symbol_in: bal.symbol,
          symbol_out: action.stable_symbol,
          decimals_in: bal.decimals,
          decimals_out: action.stable_decimals,
          amount_in_raw: sellRaw.toString(),
        },
        opts,
      );
      // Atomic single-claim: if two pollers overlap, exactly one wins the
      // trigger and the loser skips instead of double-selling.
      if (!db.claimTrigger(trg.trigger_id)) {
        reports.push({ trigger_id: trg.trigger_id, fired: false, detail: 'already claimed by another poller — skipped' });
        continue;
      }
      // Triggers carry the user's standing approval (the mandate): the user
      // approved "sell half if it doubles" at set time, so user_approved=true
      // here is the mandate executing — not the agent self-authorizing.
      const fill = await executePaperQuote(db, trg.trader_id, quote.quote_id, {
        user_approved: true,
        fetchImpl: opts.fetchImpl,
      });
      db.markTriggerFired(trg.trigger_id);
      reports.push({
        trigger_id: trg.trigger_id,
        fired: true,
        detail: `sold ${action.pct}% of ${trg.symbol} at $${price} (+${condition.pct}% target hit)`,
        trade_id: fill.trade_id,
      });
    } catch (e) {
      reports.push({ trigger_id: trg.trigger_id, fired: false, detail: `check failed: ${(e as Error).message}` });
    }
  }
  return reports;
}
