import { AZURE_API_VERSIONS } from "./constants";
import { AzureArmClient } from "./client";
import { delay, nowIso } from "../utils";
import type { AzureCostResult } from "../../types";

const COST_MAX_ATTEMPTS = 5;
const COST_RETRY_BASE_MS = 8000;
const COST_RETRY_MAX_MS = 90_000;

interface CostResponse {
  properties?: {
    columns?: Array<{ name?: string; type?: string }>;
    rows?: Array<Array<string | number | null>>;
  };
}

export async function getQuotaTier(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<string> {
  try {
    const response = await client.request<{ value?: Array<{ properties?: Record<string, unknown> }> }>(
      "GET",
      `/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/quotaTiers`,
      { apiVersion: AZURE_API_VERSIONS.cognitiveServices },
    );
    const properties = response.value?.[0]?.properties ?? {};
    const direct = properties.currentTierName;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    for (const value of Object.values(properties)) {
      if (typeof value === "string" && /^tier\s*[01]$/i.test(value.trim())) return value.trim();
    }
    return "未知";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(":404:")) return "不支持";
    return "未知";
  }
}

export async function getAzureCosts(
  client: AzureArmClient,
  subscriptionId: string,
  expirationDate: string | null,
): Promise<AzureCostResult> {
  const mtd = await queryCost(client, subscriptionId, {
    type: "Usage",
    timeframe: "MonthToDate",
    dataset: {
      granularity: "None",
      aggregation: {
        totalCost: { name: "PreTaxCost", function: "Sum" },
      },
    },
  });

  const today = new Date();
  const periodStart = resolveHistoryStart(expirationDate, today);
  const yearly = await queryCost(client, subscriptionId, {
    type: "Usage",
    timeframe: "Custom",
    timePeriod: {
      from: `${periodStart}T00:00:00Z`,
      to: `${today.toISOString().slice(0, 10)}T23:59:59Z`,
    },
    dataset: {
      granularity: "None",
      aggregation: {
        totalCost: { name: "PreTaxCost", function: "Sum" },
      },
    },
  });

  const mtdValue = Number(mtd.cost || 0);
  const yearlyValue = Math.max(Number(yearly.cost || 0), mtdValue);
  const historyValue = Math.max(0, yearlyValue - mtdValue);
  return {
    mtd: formatCost(mtdValue),
    acc: formatCost(yearlyValue),
    history: formatCost(historyValue),
    currency: yearly.currency || mtd.currency || "",
    queriedAt: nowIso(),
  };
}

function resolveHistoryStart(expirationDate: string | null, today: Date): string {
  if (expirationDate) {
    const expiration = new Date(`${expirationDate}T00:00:00Z`);
    if (!Number.isNaN(expiration.getTime())) {
      const start = new Date(expiration);
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      return start.toISOString().slice(0, 10);
    }
  }

  const fallback = new Date(today);
  fallback.setUTCDate(fallback.getUTCDate() - 365);
  return fallback.toISOString().slice(0, 10);
}

async function queryCost(
  client: AzureArmClient,
  subscriptionId: string,
  payload: unknown,
): Promise<{ cost: string; currency: string }> {
  const path = `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < COST_MAX_ATTEMPTS; attempt += 1) {
    const response = await client.requestResponse("POST", path, {
      apiVersion: AZURE_API_VERSIONS.costManagement,
      body: payload,
    });

    if (response.ok) {
      const data = (await response.json()) as CostResponse;
      return parseCostResponse(data);
    }

    const responseText = await response.text();
    lastError = new Error(`azure_cost_query_failed:${response.status}:${responseText}`);
    if (!isRetryableStatus(response.status) || attempt === COST_MAX_ATTEMPTS - 1) {
      throw lastError;
    }

    const retryAfter = parseRetryAfterMs(response.headers.get("Retry-After"));
    const backoff = Math.min(COST_RETRY_MAX_MS, COST_RETRY_BASE_MS * 2 ** attempt);
    await delay(retryAfter ?? backoff);
  }

  throw lastError ?? new Error("azure_cost_query_failed");
}

function parseCostResponse(data: CostResponse): { cost: string; currency: string } {
  const columns = data.properties?.columns ?? [];
  const row = data.properties?.rows?.[0] ?? [];
  const costIndex = columns.findIndex((column) => column.name === "PreTaxCost" || column.name === "Cost");
  const currencyIndex = columns.findIndex((column) => column.name === "Currency");
  const rawCost = costIndex >= 0 ? row[costIndex] : row[0];
  const rawCurrency = currencyIndex >= 0 ? row[currencyIndex] : "";
  const numeric = Number(rawCost);
  if (!Number.isFinite(numeric)) {
    return { cost: "0", currency: rawCurrency ? String(rawCurrency) : "" };
  }
  return { cost: String(numeric), currency: rawCurrency ? String(rawCurrency) : "" };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, COST_RETRY_MAX_MS);
}

function formatCost(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "未获取";
}
