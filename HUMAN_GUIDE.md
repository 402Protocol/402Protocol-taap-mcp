# TaaP MCP — human guide

This is the agent side of TaaP (Trading as a Prompt). You don't trade through
an app — you connect this to your AI agent once, and then you just prompt it.

## Setup (2 minutes)

1. In your agent's MCP settings, add the `taap` server:

```json
{
  "mcpServers": {
    "taap": {
      "command": "npx",
      "args": ["taap-mcp"]
    }
  }
}
```

2. Say hi to your agent. It provisions your trading wallet on its own and
   gives you a claim link. (You don't ask it to — that's the whole point.)

## Claim your wallet (5 minutes)

3. Open the claim link in your browser.
4. Prove it's you with your fingerprint / face / passkey.
5. Write down the 12 recovery words on paper. This is the only copy — the
   agent never sees them.
6. Confirm the backup. Your deposit address appears.

## Fund it

7. Send funds to the deposit address. The deposit is the signup — no forms,
   no KYC screens, no waiting.

## Trade by prompting

- "buy $200 of `<paste contract address>`"
- "what's my portfolio worth?"
- "watch this wallet and copy its trades under $50"

Every token gets a safety inspection before any trade talk: honeypot
simulation, taxes, mintable supply, ownership, liquidity, holders. The agent
reports the checks and never tells you a token "looks safe".

## The rules that protect you

- The agent can only trade inside your allowance — it can't drain you.
- Withdrawals go only to your registered wallet. Nowhere else, ever.
- You can revoke the agent's access instantly from the claim site.
- Paper mode (the default) can't move real money at all — it's for learning
  the ropes.

## If something goes wrong

Lost your device? Your 12 words recover everything. Someone else grabbed
your claim link before you? It's empty until funded — just provision a fresh
one.
