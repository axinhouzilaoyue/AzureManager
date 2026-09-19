import type { DecryptedAccountRecord } from "../types";

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function normalizeImportedAccounts(raw: unknown): Array<{
  name: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  subscriptionId: string;
  email: string | null;
  expirationDate: string | null;
}> {
  let source: unknown = raw;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const object = source as Record<string, unknown>;
    if (object.profiles && typeof object.profiles === "object") source = object.profiles;
    if (object.accounts && typeof object.accounts === "object") source = object.accounts;
  }

  const rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(source)) {
    rows.push(...source.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
  } else if (source && typeof source === "object") {
    rows.push(...Object.entries(source).map(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { name };
      return { name, ...(value as Record<string, unknown>) };
    }));
  }

  return rows.map((row) => ({
    name: pickString(row, ["name", "alias", "displayName", "display_name"]),
    clientId: pickString(row, ["clientId", "client_id", "appId", "app_id", "applicationId"]),
    clientSecret: pickString(row, ["clientSecret", "client_secret", "password", "secret"]),
    tenantId: pickString(row, ["tenantId", "tenant_id", "tenant", "directoryId"]),
    subscriptionId: pickString(row, ["subscriptionId", "subscription_id", "subId", "sub_id"]),
    email: pickString(row, ["email"]) || null,
    expirationDate: pickString(row, ["expirationDate", "expiration_date"]) || null,
  }));
}

export function exportPayload(account: DecryptedAccountRecord | null, includeSecrets: boolean) {
  if (!account) return null;
  return {
    name: account.name,
    clientId: account.clientId,
    tenantId: account.tenantId,
    subscriptionId: account.subscriptionId,
    email: account.email,
    expirationDate: account.expirationDate,
    displayOrder: account.displayOrder,
    subscriptionName: account.subscriptionName,
    subscriptionState: account.subscriptionState,
    quotaTier: account.quotaTier,
    costMtd: account.costMtd,
    costAcc: account.costAcc,
    costHistory: account.costHistory,
    costCurrency: account.costCurrency,
    costUpdatedAt: account.costUpdatedAt,
    costWarning: account.costWarning,
    ...(includeSecrets ? { clientSecret: account.clientSecret } : {}),
  };
}
