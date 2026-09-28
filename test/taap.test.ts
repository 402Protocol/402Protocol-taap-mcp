/**
 * TaaP paper MCP tests.
 *
 *   npx tsx test/taap.test.ts
 *
 * Drives the MCP server in-process via InMemoryTransport with a stubbed
 * fetch (no real network): DexScreener + GoPlus + Kyber responses are
 * canned. Keys: none needed — paper mode has no signing paths at all.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTaapServer, parseHumanAmount, formatRawAmount, STABLES } from '../src/server.js';
import { TaapDb } from '../src/db.js';
import { applyFee, applyFeeWithMin } from '../src/quotes.js';
import { loadTaapConfig } from '../src/config.js';
import { setTrigger, checkTriggers } from '../src/triggers.js';
import { resolveChain } from '../src/tokens.js';
import { getNetQuote } from '../src/quotes.js';
import type { FetchImpl } from '../src/tokens.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// ---- stubbed network ----

const FOO = '0x1111111111111111111111111111111111111111';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function makeStub(opts: { fooPriceUsd: string; honeypot?: boolean; mintable?: boolean; kyberOut?: string }) {
  const stub: FetchImpl = (async (url: unknown) => {
    const u = String(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (u.includes('dexscreener.com')) {
      return json([
        {
          chainId: 'base',
          dexId: 'uniswap',
          pairAddress: '0xpair',
          baseToken: { address: FOO, name: 'Foo Token', symbol: 'FOO' },
          priceUsd: opts.fooPriceUsd,
          liquidity: { usd: 1200000 },
          volume: { h24: 300000 },
          marketCap: 5000000,
          txns: { h24: { buys: 1200, sells: 900 } },
        },
      ]);
    }
    if (u.includes('gopluslabs.io')) {
      const addr = u.split('contract_addresses=')[1]?.split('&')[0] ?? '';
      return json({
        code: 1,
        result: {
          [addr.toLowerCase()]: {
            is_honeypot: opts.honeypot ? '1' : '0',
            buy_tax: '2',
            sell_tax: '2',
            is_mintable: opts.mintable ? '1' : '0',
            can_take_back_ownership: '0',
            owner_address: '0x0000000000000000000000000000000000000000',
            is_proxy: '0',
            holder_count: '4200',
          },
        },
      });
    }
    if (u.includes('kyberswap.com')) {
      return json({ code: 0, data: { routeSummary: { amountOut: opts.kyberOut ?? '42000', gas: '150000' } } });
    }
    throw new Error(`stub: unhandled url ${u}`);
  }) as unknown as FetchImpl;
  return stub;
}

function textOf(call: unknown): string {
  const c = call as { content: { type: string; text: string }[] };
  return c.content[0].text;
}
function jsonOf(call: unknown): any {
  return JSON.parse(textOf(call));
}

// ---- client harness ----

const db = new TaapDb(':memory:');
const server = createTaapServer({ db, config: { mode: 'paper', dbPath: ':memory:' } });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test-client', version: '0.0.0' });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return jsonOf(res);
}

const realFetch = globalThis.fetch;

await check('fee math is exact: 50 bps on 1,000,000 -> fee 5,000, net 995,000', () => {
  const { net, fee } = applyFee('1000000');
  assert.equal(fee, '5000');
  assert.equal(net, '995000');
});

await check('applyFeeWithMin: bps leg wins on large trades', () => {
  // 200 tokens @ $1, 6 decimals: bps = 1,000,000 raw > $0.50 min = 500,000 raw
  const r = applyFeeWithMin('200000000', { decimalsOut: 6, outputUsdPrice: 1, fallbackUsdPrice: null });
  assert.equal(r.fee, '1000000');
  assert.equal(r.net, '199000000');
  assert.equal(r.min_applied, false);
});

await check('applyFeeWithMin: min leg wins on small trades', () => {
  // 1 token @ $1, 6 decimals: bps = 5,000 raw < $0.50 min = 500,000 raw
  const r = applyFeeWithMin('1000000', { decimalsOut: 6, outputUsdPrice: 1, fallbackUsdPrice: null });
  assert.equal(r.fee, '500000');
  assert.equal(r.net, '500000');
  assert.equal(r.min_applied, true);
});

await check('applyFeeWithMin: min rounds up, never undercharges', () => {
  // $0.50 @ $3/token, 6 decimals = 166666.66... -> 166667 raw
  const r = applyFeeWithMin('10000000', { decimalsOut: 6, outputUsdPrice: 3, fallbackUsdPrice: null });
  assert.equal(r.fee, '166667');
  assert.equal(r.min_applied, true);
  assert.ok(((166667 * 3) / 1e6) >= 0.5, 'rounded-up min must cover $0.50');
});

await check('applyFeeWithMin: falls back to input-leg valuation', () => {
  // output unpriceable, input leg says $2/token: min = 0.5/2 x 1e6 = 250,000 raw
  const r = applyFeeWithMin('1000000', { decimalsOut: 6, outputUsdPrice: null, fallbackUsdPrice: 2 });
  assert.equal(r.fee, '250000');
  assert.equal(r.min_applied, true);
});

await check('applyFeeWithMin: dust trade throws QUOTE_TOO_SMALL', () => {
  // 0.1 token @ $1 = $0.10 of output < $0.50 min
  assert.throws(
    () => applyFeeWithMin('100000', { decimalsOut: 6, outputUsdPrice: 1, fallbackUsdPrice: null }),
    /QUOTE_TOO_SMALL/,
  );
});

await check('applyFeeWithMin: fee consuming the whole output throws', () => {
  // exactly $0.50 of output: min == gross -> net 0
  assert.throws(
    () => applyFeeWithMin('500000', { decimalsOut: 6, outputUsdPrice: 1, fallbackUsdPrice: null }),
    /QUOTE_TOO_SMALL/,
  );
});

await check('applyFeeWithMin: unpriceable on both legs throws QUOTE_UNPRICEABLE', () => {
  assert.throws(
    () => applyFeeWithMin('1000000', { decimalsOut: 6, outputUsdPrice: null, fallbackUsdPrice: null }),
    /QUOTE_UNPRICEABLE/,
  );
});

await check('amount parse/format round-trips', () => {
  assert.equal(parseHumanAmount('1.50', 6), '1500000');
  assert.equal(formatRawAmount('1500000', 6), '1.5');
  assert.equal(formatRawAmount('995000', 6), '0.995');
});

await check('get_started provisions a trader and returns the guide', async () => {
  const r = await tool('get_started', {});
  assert.equal(r.ok, true);
  assert.ok(r.trader_id.startsWith('paper_'));
  assert.ok(r.guide.includes('Trading as a Prompt'));
  assert.equal(r.fee_bps, 50);
  (globalThis as any).__trader = r.trader_id;
});

await check('paper_faucet credits play USDC; balance shows it', async () => {
  const trader_id = (globalThis as any).__trader;
  const r = await tool('paper_faucet', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  assert.equal(r.ok, true);
  assert.equal(r.new_balance, '1000');
  const b = await tool('balance', { trader_id });
  assert.equal(b.balances[0].amount, '1000');
});

await check('full paper loop: quote -> execute -> status -> fee ledger', async () => {
  const trader_id = (globalThis as any).__trader;
  // 80 FOO @ $2.50 = $200 gross: 50 bps = $1.00 beats the $0.50 min
  globalThis.fetch = makeStub({ fooPriceUsd: '2.50', kyberOut: '80000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base',
      token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO',
      decimals_in: 6, decimals_out: 18, amount: '100',
    });
    assert.equal(q.ok, true);
    assert.equal(q.venue, 'kyberswap');
    assert.equal(q.amount_out_gross_raw, '80000000000000000000');
    // bps leg: 80e18 * 50 / 10000 = 4e17 fee, 7.96e19 net; min ($0.50 = 2e17) loses
    assert.equal(q.fee_raw, '400000000000000000');
    assert.equal(q.amount_out_net_raw, '79600000000000000000');
    assert.equal(q.min_fee_applied, false);

    const x = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
    assert.equal(x.ok, true);
    assert.equal(x.status, 'SUCCESS');
    assert.ok(x.paper_ref.startsWith('paper:'));
    assert.ok(!x.paper_ref.startsWith('0x'), 'paper ref must never look like a tx hash');

    const s = await tool('swap_status', { trade_id: x.trade_id });
    assert.equal(s.status, 'SUCCESS');

    const b = await tool('balance', { trader_id });
    const usdc = b.balances.find((x: any) => x.symbol === 'USDC');
    const foo = b.balances.find((x: any) => x.symbol === 'FOO');
    assert.equal(usdc.amount_raw, '900000000'); // 1000 - 100, 6 decimals
    assert.equal(foo.amount_raw, '79600000000000000000'); // net of fee
    assert.equal(String(b.fees_accrued[0].fee_raw), '400000000000000000'); // exactly 50 bps in the ledger
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('swap_execute requires user_approved=true', async () => {
  const trader_id = (globalThis as any).__trader;
  globalThis.fetch = makeStub({ fooPriceUsd: '2.50', kyberOut: '80000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '10',
    });
    const x = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: false });
    assert.equal(x.ok, false);
    assert.match(x.detail, /user_approved/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('kill switch: pause blocks fills, resume lifts it', async () => {
  const trader_id = (globalThis as any).__trader;
  globalThis.fetch = makeStub({ fooPriceUsd: '2.50', kyberOut: '80000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '10',
    });
    const p = await tool('pause_trading', { trader_id });
    assert.equal(p.paused, true);
    try {
      const blocked = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
      assert.equal(blocked.ok, false);
      assert.match(blocked.detail, /trading_paused/);
    } finally {
      // Always lift the kill switch — a failed assert here must not cascade
      // into later tests with a stuck-paused trader.
      await tool('resume_trading', { trader_id });
    }
    const r = await tool('balance', { trader_id });
    assert.equal(r.ok, true); // sanity: trader usable again
    const x = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
    assert.equal(x.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('expired quotes cannot execute', async () => {
  const trader_id = (globalThis as any).__trader;
  const stale = db.saveQuote({
    trader_id, venue: 'kyberswap', chain: 'base',
    token_in: USDC_BASE, token_out: FOO, symbol_in: 'USDC', symbol_out: 'FOO',
    decimals_in: 6, decimals_out: 18, amount_in_raw: '1000000',
    amount_out_gross_raw: '42000', amount_out_net_raw: '41790', fee_raw: '210',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  });
  const x = await tool('swap_execute', { trader_id, quote_id: stale.quote_id, user_approved: true });
  assert.equal(x.ok, false);
  assert.match(x.detail, /quote_expired/);
});

await check('execution-time gate blocks honeypots that turned after quoting', async () => {
  const trader_id = (globalThis as any).__trader;
  // Quote while clean…
  globalThis.fetch = makeStub({ fooPriceUsd: '2.50', kyberOut: '80000000000000000000' }) as unknown as typeof fetch;
  let quote_id: string;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '10',
    });
    quote_id = q.quote_id;
  } finally {
    globalThis.fetch = realFetch;
  }
  // …execute after it turned malicious.
  globalThis.fetch = makeStub({ fooPriceUsd: '0.00239', honeypot: true }) as unknown as typeof fetch;
  try {
    const x = await tool('swap_execute', { trader_id, quote_id: quote_id!, user_approved: true });
    assert.equal(x.ok, false);
    assert.match(x.detail, /honeypot/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('token_resolve reports BLOCKED on honeypot, never "looks safe"', async () => {
  globalThis.fetch = makeStub({ fooPriceUsd: '1', honeypot: true }) as unknown as typeof fetch;
  try {
    const r = await tool('token_resolve', { contract_address: FOO, chain: 'base' });
    assert.equal(r.ok, true);
    assert.equal(r.safety.verdict, 'BLOCKED');
    assert.ok(r.safety.red_flags.some((f: string) => /honeypot/i.test(f)));
    const allText = JSON.stringify(r).toLowerCase();
    assert.ok(!allText.includes('looks safe'), 'must never say "looks safe"');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('withdraw needs explicit read-back confirmation', async () => {
  const trader_id = (globalThis as any).__trader;
  const unconfirmed = await tool('withdraw', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC',
    amount: '100', destination: '0x2222222222222222222222222222222222222222', confirmed: false,
  });
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.error, /explicit approval/);
  const w = await tool('withdraw', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC',
    amount: '100', destination: '0x2222222222222222222222222222222222222222', confirmed: true,
  });
  assert.equal(w.ok, true);
  assert.equal(w.status, 'PAPER_RECORDED');
  const b = await tool('balance', { trader_id });
  const usdc = b.balances.find((x: any) => x.symbol === 'USDC');
  assert.equal(usdc.amount_raw, '790000000'); // 1000 - 100 - 10 - 100, 6 decimals
});

await check('trigger arms at live baseline and fires once when it doubles', async () => {
  // Fresh trader: earlier tests left FOO dust on the shared trader.
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  await tool('paper_faucet', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  // Give the trader some FOO to sell.
  db.adjustBalance(trader_id, 'base', FOO, 'FOO', 18, 1000n * 10n ** 18n);
  const stub1 = makeStub({ fooPriceUsd: '1.00', kyberOut: '2000000' });
  const trg = await setTrigger(db, {
    trader_id, chain: 'base', token_address: FOO,
    action: { type: 'sell_pct', pct: 50, stable_token: USDC_BASE, stable_symbol: 'USDC', stable_decimals: 6 },
    condition: { type: 'price_up_pct', pct: 100 },
    fetchImpl: stub1,
  });
  assert.equal(trg.baseline_price_usd, 1);

  // Below target: no fire.
  const stubLow = makeStub({ fooPriceUsd: '1.50', kyberOut: '2000000' });
  const r1 = await checkTriggers(db, { fetchImpl: stubLow });
  assert.equal(r1[0].fired, false);

  // Doubled: fires once, sells half.
  const stubHigh = makeStub({ fooPriceUsd: '2.10', kyberOut: '2000000' });
  const r2 = await checkTriggers(db, { fetchImpl: stubHigh });
  assert.equal(r2[0].fired, true);
  assert.ok(r2[0].trade_id);
  const foo = db.getBalance(trader_id, 'base', FOO)!;
  assert.equal(foo.amount_raw, (500n * 10n ** 18n).toString()); // half sold
  // Second poll: already fired, stays quiet.
  const r3 = await checkTriggers(db, { fetchImpl: stubHigh });
  assert.equal(r3.length, 0);
});

await check('set_auto_approve stores the threshold', async () => {
  const trader_id = (globalThis as any).__trader;
  const r = await tool('set_auto_approve', { trader_id, threshold_usd: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.auto_approve_threshold_usd, 200);
});

await check('live mode without Turnkey refuses to configure', () => {
  assert.throws(() => loadTaapConfig({ TAAP_MODE: 'live' }), /TAAP_TURNKEY_ORG_ID/);
});

await check('live mode with partial Turnkey credential refuses to configure', () => {
  assert.throws(
    () => loadTaapConfig({ TAAP_MODE: 'live', TAAP_TURNKEY_ORG_ID: 'o' }),
    /TAAP_TURNKEY_API_PUBLIC_KEY/,
  );
});

await check('TAAP_TURNKEY_API_KEY works as deprecated private-key alias', () => {
  const cfg = loadTaapConfig({
    TAAP_MODE: 'live',
    TAAP_TURNKEY_ORG_ID: 'o',
    TAAP_TURNKEY_API_PUBLIC_KEY: 'ab'.repeat(33),
    TAAP_TURNKEY_API_KEY: 'cd'.repeat(32),
  });
  assert.equal(cfg.turnkeyApiPrivateKey, 'cd'.repeat(32));
});

await check('paper mode has no signer tools', async () => {
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  assert.ok(!names.includes('signer_status'), 'paper must not expose signer_status');
  assert.ok(!names.includes('signer_sign_transaction'), 'paper must not expose signer_sign_transaction');
});

await check('live mode with full Turnkey credential starts and exposes signer_status', async () => {
  const liveDb = new TaapDb(':memory:');
  const liveServer = createTaapServer({
    db: liveDb,
    config: {
      mode: 'live',
      dbPath: ':memory:',
      turnkeyOrgId: 'org-test',
      turnkeyApiPublicKey: 'ab'.repeat(33),
      turnkeyApiPrivateKey: 'cd'.repeat(32),
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const liveClient = new Client({ name: 'live-test-client', version: '0.0.0' });
  await Promise.all([liveClient.connect(ct), liveServer.connect(st)]);
  const res = await liveClient.callTool({ name: 'signer_status', arguments: {} });
  const body = jsonOf(res);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'live');
  assert.deepEqual(body.signable_chain_ids, [1, 57073, 4663]);
  assert.match(body.key_fingerprint, /^abababab/);
  assert.ok(!JSON.stringify(body).includes('cdcdcd'), 'private key must never appear in tool output');
  (globalThis as any).__liveClient = liveClient;
});

await check('signer_sign_transaction refuses without explicit approval', async () => {
  const liveClient = (globalThis as any).__liveClient as Client;
  const res = await liveClient.callTool({
    name: 'signer_sign_transaction',
    arguments: {
      wallet_account: '0x1111111111111111111111111111111111111111',
      rpc_url: 'https://rpc-gel.inkonchain.com',
      chain_id: 57073,
      nonce: '0x0',
      max_fee_per_gas: '0x1',
      max_priority_fee_per_gas: '0x1',
      gas: '0x5208',
      to: '0x2222222222222222222222222222222222222222',
      value: '0x0',
      data: '0x',
      user_approved: false,
    },
  });
  const body = jsonOf(res);
  assert.equal(body.ok, false);
  assert.match(body.error, /explicit approval/);
});

await check('swap_execute refuses in live mode (Phase 3)', async () => {
  const liveClient = (globalThis as any).__liveClient as Client;
  const res = await liveClient.callTool({
    name: 'swap_execute',
    arguments: { trader_id: 'x', quote_id: 'y', user_approved: true },
  });
  const body = jsonOf(res);
  assert.equal(body.ok, false);
  assert.match(body.error, /Phase 3/);
});

await check('unknown trader_id fails closed', async () => {
  const r = await tool('balance', { trader_id: 'paper_nope' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /get_started/);
});

await check('swap_quote refuses dust: trade too small to cover the minimum fee', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  // 1000 raw FOO (18 dec) @ $2.50 = $2.5e-15 of output — the $0.50 min eats it entirely
  globalThis.fetch = makeStub({ fooPriceUsd: '2.50', kyberOut: '1000' }) as unknown as FetchImpl;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '10',
    });
    assert.equal(q.ok, false);
    assert.match(q.detail, /QUOTE_TOO_SMALL/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('0x v2 venue: price endpoint is hit with the v2 headers, buyAmount parsed, fee applied', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, string> = {};
  const zeroExStub = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    seenUrl = String(url);
    seenHeaders = init?.headers ?? {};
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (String(url).includes('dexscreener.com')) {
      return json([
        {
          chainId: 'ink',
          dexId: 'uniswap',
          pairAddress: '0xpair',
          baseToken: { address: '0x' + '2'.repeat(40), name: 'B Token', symbol: 'B' },
          priceUsd: '3.00',
          liquidity: { usd: 1200000 },
          volume: { h24: 300000 },
          marketCap: 5000000,
          txns: { h24: { buys: 1200, sells: 900 } },
        },
      ]);
    }
    return json({ buyAmount: '5000000', liquidityAvailable: true });
  }) as unknown as FetchImpl;
  const q = await getNetQuote(
    db,
    {
      trader_id: (globalThis as any).__trader,
      chain: 'ink', // no Kyber venue — 0x is the only attempt
      token_in: '0x' + '1'.repeat(40),
      token_out: '0x' + '2'.repeat(40),
      symbol_in: 'A',
      symbol_out: 'B',
      decimals_in: 6,
      decimals_out: 6,
      amount_in_raw: '1000000',
    },
    { fetchImpl: zeroExStub, zeroExApiKey: 'test-key' },
  );
  assert.match(seenUrl, /api\.0x\.org\/swap\/allowance-holder\/price/);
  assert.match(seenUrl, /chainId=57073/);
  assert.equal(seenHeaders['0x-api-key'], 'test-key');
  assert.equal(seenHeaders['0x-version'], 'v2');
  assert.equal(q.venue, '0x');
  assert.equal(q.amount_out_gross_raw, '5000000');
  // $15 gross @ $3/B: $0.50 min = 166667 raw beats 50 bps = 25000 raw
  assert.equal(q.fee_raw, '166667');
  assert.equal(q.amount_out_net_raw, '4833333');
  assert.equal(q.min_fee_applied, true);
});

await check('MVP chain matrix: robinhood resolves with kyber, ink has no kyber venue', async () => {
  const rh = resolveChain('robinhood');
  assert.equal(rh.kyber, 'robinhood');
  assert.equal(rh.gp, '4663');
  const ink = resolveChain('ink');
  assert.equal(ink.kyber, undefined); // Kyber does not serve Ink
  // Ink quotes fail closed with no venues when no 0x key is set.
  // Stub the inspection APIs: the quote-time safety check must not touch
  // the real network here.
  const emptyStub = (async (url: unknown) => {
    const u = String(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (u.includes('dexscreener.com')) return json([]);
    return json({ code: 1, result: {} });
  }) as unknown as FetchImpl;
  await assert.rejects(
    () =>
      getNetQuote(
        db,
        {
          trader_id: (globalThis as any).__trader,
          chain: 'ink',
          token_in: '0x' + '1'.repeat(40),
          token_out: '0x' + '2'.repeat(40),
          symbol_in: 'A',
          symbol_out: 'B',
          decimals_in: 6,
          decimals_out: 6,
          amount_in_raw: '1000000',
        },
        { fetchImpl: emptyStub },
      ),
    /no venues available/,
  );
});

// ---- paper-engine correctness: the adversarial audit fixes ----

await check('quotes are single-use: the same quote_id cannot fill twice', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  await tool('paper_faucet', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  globalThis.fetch = makeStub({ fooPriceUsd: '2.50', kyberOut: '80000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '10',
    });
    assert.equal(q.ok, true);
    const x1 = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
    assert.equal(x1.ok, true);
    const x2 = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
    assert.equal(x2.ok, false);
    assert.match(x2.detail, /already_consumed/);
    // Balance moved exactly once.
    const b = await tool('balance', { trader_id });
    const usdc = b.balances.find((x: any) => x.symbol === 'USDC');
    assert.equal(usdc.amount_raw, '990000000');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('auto-approve: under-threshold green trade fills without explicit approval', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  await tool('paper_faucet', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  await tool('set_auto_approve', { trader_id, threshold_usd: 200 });
  // Stub prices the input at $1: 100 USDC -> $100, under the $200 threshold. FOO is green.
  globalThis.fetch = makeStub({ fooPriceUsd: '1', kyberOut: '100000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '100',
    });
    assert.equal(q.ok, true);
    assert.equal(q.amount_in_usd, 100);
    const x = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: false });
    assert.equal(x.ok, true, JSON.stringify(x));
    assert.equal(x.status, 'SUCCESS');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('auto-approve: over-threshold trade still needs explicit approval', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  await tool('paper_faucet', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  await tool('set_auto_approve', { trader_id, threshold_usd: 50 });
  globalThis.fetch = makeStub({ fooPriceUsd: '1', kyberOut: '100000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '100',
    });
    assert.equal(q.ok, true);
    const x = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: false });
    assert.equal(x.ok, false);
    assert.match(x.detail, /exceeds the auto-approve threshold/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('auto-approve: red flags need explicit approval even under threshold', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  await tool('paper_faucet', {
    trader_id, chain: 'base', token_address: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  await tool('set_auto_approve', { trader_id, threshold_usd: 100000 });
  // Mintable FOO: REVIEW_REQUIRED, not BLOCKED — quotable, but never auto-fillable.
  globalThis.fetch = makeStub({ fooPriceUsd: '1', mintable: true, kyberOut: '100000000000000000000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '100',
    });
    assert.equal(q.ok, true);
    const x = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: false });
    assert.equal(x.ok, false);
    assert.match(x.detail, /red flags need explicit/);
    // Explicit approval (user saw the flags, said yes) still fills the same quote.
    const y = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
    assert.equal(y.ok, true, JSON.stringify(y));
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('swap_quote refuses BLOCKED tokens: no quote, ever', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  globalThis.fetch = makeStub({ fooPriceUsd: '0.00239', honeypot: true, kyberOut: '1000' }) as unknown as typeof fetch;
  try {
    const q = await tool('swap_quote', {
      trader_id, chain: 'base', token_in: USDC_BASE, token_out: FOO,
      symbol_in: 'USDC', symbol_out: 'FOO', decimals_in: 6, decimals_out: 18, amount: '10',
    });
    assert.equal(q.ok, false);
    assert.match(q.detail, /BLOCKED/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('fee ledger stays exact past SQLite 64-bit range', async () => {
  const t = db.createTrader();
  db.adjustBalance(t.trader_id, 'base', USDC_BASE, 'USDC', 6, 10n ** 12n);
  const HUGE = '123456789012345678901234567890'; // ~1.2e29, far past 2^63
  for (let i = 0; i < 2; i++) {
    const q = db.saveQuote({
      trader_id: t.trader_id, venue: 'kyberswap', chain: 'base',
      token_in: USDC_BASE, token_out: FOO, symbol_in: 'USDC', symbol_out: 'FOO',
      decimals_in: 6, decimals_out: 18, amount_in_raw: '1000000',
      amount_out_gross_raw: '1', amount_out_net_raw: '1', fee_raw: HUGE,
      amount_in_usd: 1, expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    db.fillQuoteAtomic({
      quote_id: q.quote_id, trader_id: t.trader_id, venue: 'kyberswap', chain: 'base',
      token_in: USDC_BASE, symbol_in: 'USDC', decimals_in: 6, amount_in_raw: '1000000',
      token_out: FOO, symbol_out: 'FOO', decimals_out: 18, amount_out_net_raw: '1', fee_raw: HUGE,
    });
  }
  const fees = db.totalFees(t.trader_id);
  assert.equal(fees.length, 1);
  assert.equal(fees[0].fee_asset, 'FOO');
  assert.equal(fees[0].fee_raw, (BigInt(HUGE) * 2n).toString());
});

await check('concurrent trigger polls cannot double-fire', async () => {
  const g = await tool('get_started', {});
  const trader_id: string = g.trader_id;
  db.adjustBalance(trader_id, 'base', FOO, 'FOO', 18, 1000n * 10n ** 18n);
  const stubArm = makeStub({ fooPriceUsd: '1.00', kyberOut: '2000000' });
  const trg = await setTrigger(db, {
    trader_id, chain: 'base', token_address: FOO,
    action: { type: 'sell_pct', pct: 50, stable_token: USDC_BASE, stable_symbol: 'USDC', stable_decimals: 6 },
    condition: { type: 'price_up_pct', pct: 100 },
    fetchImpl: stubArm,
  });
  const stubHigh = makeStub({ fooPriceUsd: '2.10', kyberOut: '2000000' });
  const [r1, r2] = await Promise.all([
    checkTriggers(db, { fetchImpl: stubHigh }),
    checkTriggers(db, { fetchImpl: stubHigh }),
  ]);
  const mine = [...r1, ...r2].filter((r) => r.trigger_id === trg.trigger_id);
  const fired = mine.filter((r) => r.fired && r.trade_id);
  assert.equal(fired.length, 1);
  assert.equal(db.getPaperTrades(trader_id).length, 1);
});

await check('native gas token inspects clean — no contract to audit', async () => {
  const r = await tool('token_resolve', {
    contract_address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    chain: 'ethereum',
  });
  assert.equal(r.ok, true);
  assert.equal(r.safety.verdict, 'NO_RED_FLAGS_DETECTED');
  assert.ok(r.safety.checks.some((c: any) => c.name === 'native_asset'));
});

await check('STABLES covers the MVP chains (ink USDC, robinhood USDG)', async () => {
  assert.equal(STABLES.ink.address, '0x2D270e6886d130D724215A266106e6832161EAEd');
  assert.equal(STABLES.ink.symbol, 'USDC');
  assert.equal(STABLES.robinhood.symbol, 'USDG');
  assert.equal(STABLES.robinhood.address, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
});

// ---- wallet provisioning (claim ceremony wiring) ----

function stubClaimServer() {
  const state = { issueCalls: 0, failIssue: false, status: 'issued', backedUp: false, address: null as string | null };
  const stub = (async (url: unknown) => {
    const u = String(url);
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    if (u.endsWith('/api/claim/issue')) {
      state.issueCalls++;
      if (state.failIssue) throw new Error('connection refused');
      return json({ ok: true, claim_url: 'http://localhost:4023/claim/TOK123.456', mode: 'demo' });
    }
    if (u.endsWith('/api/claim/status')) {
      return json({ ok: true, status: state.status, backed_up: state.backedUp, deposit_address: state.address });
    }
    throw new Error('unexpected fetch: ' + u);
  }) as unknown as typeof fetch;
  return { stub, state };
}

await check('provision_wallet mints one link and stores the token on the trader', async () => {
  const { stub, state } = stubClaimServer();
  globalThis.fetch = stub;
  try {
    const r = await tool('provision_wallet', {});
    assert.equal(r.ok, true);
    assert.equal(r.already_provisioned, false);
    assert.equal(r.claim_url, 'http://localhost:4023/claim/TOK123.456');
    assert.equal(r.claim_mode, 'demo');
    const t = db.getTrader(r.trader_id)!;
    assert.equal(t.claim_token, 'TOK123.456');
    assert.equal(state.issueCalls, 1);
    // Second call reuses the link — never mints two wallets.
    const r2 = await tool('provision_wallet', { trader_id: r.trader_id });
    assert.equal(r2.ok, true);
    assert.equal(r2.already_provisioned, true);
    assert.equal(r2.claim_url, r.claim_url);
    assert.equal(state.issueCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('claim_status reports progress, no address before backup', async () => {
  const { stub, state } = stubClaimServer();
  globalThis.fetch = stub;
  try {
    const p = await tool('provision_wallet', {});
    const r = await tool('claim_status', { trader_id: p.trader_id });
    assert.equal(r.ok, true);
    assert.equal(r.wallet_provisioned, true);
    assert.equal(r.ceremony_status, 'issued');
    assert.equal(r.backed_up, false);
    assert.equal(r.deposit_address, null);
    // Human completes the ceremony -> address appears.
    state.status = 'complete';
    state.backedUp = true;
    state.address = '0xAbc0000000000000000000000000000000000001';
    const r2 = await tool('claim_status', { trader_id: p.trader_id });
    assert.equal(r2.backed_up, true);
    assert.equal(r2.deposit_address, '0xAbc0000000000000000000000000000000000001');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('claim_status with no wallet says provision first', async () => {
  const g = await tool('get_started', {});
  const r = await tool('claim_status', { trader_id: g.trader_id });
  assert.equal(r.ok, true);
  assert.equal(r.wallet_provisioned, false);
  assert.match(r.note, /provision_wallet/);
});

await check('provision_wallet fails clean when the claim server is down', async () => {
  const { stub, state } = stubClaimServer();
  state.failIssue = true;
  globalThis.fetch = stub;
  try {
    const r = await tool('provision_wallet', {});
    assert.equal(r.ok, false);
    assert.match(r.detail, /unreachable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} checks passed`);
db.close();
