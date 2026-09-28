/**
 * get_started guide — the integration doc the MCP returns as markdown.
 * Per the spec: the fastest onboarding is a sentence you can paste.
 */
export const GET_STARTED_GUIDE = `# TaaP — Trading as a Prompt (paper mode)

You are connected to the 402 swap MCP. Paper mode: simulated fills, play
funds, REAL dry quotes and REAL token inspections. Nothing here can move
real money — there is no signing code path in paper mode at all.

## The loop (four calls)

1. \`paper_faucet\` — credit yourself play USDC (the sandbox faucet).
2. \`token_resolve\` — paste a contract address, get red flags + facts FIRST.
3. \`swap_quote\` — dry quote, net of the 402 fee (50 bps + $0.50 minimum). Quotes live 60s.
4. \`swap_execute\` — paper fill at the quoted net price.

## MVP chains

ethereum, ink, robinhood. Token inspection runs on all three. Quotes run on
ethereum and robinhood via KyberSwap — Kyber does not serve Ink, so Ink
quotes fail closed with "no venues available" until a venue is wired
(0x with an API key, or The Hub).

## The fee

50 bps per swap with a $0.50 minimum (fee = whichever is larger), taken from the output amount at the quote layer. The $0.50 is a placeholder until the Turnkey signer bill calibrates it. The quote
shows you gross, fee, and net separately. In paper mode the fee accrues in a
paper ledger so the accounting is auditable end to end.

## Safety rules (enforced, not suggested)

- Inspect BEFORE quoting: paste the CA into \`token_resolve\` first, every time.
- The agent never says "looks safe." Report the checks and the numbers, then ask.
- Honeypot verdict (BLOCKED) = no quote, no fill, no exceptions.
- Red flags = the user approves explicitly, regardless of size.
- \`pause_trading\` stops everything immediately, no confirmation needed.

## Standing strategies

\`set_trigger\` arms plain-language strategies: "sell half if it doubles".
The trigger stores the live price as its baseline and fires once when the
target trips. \`check_triggers\` polls them (wire it to a cron in production).

## Copy-paste prompts

- "buy $10 of <CA>" → token_resolve, then swap_quote, then swap_execute
- "what's my portfolio worth?" → balance
- "sell half my FUG if it doubles" → set_trigger
- "stop everything" → pause_trading

## Going live (Phase 2)

Live execution runs through Turnkey signer policies: owner-only withdrawals,
approved-router allowlists, exact-amount approvals, expiring mandate keys,
instant revocation. The server refuses to start in live mode without them.
`;
