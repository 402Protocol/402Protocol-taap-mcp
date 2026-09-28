/**
 * TaaP paper-mode storage (node:sqlite, DatabaseSync). Same conventions as
 * the jobs DB: synchronous API, multi-step mutations inside BEGIN/COMMIT.
 *
 * Trust split: this DB is paper accounting. Real quotes come from live venue
 * APIs; real token inspections come from live data APIs. Nothing here can
 * move real money — execution in paper mode is simulated fills only.
 *
 * Amounts are stored as integer strings in the token's own decimals
 * (amount_raw) with a decimals column, so all math is exact BigInt math.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface Trader {
  trader_id: string;
  created_at: number;
  paused: number;
  auto_approve_threshold_usd: number;
  funded: number;
  claim_token: string | null;
}

export interface PaperBalance {
  trader_id: string;
  chain: string;
  token_address: string;
  symbol: string;
  decimals: number;
  amount_raw: string;
}

export interface Quote {
  quote_id: string;
  trader_id: string;
  venue: string;
  chain: string;
  token_in: string;
  token_out: string;
  symbol_in: string;
  symbol_out: string;
  decimals_in: number;
  decimals_out: number;
  amount_in_raw: string;
  amount_out_gross_raw: string;
  amount_out_net_raw: string;
  fee_raw: string;
  /** Server-side USD valuation of the input leg (null when unpriceable). Drives the auto-approve threshold. */
  amount_in_usd: number | null;
  /** Single-use: set to 1 the moment the quote fills. Re-execution is rejected. */
  used: number;
  expires_at: number;
  created_at: number;
}

export interface PaperTrade {
  trade_id: string;
  trader_id: string;
  quote_id: string;
  venue: string;
  chain: string;
  symbol_in: string;
  symbol_out: string;
  amount_in_raw: string;
  amount_out_raw: string;
  fee_raw: string;
  paper_ref: string;
  status: string;
  created_at: number;
}

export interface Trigger {
  trigger_id: string;
  trader_id: string;
  chain: string;
  token_address: string;
  symbol: string;
  action: string;
  condition: string; // JSON
  baseline_price_usd: number;
  active: number;
  created_at: number;
  fired_at: number | null;
}

