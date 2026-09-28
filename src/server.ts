/**
 * TaaP MCP server — "Trading as a Prompt", paper mode.
 *
 * One-URL connection. The chat the user already uses becomes the trading
 * terminal: paste a CA, say "buy $100 of this", done.
 *
 * PAPER MODE: simulated fills, play funds, REAL dry quotes (KyberSwap /
 * Jupiter / 0x) and REAL token inspections (DexScreener + GoPlus). There is
 * no signing code path anywhere in paper mode — it cannot move real money
 * by construction.
 *
 * LIVE MODE (Phase 2): the Turnkey signer is wired in. Structured EIP-1559
 * transactions only, allowlisted chains only (ethereum/ink/robinhood), every
 * signature requires explicit user approval, and the Turnkey-side policy is
 * the primary enforcement. Live swap execution (calldata construction) is
 * Phase 3 — the signer primitive here is what it will call.
 *
 * Tool descriptions are documentation: each one reads like a mini-doc
 * (what it does, when to call it, what it returns, what the errors mean).
 * Written for agents first, humans second.
 *
 * Run: npx tsx src/taap/server.ts   (or: npm run taap)
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadTaapConfig, TAAP_FEE_BPS, TAAP_MIN_FEE_USD, type TaapConfig } from './config.js';
import { TaapDb } from './db.js';
import { inspectToken, resolveChain } from './tokens.js';
import { getNetQuote } from './quotes.js';
import { provisionTrader, paperFaucet, executePaperQuote } from './paper.js';
import { TurnkeySigner, SIGNABLE_CHAIN_IDS, type UnsignedEip1559Tx } from './signer.js';
import { setTrigger, checkTriggers } from './triggers.js';
import { GET_STARTED_GUIDE } from './getstarted.js';

/** Well-known stables so agents don't have to look them up. */
export const STABLES: Record<string, { address: string; symbol: string; decimals: number }> = {
  ethereum: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  ink: { address: '0x2D270e6886d130D724215A266106e6832161EAEd', symbol: 'USDC', decimals: 6 },
  robinhood: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  arbitrum: { address: '0xaf88d065e77c8cC2239327C5EDb5A025Eaa4c', symbol: 'USDC', decimals: 6 },
  solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
};

function textResult(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string, detail?: unknown) {
  return textResult({ ok: false, error: message, ...(detail !== undefined ? { detail } : {}) });
}

/** "1.50" + 6 decimals -> "1500000" (raw units). Exact, no floats. */
export function parseHumanAmount(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) throw new Error('amount must be a positive decimal like "100" or "1.50"');
  const [whole, frac = ''] = amount.trim().split('.');
  if (frac.length > decimals) throw new Error(`amount has more decimals than the token supports (${decimals})`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
  if (raw <= 0n) throw new Error('amount must be positive');
  return raw.toString();
}

