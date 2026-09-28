/**
 * TaaP (Trading as a Prompt) — configuration.
 *
 * Modes:
 *   paper (default) — simulated fills, play funds, real dry quotes and real
 *                     token inspections. CANNOT move real money by construction:
 *                     there is no signing code path in paper mode at all.
 *   live            — real signing via Turnkey (Phase 2). REFUSES to start
 *                     unless the Turnkey credential is fully configured.
 *                     Fail-closed by design.
 *
 *   TAAP_MODE=live without the Turnkey credential set -> createTaapServer throws.
 *
 * Live credential env (all three required):
 *   TAAP_TURNKEY_ORG_ID, TAAP_TURNKEY_API_PUBLIC_KEY, TAAP_TURNKEY_API_PRIVATE_KEY
 * (TAAP_TURNKEY_API_KEY is kept as a deprecated alias for the private key.)
 */
export type TaapMode = 'paper' | 'live';

/** 50 bps per swap, locked by the founder 2026-09-28. Not env-overridable. */
export const TAAP_FEE_BPS = 50;
/**
 * PLACEHOLDER — calibrate from the first Turnkey bill, do not treat as measured.
 * The per-swap minimum must cover the fixed signer cost:
 *   min = ceil(signatures_per_swap x $/signature x 1.5 margin).
 * Until the real $/signature is known this is a conservative working value.
 */
export const TAAP_MIN_FEE_USD = 0.50;

/** Quote lifetime: stale quotes can't be executed. */
export const QUOTE_TTL_SECONDS = 60;

/** Unfunded paper traders expire after 7 days (spec: anti-sprawl). */
export const UNFUNDED_TRADER_TTL_SECONDS = 7 * 24 * 3600;

export interface TaapConfig {
  mode: TaapMode;
  dbPath: string;
  /** Optional: 0x API key. Without it the 0x venue is skipped. */
  zeroExApiKey?: string;
  /** Live-mode only: Turnkey credential (org + API keypair). All three required. */
  turnkeyOrgId?: string;
  turnkeyApiPublicKey?: string;
  /** Raw P-256 private scalar hex. Memory only — never logged, never returned. */
  turnkeyApiPrivateKey?: string;
  /** Where the claim ceremony server lives. The MCP mints claim links here. */
  claimServerUrl?: string;
  /** Admin key for the claim server's /issue endpoint (live claim mode only). */
  claimAdminKey?: string;
}

export function loadTaapConfig(
  env: Record<string, string | undefined> = process.env,
): TaapConfig {
  const mode = (env.TAAP_MODE ?? 'paper').trim().toLowerCase();
  if (mode !== 'paper' && mode !== 'live') {
    throw new Error(`TAAP_MODE must be "paper" or "live", got "${env.TAAP_MODE}"`);
  }
  const cfg: TaapConfig = {
    mode,
    dbPath: (env.TAAP_DB_PATH ?? './taap-paper.db').trim() || './taap-paper.db',
    zeroExApiKey: env.ZEROEX_API_KEY?.trim() || undefined,
    turnkeyOrgId: env.TAAP_TURNKEY_ORG_ID?.trim() || undefined,
    turnkeyApiPublicKey: env.TAAP_TURNKEY_API_PUBLIC_KEY?.trim().replace(/^0x/, '') || undefined,
    turnkeyApiPrivateKey:
      env.TAAP_TURNKEY_API_PRIVATE_KEY?.trim().replace(/^0x/, '') ||
      env.TAAP_TURNKEY_API_KEY?.trim().replace(/^0x/, '') || // deprecated alias
      undefined,
    claimServerUrl: (env.TAAP_CLAIM_SERVER_URL ?? 'http://localhost:4023').trim() || 'http://localhost:4023',
    claimAdminKey: env.TAAP_CLAIM_ADMIN_KEY?.trim() || undefined,
  };
  if (cfg.mode === 'live' && (!cfg.turnkeyOrgId || !cfg.turnkeyApiPublicKey || !cfg.turnkeyApiPrivateKey)) {
    // Fail closed: live signing without the full credential is a non-starter.
    throw new Error(
      'TAAP_MODE=live requires TAAP_TURNKEY_ORG_ID, TAAP_TURNKEY_API_PUBLIC_KEY and ' +
        'TAAP_TURNKEY_API_PRIVATE_KEY. Refusing to start: live signing without the credential is not allowed.',
    );
  }
  return cfg;
}
