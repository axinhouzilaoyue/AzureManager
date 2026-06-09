import { delay } from "./utils";

interface LockEntry {
  owner: string;
  expiresAt: number;
}

const activeLocks = new Map<string, LockEntry>();

export async function acquireSubscriptionLock(input: {
  lockKey: string;
  owner: string;
  timeoutSeconds: number;
  ttlSeconds: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const existing = activeLocks.get(input.lockKey);
    if (!existing || existing.expiresAt < Date.now()) {
      activeLocks.set(input.lockKey, {
        owner: input.owner,
        expiresAt: Date.now() + input.ttlSeconds * 1000,
      });
      return;
    }
    await delay(2000);
  }

  throw new Error("subscription_lock_timeout");
}

export function releaseSubscriptionLock(input: { lockKey: string; owner: string }): void {
  const existing = activeLocks.get(input.lockKey);
  if (existing?.owner === input.owner) {
    activeLocks.delete(input.lockKey);
  }
}
