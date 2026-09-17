import type { AppEnv, AzureVmSummary } from "../../types";
import { getDecryptedAccountOrThrow } from "../db";
import { AzureArmClient } from "./client";
import { listVirtualMachines } from "./compute";

/**
 * Per-account VM list cache with single-flight de-duplication.
 *
 * Red line: the cache key is an explicit `accountId` passed by the caller. This
 * module must never read the session cookie — if identity leaked in from request
 * state, single-flight would merge account B's request into account A's in-flight
 * fetch and hand B's UI a list of A's machines.
 */

interface CacheEntry {
  vms: AzureVmSummary[];
  fetchedAt: number;
}

export interface VmListSnapshot {
  accountId: string;
  vms: AzureVmSummary[];
  fetchedAt: number;
  /** Served from the TTL window without touching Azure. */
  cached: boolean;
  /** Upstream failed and this is an older value from within the stale window. */
  stale: boolean;
  warning: string | null;
}

/** How long a fetched list is considered authoritative. */
const VM_TTL_MS = Number(process.env.VM_CACHE_TTL_MS ?? 30_000);
/**
 * Beyond this, a failed refresh must surface as an error instead of silently
 * showing old data. Kept short (2 min) on purpose: freshness is guaranteed by
 * write-path invalidation, not by the TTL, and a long silent-stale window is how
 * "I changed the VM but still see the old state" happens.
 */
const VM_STALE_MAX_MS = Number(process.env.VM_CACHE_STALE_MS ?? 120_000);
const MAX_ACCOUNTS = 64;

const entries = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<VmListSnapshot>>();
const generations = new Map<string, number>();

function touch(accountId: string): void {
  const entry = entries.get(accountId);
  if (entry) {
    entries.delete(accountId);
    entries.set(accountId, entry);
  }
}

function evictIfNeeded(): void {
  while (entries.size > MAX_ACCOUNTS) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    entries.delete(oldestKey);
  }
}

export async function getVmList(
  env: AppEnv,
  accountId: string,
  options: { force?: boolean } = {},
): Promise<VmListSnapshot> {
  const entry = entries.get(accountId);
  const now = Date.now();

  if (!options.force && entry && now - entry.fetchedAt < VM_TTL_MS) {
    touch(accountId);
    return {
      accountId,
      vms: entry.vms,
      fetchedAt: entry.fetchedAt,
      cached: true,
      stale: false,
      warning: null,
    };
  }

  const pending = inflight.get(accountId);
  if (pending) return pending;

  const generation = generations.get(accountId) ?? 0;
  const request = (async (): Promise<VmListSnapshot> => {
    try {
      const account = await getDecryptedAccountOrThrow(env, accountId);
      const client = new AzureArmClient(env, account);
      const vms = await listVirtualMachines(client, account.subscriptionId);
      const fetchedAt = Date.now();
      // A write may have landed while we were fetching; do not store pre-change data over it.
      if ((generations.get(accountId) ?? 0) === generation) {
        entries.set(accountId, { vms, fetchedAt });
        evictIfNeeded();
      }
      return { accountId, vms, fetchedAt, cached: false, stale: false, warning: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = entries.get(accountId);
      if (fallback && Date.now() - fallback.fetchedAt < VM_STALE_MAX_MS) {
        touch(accountId);
        console.warn(`[vm-cache] serving stale list for ${accountId.slice(0, 8)}: ${message}`);
        return {
          accountId,
          vms: fallback.vms,
          fetchedAt: fallback.fetchedAt,
          cached: true,
          stale: true,
          warning: `实时查询失败，已显示 ${Math.round((Date.now() - fallback.fetchedAt) / 1000)} 秒前的数据：${message}`,
        };
      }
      throw error;
    }
  })();

  inflight.set(accountId, request);
  try {
    return await request;
  } finally {
    if (inflight.get(accountId) === request) inflight.delete(accountId);
  }
}

/**
 * Called after a mutation finishes. Bumping the generation means an in-flight
 * fetch started before the mutation cannot write its now-obsolete result back.
 */
export function invalidateVmList(accountId: string, reason: string): void {
  generations.set(accountId, (generations.get(accountId) ?? 0) + 1);
  const removed = entries.delete(accountId);
  if (removed) console.log(`[vm-cache] invalidated ${accountId.slice(0, 8)} (${reason})`);
}

export function getVmCacheStats(): { accounts: number; inflight: number } {
  return { accounts: entries.size, inflight: inflight.size };
}

/** Test/ops diagnostics only; gated behind DEBUG_CACHE on the route. */
export function resetVmCache(): void {
  entries.clear();
  inflight.clear();
  generations.clear();
}