export class TaapDb {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traders (
        trader_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        auto_approve_threshold_usd REAL NOT NULL DEFAULT 0,
        funded INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_balances (
        trader_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        amount_raw TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (trader_id, chain, token_address)
      );
      CREATE TABLE IF NOT EXISTS quotes (
        quote_id TEXT PRIMARY KEY,
        trader_id TEXT NOT NULL,
        venue TEXT NOT NULL,
        chain TEXT NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        symbol_in TEXT NOT NULL,
        symbol_out TEXT NOT NULL,
        decimals_in INTEGER NOT NULL,
        decimals_out INTEGER NOT NULL,
        amount_in_raw TEXT NOT NULL,
        amount_out_gross_raw TEXT NOT NULL,
        amount_out_net_raw TEXT NOT NULL,
        fee_raw TEXT NOT NULL,
        amount_in_usd REAL,
        used INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_trades (
        trade_id TEXT PRIMARY KEY,
        trader_id TEXT NOT NULL,
        quote_id TEXT NOT NULL,
        venue TEXT NOT NULL,
        chain TEXT NOT NULL,
        symbol_in TEXT NOT NULL,
        symbol_out TEXT NOT NULL,
        amount_in_raw TEXT NOT NULL,
        amount_out_raw TEXT NOT NULL,
        fee_raw TEXT NOT NULL,
        paper_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fee_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trader_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        fee_raw TEXT NOT NULL,
        fee_asset TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS triggers (
        trigger_id TEXT PRIMARY KEY,
        trader_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        condition TEXT NOT NULL,
        baseline_price_usd REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        fired_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS withdrawals (
        id TEXT PRIMARY KEY,
        trader_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        symbol TEXT NOT NULL,
        amount_raw TEXT NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // Lightweight migrations for the quotes table (older paper DBs predate
    // the single-use flag and the server-side USD valuation).
    const quoteCols = new Set(
      (this.db.prepare('PRAGMA table_info(quotes)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!quoteCols.has('used')) {
      this.db.exec('ALTER TABLE quotes ADD COLUMN used INTEGER NOT NULL DEFAULT 0');
    }
    if (!quoteCols.has('amount_in_usd')) {
      this.db.exec('ALTER TABLE quotes ADD COLUMN amount_in_usd REAL');
    }
    // Traders: claim_token remembers which claim link minted this trader's
    // wallet, so the agent never loses track of it (and never mints two).
    const traderCols = new Set(
      (this.db.prepare('PRAGMA table_info(traders)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!traderCols.has('claim_token')) {
      this.db.exec('ALTER TABLE traders ADD COLUMN claim_token TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- traders ----

  createTrader(): Trader {
    const trader_id = `paper_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('INSERT INTO traders (trader_id, created_at) VALUES (?, ?)')
      .run(trader_id, now);
    return this.getTrader(trader_id)!;
  }

  getTrader(trader_id: string): Trader | undefined {
    return this.db
      .prepare('SELECT * FROM traders WHERE trader_id = ?')
      .get(trader_id) as Trader | undefined;
  }

  /** Remember the claim link token minted for this trader's wallet. */
  setClaimToken(trader_id: string, token: string): void {
    this.db.prepare('UPDATE traders SET claim_token = ? WHERE trader_id = ?').run(token, trader_id);
  }

  setPaused(trader_id: string, paused: boolean): void {
    this.db.prepare('UPDATE traders SET paused = ? WHERE trader_id = ?').run(paused ? 1 : 0, trader_id);
  }

  setAutoApproveThreshold(trader_id: string, thresholdUsd: number): void {
    this.db
      .prepare('UPDATE traders SET auto_approve_threshold_usd = ? WHERE trader_id = ?')
      .run(thresholdUsd, trader_id);
  }

  markFunded(trader_id: string): void {
    this.db.prepare('UPDATE traders SET funded = 1 WHERE trader_id = ?').run(trader_id);
  }

  // ---- balances ----

  /**
   * Apply a balance delta. Does NOT manage transactions — callers that need
   * atomicity (fillQuoteAtomic) hold the transaction; the public
   * adjustBalance wraps a single delta in its own.
   */
  private applyDelta(
    trader_id: string,
    chain: string,
    token_address: string,
    symbol: string,
    decimals: number,
    delta_raw: bigint,
  ): void {
    const addr = token_address.toLowerCase();
    const row = this.db
      .prepare(
        'SELECT amount_raw FROM paper_balances WHERE trader_id = ? AND chain = ? AND token_address = ?',
      )
      .get(trader_id, chain, addr) as { amount_raw: string } | undefined;
    const next = (row ? BigInt(row.amount_raw) : 0n) + delta_raw;
    if (next < 0n) throw new Error('insufficient paper balance');
    if (row) {
      this.db
        .prepare(
          'UPDATE paper_balances SET amount_raw = ?, symbol = ?, decimals = ? WHERE trader_id = ? AND chain = ? AND token_address = ?',
        )
        .run(next.toString(), symbol, decimals, trader_id, chain, addr);
    } else {
      this.db
        .prepare(
          'INSERT INTO paper_balances (trader_id, chain, token_address, symbol, decimals, amount_raw) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(trader_id, chain, addr, symbol, decimals, next.toString());
    }
  }

  /** Add (or subtract, with negative raw) to a paper balance. */
  adjustBalance(
    trader_id: string,
    chain: string,
    token_address: string,
    symbol: string,
    decimals: number,
    delta_raw: bigint,
  ): string {
    this.db.exec('BEGIN');
    try {
      this.applyDelta(trader_id, chain, token_address, symbol, decimals, delta_raw);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getBalance(trader_id, chain, token_address)!.amount_raw;
  }

  getBalances(trader_id: string): PaperBalance[] {
    return this.db
      .prepare('SELECT * FROM paper_balances WHERE trader_id = ? ORDER BY symbol')
      .all(trader_id) as unknown as PaperBalance[];
  }

  getBalance(trader_id: string, chain: string, token_address: string): PaperBalance | undefined {
    return this.db
      .prepare('SELECT * FROM paper_balances WHERE trader_id = ? AND chain = ? AND token_address = ?')
      .get(trader_id, chain, token_address.toLowerCase()) as PaperBalance | undefined;
  }

  // ---- quotes ----

  saveQuote(q: Omit<Quote, 'quote_id' | 'created_at' | 'used' | 'amount_in_usd'> & { used?: number; amount_in_usd?: number | null }): Quote {
    const quote_id = `q_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const created_at = Math.floor(Date.now() / 1000);
    // Hygiene: drop dead quotes so the table can't grow forever.
    this.db.prepare('DELETE FROM quotes WHERE expires_at < ?').run(created_at);
    this.db
      .prepare(
        `INSERT INTO quotes (quote_id, trader_id, venue, chain, token_in, token_out,
         symbol_in, symbol_out, decimals_in, decimals_out, amount_in_raw,
         amount_out_gross_raw, amount_out_net_raw, fee_raw, amount_in_usd, used, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote_id, q.trader_id, q.venue, q.chain, q.token_in.toLowerCase(), q.token_out.toLowerCase(),
        q.symbol_in, q.symbol_out, q.decimals_in, q.decimals_out, q.amount_in_raw,
        q.amount_out_gross_raw, q.amount_out_net_raw, q.fee_raw,
        q.amount_in_usd ?? null, q.used ?? 0, q.expires_at, created_at,
      );
    return this.getQuote(quote_id)!;
  }

  getQuote(quote_id: string): Quote | undefined {
    return this.db.prepare('SELECT * FROM quotes WHERE quote_id = ?').get(quote_id) as Quote | undefined;
  }

  // ---- paper trades ----

  /**
   * The atomic fill: claim the quote (single-use), move both balances, and
   * record the trade + fee ledger entry in ONE transaction. A crash at any
   * point leaves the ledger exactly as it was — never a moved balance
   * without a trade, never a trade without moved balances.
   */
  fillQuoteAtomic(fill: {
    quote_id: string;
    trader_id: string;
    venue: string;
    chain: string;
    token_in: string;
    symbol_in: string;
    decimals_in: number;
    amount_in_raw: string;
    token_out: string;
    symbol_out: string;
    decimals_out: number;
    amount_out_net_raw: string;
    fee_raw: string;
  }): PaperTrade {
    const trade_id = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const paper_ref = `paper:${trade_id}`;
    const created_at = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN');
    try {
      // Single-use claim: exactly one filler wins the quote.
      const claim = this.db
        .prepare('UPDATE quotes SET used = 1 WHERE quote_id = ? AND used = 0')
        .run(fill.quote_id);
      if (claim.changes === 0) {
        throw new Error('quote_already_consumed — each quote fills at most once; request a fresh swap_quote');
      }
      const bal = this.getBalance(fill.trader_id, fill.chain, fill.token_in);
      if (!bal || BigInt(bal.amount_raw) < BigInt(fill.amount_in_raw)) {
        throw new Error(`insufficient paper ${fill.symbol_in} balance for this fill`);
      }
      this.applyDelta(fill.trader_id, fill.chain, fill.token_in, fill.symbol_in, fill.decimals_in, -BigInt(fill.amount_in_raw));
      this.applyDelta(fill.trader_id, fill.chain, fill.token_out, fill.symbol_out, fill.decimals_out, BigInt(fill.amount_out_net_raw));
      this.db
        .prepare(
          `INSERT INTO paper_trades (trade_id, trader_id, quote_id, venue, chain,
           symbol_in, symbol_out, amount_in_raw, amount_out_raw, fee_raw, paper_ref, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trade_id, fill.trader_id, fill.quote_id, fill.venue, fill.chain, fill.symbol_in, fill.symbol_out,
          fill.amount_in_raw, fill.amount_out_net_raw, fill.fee_raw, paper_ref, 'SUCCESS', created_at,
        );
      this.db
        .prepare(
          'INSERT INTO fee_ledger (trader_id, trade_id, fee_raw, fee_asset, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(fill.trader_id, trade_id, fill.fee_raw, fill.symbol_out, created_at);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getPaperTrade(trade_id)!;
  }

  /** Kept for compatibility; prefer fillQuoteAtomic for fills. */
  recordPaperTrade(t: Omit<PaperTrade, 'trade_id' | 'created_at' | 'paper_ref'>): PaperTrade {
    const trade_id = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const paper_ref = `paper:${trade_id}`;
    const created_at = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO paper_trades (trade_id, trader_id, quote_id, venue, chain,
           symbol_in, symbol_out, amount_in_raw, amount_out_raw, fee_raw, paper_ref, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trade_id, t.trader_id, t.quote_id, t.venue, t.chain, t.symbol_in, t.symbol_out,
          t.amount_in_raw, t.amount_out_raw, t.fee_raw, paper_ref, t.status, created_at,
        );
      this.db
        .prepare(
          'INSERT INTO fee_ledger (trader_id, trade_id, fee_raw, fee_asset, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(t.trader_id, trade_id, t.fee_raw, t.symbol_out, created_at);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getPaperTrade(trade_id)!;
  }

  getPaperTrade(trade_id: string): PaperTrade | undefined {
    return this.db.prepare('SELECT * FROM paper_trades WHERE trade_id = ?').get(trade_id) as PaperTrade | undefined;
  }

  getPaperTrades(trader_id: string, limit = 20): PaperTrade[] {
    return this.db
      .prepare('SELECT * FROM paper_trades WHERE trader_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(trader_id, limit) as unknown as PaperTrade[];
  }

  totalFees(trader_id: string): { fee_asset: string; fee_raw: string }[] {
    // Summed as BigInt in JS: fee_raw can exceed SQLite's 64-bit integer
    // range (18-decimal raw values), where SUM(CAST(... AS INTEGER))
    // silently overflows.
    const rows = this.db
      .prepare('SELECT fee_asset, fee_raw FROM fee_ledger WHERE trader_id = ?')
      .all(trader_id) as { fee_asset: string; fee_raw: string }[];
    const sums = new Map<string, bigint>();
    for (const r of rows) {
      sums.set(r.fee_asset, (sums.get(r.fee_asset) ?? 0n) + BigInt(r.fee_raw));
    }
    return [...sums.entries()].map(([fee_asset, fee_raw]) => ({ fee_asset, fee_raw: fee_raw.toString() }));
  }

  // ---- triggers ----

  createTrigger(t: Omit<Trigger, 'trigger_id' | 'created_at' | 'fired_at' | 'active'>): Trigger {
    const trigger_id = `trg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const created_at = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO triggers (trigger_id, trader_id, chain, token_address, symbol, action,
         condition, baseline_price_usd, active, created_at, fired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
      )
      .run(
        trigger_id, t.trader_id, t.chain, t.token_address.toLowerCase(), t.symbol,
        t.action, t.condition, t.baseline_price_usd, created_at,
      );
    return this.getTrigger(trigger_id)!;
  }

  getTrigger(trigger_id: string): Trigger | undefined {
    return this.db.prepare('SELECT * FROM triggers WHERE trigger_id = ?').get(trigger_id) as Trigger | undefined;
  }

  listTriggers(trader_id: string): Trigger[] {
    return this.db
      .prepare('SELECT * FROM triggers WHERE trader_id = ? ORDER BY created_at DESC')
      .all(trader_id) as unknown as Trigger[];
  }

  activeTriggers(): Trigger[] {
    return this.db.prepare('SELECT * FROM triggers WHERE active = 1').all() as unknown as Trigger[];
  }

  fireTrigger(trigger_id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('UPDATE triggers SET active = 0, fired_at = ? WHERE trigger_id = ?')
      .run(now, trigger_id);
  }

  /**
   * Atomic single-claim for the fire path: exactly one poller wins a
   * tripped trigger, even if two checkTriggers runs overlap. Call right
   * before executing; on success follow with markTriggerFired.
   */
  claimTrigger(trigger_id: string): boolean {
    const r = this.db
      .prepare('UPDATE triggers SET active = 0 WHERE trigger_id = ? AND active = 1')
      .run(trigger_id);
    return r.changes > 0;
  }

  markTriggerFired(trigger_id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('UPDATE triggers SET fired_at = ? WHERE trigger_id = ?').run(now, trigger_id);
  }

  cancelTrigger(trigger_id: string, trader_id: string): boolean {
    const r = this.db
      .prepare('UPDATE triggers SET active = 0 WHERE trigger_id = ? AND trader_id = ? AND active = 1')
      .run(trigger_id, trader_id);
    return r.changes > 0;
  }

  // ---- withdrawals (paper records) ----

  recordWithdrawal(w: { trader_id: string; chain: string; symbol: string; amount_raw: string; destination: string; status: string }): string {
    const id = `w_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'INSERT INTO withdrawals (id, trader_id, chain, symbol, amount_raw, destination, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, w.trader_id, w.chain, w.symbol, w.amount_raw, w.destination, w.status, now);
    return id;
  }
}
