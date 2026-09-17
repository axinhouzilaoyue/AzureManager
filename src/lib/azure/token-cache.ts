import type { AppEnv, DecryptedAccountRecord } from "../../types";
import { requestAzureAccessToken } from "./auth";

/**
 * Process-level AAD access-token cache.
 *
 * `AzureArmClient.tokenPromise` (client.ts) only cached within one instance, but a
 * fresh client is constructed for every HTTP request, so every account switch paid
 * a cold AAD round-trip. Keyed by tenant+client id so editing an account's name or
 * subscription does not drop a still-valid token.
 *
 * The cache key is deliberately derived from credentials, never from the session
 * cookie: the data an account is allowed to see must not depend on request state.
 */

interface TokenEntry {
  token: string;
  expiresAt: number;
}

/** Renew this long before the real expiry to absorb clock skew and in-flight latency. */
const EXPIRY_SAFETY_MS = 60_000;
/** Never cache shorter than this, even if AAD returns a silly `expires_in`. */
const MIN_TTL_MS = 60_000;
const MAX_ENTRIES = 128;

const tokens = new Map<string, TokenEntry>();
const inflight = new Map<string, Promise<string>>();
const generations = new Map<string, number>();

/**
 * Cache key includes a fingerprint of the secret so that editing an account's
 * credentials cannot keep serving a token minted from the previous ones.
 */
async function cacheKey(
  account: Pick<DecryptedAccountRecord, "tenantId" | "clientId" | "clientSecret">,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(account.clientSecret),
  );
  const fingerprint = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${account.tenantId}:${account.clientId}:${fingerprint}`;
}

function evictIfNeeded(): void {
  if (tokens.size <= MAX_ENTRIES) return;
  const oldest = [...tokens.entries()]
    .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
    .slice(0, tokens.size - MAX_ENTRIES);
  for (const [key] of oldest) {
    if (inflight.has(key)) continue;
    tokens.delete(key);
  }
}

export async function getCachedAzureAccessToken(
  env: AppEnv,
  account: DecryptedAccountRecord,
): Promise<string> {
  const key = await cacheKey(account);

  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  // Single-flight: concurrent requests for the same account share one AAD call.
  const pending = inflight.get(key);
  if (pending) return pending;

  const generation = generations.get(key) ?? 0;
  const request = (async (): Promise<string> => {
    const { accessToken, expiresInSeconds } = await requestAzureAccessToken(env, account);
    const ttlMs = Math.max(MIN_TTL_MS, (expiresInSeconds - EXPIRY_SAFETY_MS / 1000) * 1000);
    // Do not resurrect a token that was invalidated while this request was in flight.
    if ((generations.get(key) ?? 0) === generation) {
      tokens.set(key, { token: accessToken, expiresAt: Date.now() + ttlMs });
      evictIfNeeded();
    }
    return accessToken;
  })();

  inflight.set(key, request);
  try {
    return await request;
  } finally {
    if (inflight.get(key) === request) inflight.delete(key);
  }
}

/** Drop a cached token, e.g. after the upstream rejects it with a 401. */
export async function invalidateAzureAccessToken(
  account: Pick<DecryptedAccountRecord, "tenantId" | "clientId" | "clientSecret">,
  reason: string,
): Promise<void> {
  const key = await cacheKey(account);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  tokens.delete(key);
  console.warn(`[auth] token cache invalidated (${reason}) for client ${account.clientId.slice(0, 8)}`);
}

export function getAzureTokenCacheStats(): { entries: number; inflight: number } {
  return { entries: tokens.size, inflight: inflight.size };
}

/** Test/ops diagnostics only; gated behind DEBUG_CACHE on the route. */
export function resetAzureTokenCache(): void {
  tokens.clear();
  inflight.clear();
  generations.clear();
}
