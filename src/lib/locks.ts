import type { AppEnv, DurableObjectStubBinding } from "../types";
import { delay } from "./utils";

interface LockAcquireResponse {
  acquired: boolean;
  owner?: string;
  expiresAt?: number;
}

function getStub(env: AppEnv, lockKey: string): DurableObjectStubBinding {
  return env.SUBSCRIPTION_LOCK.getByName(lockKey);
}

export async function acquireSubscriptionLock(
  env: AppEnv,
  input: {
    lockKey: string;
    owner: string;
    timeoutSeconds: number;
    ttlSeconds: number;
  },
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < input.timeoutSeconds * 1000) {
    const response = await getStub(env, input.lockKey).fetch("https://lock.internal/acquire", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner: input.owner,
        ttlSeconds: input.ttlSeconds,
      }),
    });

    const payload = (await response.json()) as LockAcquireResponse;
    if (response.ok && payload.acquired) {
      return;
    }

    await delay(2000);
  }

  throw new Error("subscription_lock_timeout");
}

export async function releaseSubscriptionLock(
  env: AppEnv,
  input: {
    lockKey: string;
    owner: string;
  },
): Promise<void> {
  await getStub(env, input.lockKey).fetch("https://lock.internal/release", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      owner: input.owner,
    }),
  });
}
