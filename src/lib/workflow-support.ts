import type { AppEnv, DecryptedAccountRecord } from "../types";
import { getDecryptedAccountById } from "./db";

export async function getDecryptedAccountOrThrow(
  env: AppEnv,
  accountId: string,
): Promise<DecryptedAccountRecord> {
  const account = await getDecryptedAccountById(env, accountId);
  if (!account) {
    throw new Error("account_not_found");
  }
  return account;
}

export function getLockTimeoutSeconds(env: AppEnv): number {
  return Number(env.LOCK_TIMEOUT_SECONDS || 900);
}

export function generateAdminPassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
