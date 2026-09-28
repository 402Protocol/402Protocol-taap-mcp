# taap-mcp

TaaP (Trading as a Prompt) MCP server. Connect it to your agent and the agent
provisions a trading wallet on its own — you just back it up.

## The flow

1. You connect this MCP to your agent (one URL / one config block).
2. The agent provisions a trading wallet by itself and hands you a claim link.
3. You open the claim link, prove it's you with your device's fingerprint /
   face / passkey, and write down the 12-word recovery phrase.
4. Only after your backup is confirmed does the agent see the deposit address.
5. You fund the wallet — the deposit is the signup — and trade by prompting:
   "buy $200 of `<CA>`", "watch this wallet and copy trade it".

Paper mode is the default: simulated fills, no signing code paths, cannot move
real money by construction. Live mode needs Turnkey credentials and fails
closed without them.

## Run it

```bash
npx taap-mcp
```

Or from source:

```bash
npm install
npm run build
npm start
```

## Connect it (Claude Code / Muse)

```json
{
  "mcpServers": {
    "taap": {
      "command": "npx",
      "args": ["taap-mcp"],
      "env": {
        "TAAP_CLAIM_SERVER_URL": "https://claim.example.com"
      }
    }
  }
}
```

## Environment

| Variable | Default | What it does |
|---|---|---|
| `TAAP_MODE` | `paper` | `paper` (simulated) or `live` (Turnkey; fails closed without creds) |
| `TAAP_CLAIM_SERVER_URL` | `http://localhost:4023` | Claim site the agent sends the human to |
| `TAAP_CLAIM_ADMIN_KEY` | — | Admin key for the claim server (production) |
| `TAAP_DB_PATH` | `./taap-paper.db` | SQLite state file |

## Tools (15)

Wallet: `provision_wallet`, `claim_status`. Tokens: `token_resolve` (safety
inspection — honeypot sim, taxes, mintable, ownership, LP, holders; never says
"looks safe"). Trading: `quote`, `paper_faucet`, `paper_trade`, `swap_execute`
(refuses live without venue calldata), `triggers`. Policy: `policy_get`,
`withdraw` (owner wallet only).

## Trust model

Constrain the verbs, not the nouns: no arbitrary transfers, withdrawals only
to the owner's registered wallet, approved routers only, exact-amount
approvals, the agent can't modify its own policy, structured signing only.

## Test

```bash
npm test   # in-process MCP tests, stubbed network, no keys needed
```
