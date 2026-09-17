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

interface CostQueryResult {
  cost: string;
  currency: string;
  warning: string | null;
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
    return "未识别";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(":404:")) return "不支持";
    if (message.includes(":401:") || message.includes(":403:")) return "无权限";
    return "未获取";
  }
}

export async function getAzureCosts(
  client: AzureArmClient,
  subscriptionId: string,
  expirationDate: string | null,
): Promise<AzureCostResult> {
  // The reference implementation waits briefly before querying Cost Management
  // to reduce throttling when called immediately after account connection.
  await delay(1000);

  const warnings: string[] = [];
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
  if (mtd.warning) warnings.push(`本月消费：${mtd.warning}`);

  let accumulated = mtd.cost;
  let history = "0.00";
  let currency = mtd.currency;

  if (isNumericCost(mtd.cost)) {
    const periodStart = resolveHistoryStart(expirationDate);
    const yearly = periodStart
      ? await queryCost(client, subscriptionId, {
          type: "Usage",
          timeframe: "Custom",
          timePeriod: {
            from: `${periodStart}T00:00:00Z`,
            to: `${new Date().toISOString().slice(0, 10)}T23:59:59Z`,
          },
          dataset: {
            granularity: "None",
            aggregation: {
              totalCost: { name: "PreTaxCost", function: "Sum" },
            },
          },
        })
      : { cost: mtd.cost, currency, warning: null };

    if (yearly.warning) warnings.push(`累计消费：${yearly.warning}`);
    if (isNumericCost(yearly.cost)) {
      const mtdValue = Number(mtd.cost);
      const yearlyValue = Math.max(Number(yearly.cost), mtdValue);
      accumulated = formatCost(yearlyValue);
      history = formatCost(Math.max(0, yearlyValue - mtdValue));
      currency = yearly.currency || currency;
    } else if (yearly.cost !== "0.00") {
      warnings.push("累计消费暂不可用，当前累计值仅展示本月消费");
      accumulated = mtd.cost;
    }
  }

  return {
    mtd: mtd.cost,
    acc: accumulated,
    history,
    currency,
    queriedAt: nowIso(),
    warning: warnings.length ? warnings.join("；") : null,
  };
}

function resolveHistoryStart(expirationDate: string | null): string | null {
  if (!expirationDate) return null;
  const expiration = new Date(`${expirationDate}T00:00:00Z`);
  if (Number.isNaN(expiration.getTime())) return null;

  const start = new Date(expiration);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const today = new Date();
  if (start.getTime() > today.getTime()) {
    const fallback = new Date(today);
    fallback.setUTCDate(fallback.getUTCDate() - 365);
    return fallback.toISOString().slice(0, 10);
  }
  return start.toISOString().slice(0, 10);
}

async function queryCost(
  client: AzureArmClient,
  subscriptionId: string,
  payload: unknown,
): Promise<CostQueryResult> {
  const path = `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query`;
  let lastError = "";

  for (let attempt = 0; attempt < COST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.requestResponse("POST", path, {
        apiVersion: AZURE_API_VERSIONS.costManagement,
        body: payload,
      });

      if (response.ok) {
        return { ...parseCostResponse((await response.json()) as CostResponse), warning: null };
      }

      const responseText = await response.text();
      lastError = `HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 240)}` : ""}`;

      if (response.status === 401 || response.status === 403) {
        return { cost: "无权限(可能为赞助/学生订阅)", currency: "", warning: "当前服务主体没有 Cost Management 查询权限" };
      }
      if (response.status === 400 || response.status === 404) {
        const normalized = responseText.toLowerCase();
        if (normalized.includes("not supported")) {
          return { cost: "赞助订阅请去官网查看", currency: "", warning: null };
        }
        return { cost: "未获取", currency: "", warning: `Cost Management 不支持当前查询（HTTP ${response.status}）` };
      }

      if (!isRetryableStatus(response.status) || attempt === COST_MAX_ATTEMPTS - 1) {
        return { cost: "未获取", currency: "", warning: `查询失败：${lastError}` };
      }

      const retryAfter = parseRetryAfterMs(response.headers.get("Retry-After"));
      const backoff = Math.min(COST_RETRY_MAX_MS, COST_RETRY_BASE_MS * 2 ** attempt);
      await delay(retryAfter ?? backoff);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === COST_MAX_ATTEMPTS - 1) {
        return { cost: "未获取", currency: "", warning: `网络或服务异常：${lastError}` };
      }
      await delay(Math.min(COST_RETRY_MAX_MS, COST_RETRY_BASE_MS * 2 ** attempt));
    }
  }

  return { cost: "未获取", currency: "", warning: lastError || "查询失败" };
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
    return { cost: "0.00", currency: rawCurrency ? String(rawCurrency) : "" };
  }
  return { cost: String(numeric), currency: rawCurrency ? String(rawCurrency) : "" };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isNumericCost(value: string): boolean {
  return Number.isFinite(Number(value));
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