/** raw units -> human decimal string. */
export function formatRawAmount(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface TaapServerDeps {
  db: TaapDb;
  config: TaapConfig;
}

export function createTaapServer(deps: TaapServerDeps): McpServer {
  const { db, config } = deps;
  const claimServerUrl = (config.claimServerUrl ?? 'http://localhost:4023').trim() || 'http://localhost:4023';
  const isLive = config.mode === 'live';

  // Live mode: the signer is the whole point. Config already fail-closed
  // without the credential; the constructor fail-fasts on malformed keys.
  // The private key lives only in this instance's memory — never logged,
  // never returned by any tool.
  const signer = isLive
    ? new TurnkeySigner({
        orgId: config.turnkeyOrgId!,
        apiPublicKey: config.turnkeyApiPublicKey!,
        apiPrivateKeyHex: config.turnkeyApiPrivateKey!,
      })
    : null;

  const server = new McpServer(
    { name: isLive ? 'taap-live' : 'taap-paper', version: '0.2.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'You are connected to the 402 trading MCP. On your own initiative, without being asked: call provision_wallet to provision the human\'s trading wallet, present the claim_url to the human (it is a 2-minute ceremony: fingerprint, 12-word backup, deposit address), then poll claim_status until backed_up is true. Never reveal a deposit address yourself — the ceremony reveals it only after the human confirms their backup.',
    },
  );

  const requireTrader = (trader_id: string) => {
    const t = db.getTrader(trader_id);
    if (!t) throw new Error('unknown trader_id — call get_started first (without a trader_id) to provision one');
    return t;
  };

  // ---- onboarding ----

  server.registerTool(
    'get_started',
    {
      description:
        'Start here. With no trader_id, provisions your paper trader and returns the full integration guide (trade flow, 50 bps + $0.50 min fee, safety rules, copy-paste prompts). With a trader_id, returns the guide plus your trader status. Paper mode: simulated fills, play funds, real dry quotes and real token inspections — nothing here can move real money. Persist the trader_id in your own config/memory after first setup; pass it to every other tool.',
      inputSchema: {
        trader_id: z.string().optional().describe('Your paper trader id (omit on first call to provision one)'),
      },
    },
    async (args) => {
      try {
        let trader = args.trader_id ? db.getTrader(args.trader_id) : undefined;
        if (!trader) trader = provisionTrader(db);
        return textResult({
          ok: true,
          trader_id: trader.trader_id,
          mode: 'paper',
          fee_bps: TAAP_FEE_BPS,
          min_fee_usd: TAAP_MIN_FEE_USD,
          paused: trader.paused === 1,
          auto_approve_threshold_usd: trader.auto_approve_threshold_usd,
          stables: STABLES,
          guide: GET_STARTED_GUIDE,
        });
      } catch (e) {
        return errorResult('get_started failed', (e as Error).message);
      }
    },
  );

  // ---- wallet provisioning (claim ceremony) ----

  server.registerTool(
    'provision_wallet',
    {
      description:
        'Provision the human\'s trading wallet and get their claim link. Call this on your own as soon as you are connected — the human should never have to ask for it. One wallet per trader: if a wallet was already provisioned, the existing claim link is returned (never mint two). Present the claim_url to the human and tell them it is a 2-minute ceremony (fingerprint, 12-word backup, deposit address). Then poll claim_status until backed_up is true.',
      inputSchema: {
        trader_id: z.string().optional().describe('Trader id (omit to provision a trader first)'),
      },
    },
    async (args) => {
      try {
        let trader = args.trader_id ? db.getTrader(args.trader_id) : undefined;
        if (!trader) trader = provisionTrader(db);
        if (trader.claim_token) {
          return textResult({
            ok: true,
            trader_id: trader.trader_id,
            already_provisioned: true,
            claim_url: `${claimServerUrl}/claim/${trader.claim_token}`,
            note: 'A wallet was already provisioned for this trader — reuse this link, do not mint another.',
          });
        }
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (config.claimAdminKey) headers['x-admin-key'] = config.claimAdminKey;
        let res: Response;
        try {
          res = await fetch(`${claimServerUrl}/api/claim/issue`, { method: 'POST', headers });
        } catch (e) {
          return errorResult(
            'provision_wallet failed',
            `claim server unreachable at ${claimServerUrl} — is it running? (${(e as Error).message})`,
          );
        }
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || body.ok !== true || typeof body.claim_url !== 'string') {
          return errorResult(
            'provision_wallet failed',
            `claim server refused: HTTP ${res.status} ${(body as { error?: string }).error ?? ''}`.trim(),
          );
        }
        const claimUrl = body.claim_url as string;
        const token = claimUrl.split('/claim/')[1] ?? '';
        if (!token) return errorResult('provision_wallet failed', 'claim server returned a malformed claim_url');
        db.setClaimToken(trader.trader_id, token);
        return textResult({
          ok: true,
          trader_id: trader.trader_id,
          already_provisioned: false,
          claim_url: claimUrl,
          claim_mode: body.mode ?? 'unknown',
          note: 'Show this link to the human now. Poll claim_status until backed_up is true — do not reveal a deposit address yourself; the ceremony reveals it only after backup.',
        });
      } catch (e) {
        return errorResult('provision_wallet failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'claim_status',
    {
      description:
        'Check the human\'s claim-ceremony progress for this trader\'s wallet. Poll this after provision_wallet until backed_up is true. The deposit address is included ONLY after the human confirmed their 12-word backup — never invent or reveal an address earlier.',
      inputSchema: {
        trader_id: z.string().describe('Trader id'),
      },
    },
    async (args) => {
      try {
        const trader = requireTrader(args.trader_id);
        if (!trader.claim_token) {
          return textResult({ ok: true, trader_id: trader.trader_id, wallet_provisioned: false,
            note: 'No wallet provisioned yet — call provision_wallet first.' });
        }
        let res: Response;
        try {
          res = await fetch(`${claimServerUrl}/api/claim/status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: trader.claim_token }),
          });
        } catch (e) {
          return errorResult(
            'claim_status failed',
            `claim server unreachable at ${claimServerUrl} — is it running? (${(e as Error).message})`,
          );
        }
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || body.ok !== true) {
          return errorResult(
            'claim_status failed',
            `claim server refused: HTTP ${res.status} ${(body as { error?: string }).error ?? ''}`.trim(),
          );
        }
        return textResult({
          ok: true,
          trader_id: trader.trader_id,
          wallet_provisioned: true,
          ceremony_status: body.status,
          backed_up: body.backed_up === true,
          deposit_address: body.deposit_address ?? null,
        });
      } catch (e) {
        return errorResult('claim_status failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'paper_faucet',
    {
      description:
        'Credit your paper trader with PLAY funds (the sandbox faucet). Paper mode only — these funds are simulated and worthless. This is the "deposit is the signup" step for paper: fund the trader, then trade. In live mode this tool does not exist; funding is a real onchain deposit to your Turnkey wallet.',
      inputSchema: {
        trader_id: z.string(),
        chain: z.string().default('base').describe('Chain: ethereum, base, arbitrum, bsc, ink, solana'),
        token_address: z.string().describe('Token contract address (or mint on Solana)'),
        symbol: z.string().describe('Token symbol, e.g. USDC'),
        decimals: z.number().int().min(0).max(36).describe('Token decimals, e.g. 6 for USDC'),
        amount: z.string().describe('Human decimal amount, e.g. "1000"'),
      },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        const next = paperFaucet(db, args.trader_id, args.chain, args.token_address, args.symbol, args.decimals, args.amount);
        return textResult({
          ok: true,
          trader_id: args.trader_id,
          credited: `${args.amount} ${args.symbol}`,
          new_balance_raw: next,
          new_balance: formatRawAmount(next, args.decimals),
          note: 'Play funds — simulated, worthless, for testing the full loop.',
        });
      } catch (e) {
        return errorResult('paper_faucet failed', (e as Error).message);
      }
    },
  );

  // ---- inspection ----

  server.registerTool(
    'token_resolve',
    {
      description:
        'Inspect a token BEFORE any trade talk: paste the contract address (CA), get red flags + facts. Checks: honeypot (buy AND sell simulation), buy/sell tax, mintable supply, ownership/proxy status, holder count, price, liquidity, 24h volume, market cap. Verdicts: BLOCKED (honeypot — no quote, no fill, ever), REVIEW_REQUIRED (red flags — user must approve explicitly regardless of size), NO_RED_FLAGS_DETECTED. The agent NEVER says "looks safe" — report the checks and the numbers, then ask the user what they want to do. Call this first, every time, before swap_quote.',
      inputSchema: {
        contract_address: z.string().describe('Token contract address (0x… on EVM, mint address on Solana)'),
        chain: z.string().optional().describe('Chain (default ethereum). ethereum, base, arbitrum, bsc, ink, solana.'),
      },
    },
    async (args) => {
      try {
        return textResult(await inspectToken(args.contract_address, args.chain));
      } catch (e) {
        return errorResult('token_resolve failed', (e as Error).message);
      }
    },
  );

  // ---- quoting ----

  server.registerTool(
    'swap_quote',
    {
      description:
        'Dry quote for a swap: real venue quotes (KyberSwap/Jupiter/0x), best net-of-fee fill wins. The 402 fee — max(50 bps, $0.50 minimum, the min is a placeholder until the Turnkey bill calibrates it) — is applied AT THE QUOTE LAYER — the response shows amount_out_gross, fee, and amount_out_net separately, and amount_out_net is what a fill would deliver. BLOCKED (honeypot) tokens get no quote, ever — the token being bought is inspected before quoting. amount_in_usd is the server-side USD valuation the auto-approve threshold is enforced against. Quotes live 60 seconds and fill at most once; swap_execute rejects stale or consumed quotes. No signing, no broadcasting — quoting is always safe. For ETH use token 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE on EVM.',
      inputSchema: {
        trader_id: z.string(),
        chain: z.string().describe('Chain: ethereum, base, arbitrum, bsc, solana, ink, robinhood (ink quotes via 0x when ZEROEX_API_KEY is set)'),
        token_in: z.string().describe('Input token address'),
        token_out: z.string().describe('Output token address'),
        symbol_in: z.string().describe('Input symbol, e.g. USDC'),
        symbol_out: z.string().describe('Output symbol, e.g. WETH'),
        decimals_in: z.number().int().min(0).max(36),
        decimals_out: z.number().int().min(0).max(36),
        amount: z.string().describe('Human decimal input amount, e.g. "100"'),
      },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        const quote = await getNetQuote(
          db,
          {
            trader_id: args.trader_id,
            chain: args.chain,
            token_in: args.token_in,
            token_out: args.token_out,
            symbol_in: args.symbol_in,
            symbol_out: args.symbol_out,
            decimals_in: args.decimals_in,
            decimals_out: args.decimals_out,
            amount_in_raw: parseHumanAmount(args.amount, args.decimals_in),
          },
          { zeroExApiKey: config.zeroExApiKey },
        );
        return textResult({
          ok: true,
          ...quote,
          amount_in: formatRawAmount(quote.amount_in_raw, quote.decimals_in),
          amount_out_gross: formatRawAmount(quote.amount_out_gross_raw, quote.decimals_out),
          amount_out_net: formatRawAmount(quote.amount_out_net_raw, quote.decimals_out),
          fee: formatRawAmount(quote.fee_raw, quote.decimals_out),
          note: 'Dry quote — nothing moved. Pass quote_id to swap_execute within 60 seconds.',
        });
      } catch (e) {
        return errorResult('swap_quote failed', (e as Error).message);
      }
    },
  );

  // ---- execution (paper) ----

  server.registerTool(
    'swap_execute',
    {
      description:
        'Execute a swap_quote (PAPER FILL in paper mode — simulated at the quoted net price, never real money). LIVE MODE: swap execution is not wired yet (Phase 3) — the signer is ready (see signer_status / signer_sign_transaction) but swap calldata construction comes next; swap_execute refuses in live mode. Approval, enforced server-side: pass user_approved=true when the user explicitly approved this trade, OR leave it false and let auto-approve decide — that path only fills when the trader set a threshold via set_auto_approve, the trade\'s server-side USD value is known and at/under it, and the execution-time inspection is fully green. Red flags always need an explicit yes regardless of size; honeypots never fill. Execution-time safety: the token being bought is re-inspected NOW (honeypot turned on between quote and fill = blocked). Each quote fills at most once; the fill is atomic (balances + trade + fee records move together). Fails if the kill switch is engaged or the quote expired. Returns a paper: reference — paper fills are never confused with real tx hashes.',
      inputSchema: {
        trader_id: z.string(),
        quote_id: z.string().describe('Fresh quote_id from swap_quote (60s lifetime)'),
        user_approved: z.boolean().describe('True only if the user approved this trade or it is under their auto-approve threshold with green safety'),
      },
    },
    async (args) => {
      try {
        if (isLive) {
          return errorResult(
            'live swap execution is not wired yet (Phase 3)',
            'The Turnkey signer is ready — see signer_status and signer_sign_transaction — but swap calldata construction comes next. No trade was executed.',
          );
        }
        const fill = await executePaperQuote(db, args.trader_id, args.quote_id, {
          user_approved: args.user_approved,
        });
        const quote = db.getQuote(args.quote_id)!;
        return textResult({
          ok: true,
          mode: 'paper',
          ...fill,
          amount_in: formatRawAmount(fill.amount_in_raw, quote.decimals_in),
          amount_out: formatRawAmount(fill.amount_out_raw, quote.decimals_out),
          fee: formatRawAmount(fill.fee_raw, quote.decimals_out),
          note: 'PAPER FILL — simulated. No real tokens moved.',
        });
      } catch (e) {
        return errorResult('swap_execute failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'swap_status',
    {
      description:
        'Check a fill by trade_id: status, amounts, fee, venue, and reference. Paper fills carry a paper: reference, never a real transaction hash.',
      inputSchema: { trade_id: z.string() },
    },
    async (args) => {
      try {
        const t = db.getPaperTrade(args.trade_id);
        if (!t) return errorResult('unknown trade_id');
        return textResult({ ok: true, ...t });
      } catch (e) {
        return errorResult('swap_status failed', (e as Error).message);
      }
    },
  );

  // ---- live signer (Phase 2; live mode only) ----

  if (isLive && signer) {
    const liveSigner: TurnkeySigner = signer;
    server.registerTool(
      'signer_status',
      {
        description:
          'Check the live Turnkey signer: mode, org, key fingerprint (truncated public key — the private key is never exposed), and the allowlisted chain IDs. Read-only, no network calls, safe to call any time.',
        inputSchema: {},
      },
      async () => {
        try {
          return textResult({
            ok: true,
            mode: 'live',
            org_id: liveSigner.orgId,
            key_fingerprint: liveSigner.keyFingerprint,
            signable_chain_ids: [...SIGNABLE_CHAIN_IDS],
            note: 'Signer ready. Every signature requires explicit user approval (signer_sign_transaction) and is policy-enforced by Turnkey.',
          });
        } catch (e) {
          return errorResult('signer_status failed', (e as Error).message);
        }
      },
    );

    const txField = (name: string) =>
      z.string().regex(/^0x[0-9a-fA-F]*$/, `${name} must be 0x hex`).describe(name);

    server.registerTool(
      'signer_sign_transaction',
      {
        description:
          'Sign a structured EIP-1559 transaction with the Turnkey credential and broadcast it. ALWAYS requires explicit per-action approval: pass user_approved=true only after reading the FULL transaction (chain, to, value, data) back to the user and getting a yes — there is no auto-approve path for signing, ever. Guards, enforced server-side before Turnkey is even asked: chain_id must be one of the allowlisted chains (1 ethereum, 57073 ink, 4663 robinhood); only structured transactions — there is no raw-payload signing path anywhere. The Turnkey-side policy on the credential is the primary enforcement. Returns the tx hash on success.',
        inputSchema: {
          wallet_account: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address').describe('Turnkey wallet account to sign with'),
          rpc_url: z.string().url().describe('JSON-RPC endpoint for nonce lookup and broadcast'),
          chain_id: z.number().int().describe('EIP-155 chain id — must be allowlisted'),
          nonce: txField('nonce'),
          max_fee_per_gas: txField('max_fee_per_gas'),
          max_priority_fee_per_gas: txField('max_priority_fee_per_gas'),
          gas: txField('gas'),
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address'),
          value: txField('value'),
          data: txField('data (calldata, 0x when empty)'),
          user_approved: z.boolean().describe('True ONLY after the user explicitly approved this exact transaction'),
        },
      },
      async (args) => {
        try {
          if (!args.user_approved) {
            return errorResult(
              'signing needs explicit approval',
              'Read the full transaction back to the user (chain, to, value, data) and call again with user_approved=true only after a yes. Signing never auto-approves.',
            );
          }
          const tx: UnsignedEip1559Tx = {
            chainId: args.chain_id,
            nonce: args.nonce,
            maxFeePerGas: args.max_fee_per_gas,
            maxPriorityFeePerGas: args.max_priority_fee_per_gas,
            gas: args.gas,
            to: args.to,
            value: args.value,
            data: args.data,
          };
          const { txHash } = await liveSigner.signAndBroadcast(args.wallet_account, args.rpc_url, tx);
          return textResult({ ok: true, mode: 'live', tx_hash: txHash, chain_id: args.chain_id });
        } catch (e) {
          return errorResult('signer_sign_transaction failed', (e as Error).message);
        }
      },
    );
  }

  // ---- portfolio ----

  server.registerTool(
    'balance',
    {
      description:
        'The chat-native portfolio view: every paper balance for the trader (symbol, amount, chain), recent fills, and total 402 fees accrued in the paper fee ledger. Use it to answer "what do I hold?" and "what have I paid in fees?".',
      inputSchema: { trader_id: z.string() },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        const balances = db.getBalances(args.trader_id).map((b) => ({
          ...b,
          amount: formatRawAmount(b.amount_raw, b.decimals),
        }));
        const trades = db.getPaperTrades(args.trader_id, 10);
        const fees = db.totalFees(args.trader_id);
        return textResult({ ok: true, mode: 'paper', balances, recent_trades: trades, fees_accrued: fees });
      } catch (e) {
        return errorResult('balance failed', (e as Error).message);
      }
    },
  );

  // ---- withdrawals (paper records) ----

  server.registerTool(
    'withdraw',
    {
      description:
        'Withdraw to an external wallet. ALWAYS requires explicit per-action approval: pass confirmed=true only after reading the amount AND destination back to the user and getting a yes — the server records the read-back values. Paper mode: records the withdrawal and debits the paper balance; status PAPER_RECORDED, no real movement. Live mode (Phase 2): Turnkey policy enforces withdrawals to the owner\'s pre-registered wallet only. Never auto-executes.',
      inputSchema: {
        trader_id: z.string(),
        chain: z.string(),
        token_address: z.string(),
        symbol: z.string(),
        amount: z.string().describe('Human decimal amount'),
        destination: z.string().describe('Destination address — read this back to the user before confirming'),
        confirmed: z.boolean().describe('True only after the user explicitly confirmed amount + destination'),
      },
    },
    async (args) => {
      try {
        const trader = requireTrader(args.trader_id);
        if (!args.confirmed) {
          return errorResult(
            'withdrawal needs explicit approval',
            `Read back to the user: "send ${args.amount} ${args.symbol} to ${args.destination}?" — then call again with confirmed=true.`,
          );
        }
        const { name: chain } = resolveChain(args.chain);
        const bal = db.getBalance(args.trader_id, chain, args.token_address);
        if (!bal) throw new Error(`no paper ${args.symbol} balance`);
        const raw = parseHumanAmount(args.amount, bal.decimals);
        if (BigInt(bal.amount_raw) < BigInt(raw)) throw new Error('insufficient paper balance');
        db.adjustBalance(args.trader_id, chain, args.token_address, args.symbol, bal.decimals, -BigInt(raw));
        const id = db.recordWithdrawal({
          trader_id: args.trader_id,
          chain,
          symbol: args.symbol,
          amount_raw: raw,
          destination: args.destination,
          status: 'PAPER_RECORDED',
        });
        void trader;
        return textResult({
          ok: true,
          withdrawal_id: id,
          status: 'PAPER_RECORDED',
          note: 'Paper withdrawal recorded and paper balance debited. No real movement — live withdrawals require Turnkey (owner wallet only) + explicit approval.',
        });
      } catch (e) {
        return errorResult('withdraw failed', (e as Error).message);
      }
    },
  );

  // ---- standing strategies ----

  server.registerTool(
    'set_trigger',
    {
      description:
        'Arm a standing strategy in plain language: "sell half my FUG if it doubles" = sell_pct 50, price_up_pct 100. The live price right now becomes the baseline; the trigger fires ONCE when the price rises by price_up_pct, selling sell_pct of the token balance into the stable. Firing executes within the trigger\'s own caps under the user\'s standing approval from this call. Red-flagged (BLOCKED) tokens cannot be armed.',
      inputSchema: {
        trader_id: z.string(),
        chain: z.string(),
        token_address: z.string().describe('Token to watch/sell'),
        sell_pct: z.number().min(1).max(100).describe('Percent of balance to sell when it fires, e.g. 50 = sell half'),
        price_up_pct: z.number().positive().describe('Rise from current price that fires it, e.g. 100 = doubles'),
        stable_token: z.string().describe('Stable to sell into (see STABLES in get_started)'),
        stable_symbol: z.string().default('USDC'),
        stable_decimals: z.number().int().default(6),
      },
    },
    async (args) => {
      try {
        const trg = await setTrigger(db, {
          trader_id: args.trader_id,
          chain: args.chain,
          token_address: args.token_address,
          action: { type: 'sell_pct', pct: args.sell_pct, stable_token: args.stable_token, stable_symbol: args.stable_symbol, stable_decimals: args.stable_decimals },
          condition: { type: 'price_up_pct', pct: args.price_up_pct },
        });
        return textResult({
          ok: true,
          trigger_id: trg.trigger_id,
          symbol: trg.symbol,
          baseline_price_usd: trg.baseline_price_usd,
          fires_when_usd: trg.baseline_price_usd * (1 + args.price_up_pct / 100),
          note: 'Armed. check_triggers polls it (wire to a cron in production). Fires once.',
        });
      } catch (e) {
        return errorResult('set_trigger failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'list_triggers',
    {
      description: 'List all triggers for a trader: armed and fired, with baselines and fire times.',
      inputSchema: { trader_id: z.string() },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        return textResult({ ok: true, triggers: db.listTriggers(args.trader_id) });
      } catch (e) {
        return errorResult('list_triggers failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'cancel_trigger',
    {
      description: 'Disarm a trigger by trigger_id. Only the owning trader can cancel it.',
      inputSchema: { trader_id: z.string(), trigger_id: z.string() },
    },
    async (args) => {
      try {
        const cancelled = db.cancelTrigger(args.trigger_id, args.trader_id);
        return textResult({ ok: true, cancelled });
      } catch (e) {
        return errorResult('cancel_trigger failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'check_triggers',
    {
      description:
        'Poll every armed trigger once against live prices and fire the tripped ones (paper fills within their caps). In production this runs on a cron; the tool exists so agents and tests can drive it directly. Returns one report per trigger checked.',
      inputSchema: {},
    },
    async () => {
      try {
        return textResult({ ok: true, reports: await checkTriggers(db, { zeroExApiKey: config.zeroExApiKey }) });
      } catch (e) {
        return errorResult('check_triggers failed', (e as Error).message);
      }
    },
  );

  // ---- kill switch & mandate ----

  server.registerTool(
    'pause_trading',
    {
      description:
        'KILL SWITCH. Stops everything immediately: fills, trigger arming, and trigger firing all fail while paused. No confirmation needed to stop — stopping is always safe. Call the moment anything looks wrong: "stop everything" / "pause trading".',
      inputSchema: { trader_id: z.string() },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        db.setPaused(args.trader_id, true);
        return textResult({ ok: true, paused: true, note: 'Trading halted. resume_trading lifts it.' });
      } catch (e) {
        return errorResult('pause_trading failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'resume_trading',
    {
      description: 'Lift the kill switch after pause_trading. Trading, trigger arming, and firing resume.',
      inputSchema: { trader_id: z.string() },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        db.setPaused(args.trader_id, false);
        return textResult({ ok: true, paused: false });
      } catch (e) {
        return errorResult('resume_trading failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'set_auto_approve',
    {
      description:
        'Set the per-trade auto-approve threshold in USD for this trader (default 0 = always ask). Trades at or under the threshold with green safety auto-execute once the user\'s standing approval exists; anything over it — or any red flag regardless of size — needs an explicit yes per trade. No maximum: set it as high as the user wants. The server enforces the threshold itself; the agent cannot talk its way around it.',
      inputSchema: {
        trader_id: z.string(),
        threshold_usd: z.number().min(0).describe('Auto-approve threshold in USD, e.g. 200. 0 = always ask.'),
      },
    },
    async (args) => {
      try {
        requireTrader(args.trader_id);
        db.setAutoApproveThreshold(args.trader_id, args.threshold_usd);
        return textResult({ ok: true, auto_approve_threshold_usd: args.threshold_usd });
      } catch (e) {
        return errorResult('set_auto_approve failed', (e as Error).message);
      }
    },
  );

  return server;
}

// ---- stdio entrypoint ----

async function main(): Promise<void> {
  const config = loadTaapConfig();
  const db = new TaapDb(config.dbPath);
  const server = createTaapServer({ db, config });
  const transport = new StdioServerTransport();
  // Never log to stdout: it corrupts the MCP stdio protocol. stderr only.
  console.error(`[taap] paper mode serving over stdio (db=${config.dbPath})`);
  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[taap] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
