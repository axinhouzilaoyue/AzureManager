import { AZURE_API_VERSIONS } from "./constants";
import { AzureArmClient } from "./client";
import { delay, nowIso } from "../utils";
import type { AzureCostResult } from "../../types";

const COST_MAX_ATTEMPTS = 5;
const COST_RETRY_BASE_MS = 8000;
const COST_RETRY_MAX_MS = 90_000;
/**
 * Cool-down before the first Cost Management call. Cost Management throttles
 * aggressively and a switch usually fires several ARM calls just before this,
 * so querying immediately is the main cause of avoidable 429s.
 */
const COST_COOLDOWN_MS = 2500;

/** How the query ended, so the UI can distinguish "really 0" from "could not ask". */
export type CostStatus = "ok" | "cached" | "unsupported" | "denied" | "unavailable";

export interface CostCacheInput {
  mtd?: string | null;
  acc?: string | null;
  history?: string | null;
  currency?: string | null;
  /** ISO timestamp of the cached result; drives the same-month history reuse. */
  updatedAt?: string | null;
}

export interface CostQueryOptions {
  /** Bulk callers (refresh-all) use fewer attempts so one bad account cannot stall the batch. */
  maxAttempts?: number;
  cooldownMs?: number;
}

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
  failed: boolean;
  /** HTTP status when the call was rejected, so callers can classify the reason. */
  httpStatus?: number | null;
}

interface AzureErrorPayload {
  code: string;
  message: string;
  requestId: string | null;
}

export class CostQueryError extends Error {
  status: number | null;
  code: string | null;
  requestId: string | null;

  constructor(message: string, input: { status?: number | null; code?: string | null; requestId?: string | null } = {}) {
    super(message);
    this.name = "CostQueryError";
    this.status = input.status ?? null;
    this.code = input.code ?? null;
    this.requestId = input.requestId ?? null;
  }
}

export async function getQuotaTier(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<string> {
  try {
    const response = await client.requestResponse(
      "GET",
      `/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/quotaTiers`,
      { apiVersion: AZURE_API_VERSIONS.cognitiveServices },
    );

    const bodyText = await response.text();
    if (response.ok) {
      const payload = parseJson<{ value?: Array<{ properties?: Record<string, unknown> }> }>(bodyText);
      const properties = payload?.value?.[0]?.properties ?? {};
      if (Object.keys(properties).length === 0) return "未分配";
      const direct = properties.currentTierName;
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      for (const value of Object.values(properties)) {
        if (typeof value === "string" && /^(tier\s*[0-9]+|free-tier)$/i.test(value.trim())) return value.trim();
      }
      return "未识别";
    }

    const azureError = parseAzureError(bodyText);
    if (response.status === 401) return "认证失败";
    if (response.status === 403) return "无权限";
    if (response.status === 404) {
      if (azureError.code === "SubscriptionNotFound") return "订阅不存在或无权";
      if (azureError.code === "NoRegisteredProviderFound" || azureError.code === "MissingSubscriptionRegistration") {
        return "Provider 未注册";
      }
      if (azureError.code === "ResourceNotFound") return "未分配";
      return "不支持";
    }
    return "未获取";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith("azure_auth_failed:") ? "认证失败" : "未获取";
  }
}

/**
 * Query month-to-date / accumulated spend.
 *
 * Ported behaviour (a reference desktop tool survives the same API much better):
 * - a failed query is NOT fatal. Cost Management rejects the custom-timeframe
 *   "accumulated" query on many subscription types with HTTP 400 while
 *   month-to-date works fine, so a failure degrades to the cached value or to a
 *   readable status instead of blanking the whole panel.
 * - when the cached result is from the current month its `history` is trusted and
 *   `acc = mtd + history`, which skips the fragile second query entirely.
 * - `acc` is monotonic: a fresh value never reports less than the last known one.
 */
export async function getAzureCosts(
  client: AzureArmClient,
  subscriptionId: string,
  expirationDate: string | null,
  cached?: CostCacheInput,
  options: CostQueryOptions = {},
): Promise<AzureCostResult> {
  const cooldownMs = options.cooldownMs ?? COST_COOLDOWN_MS;
  if (cooldownMs > 0) await delay(cooldownMs);

  const maxAttempts = options.maxAttempts ?? COST_MAX_ATTEMPTS;
  const cachedMtd = numericOrNull(cached?.mtd);
  const cachedAcc = numericOrNull(cached?.acc);
  const cachedHistory = numericOrNull(cached?.history);
  const cacheIsCurrentMonth = isSameMonth(cached?.updatedAt);
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
  }, maxAttempts);

  let mtdText: string;
  let status: CostStatus = "ok";
  let freshMtd = false;

  if (mtd.failed || !isNumericCost(mtd.cost)) {
    const reason = mtd.warning ?? "本月消费查询失败";
    if (cachedMtd !== null) {
      mtdText = formatCost(cachedMtd);
      status = "cached";
      warnings.push(`本月消费：${reason}，已沿用上一次成功结果`);
    } else {
      // Nothing to fall back on: report the reason in the cell rather than failing.
      const label = costStatusLabel(mtd);
      return {
        mtd: label,
        acc: label,
        history: "未获取",
        currency: "",
        queriedAt: cached?.updatedAt ?? nowIso(),
        warning: reason,
        status: costStatusFrom(mtd),
      };
    }
  } else {
    mtdText = formatCost(Number(mtd.cost));
    freshMtd = true;
  }

  let accumulated = mtdText;
  let history = "0.00";
  let currency = mtd.currency || cached?.currency || "";
  const periodStart = resolveHistoryStart(expirationDate);

  if (!periodStart) {
    warnings.push("未设置订阅到期日，累计消费暂按本月消费展示");
  } else if (cacheIsCurrentMonth && cachedHistory !== null) {
    // Same month + known history => acc is just the sum. This avoids the second
    // query, which is the one that commonly fails.
    const total = Number(mtdText) + cachedHistory;
    accumulated = formatCost(total);
    history = formatCost(cachedHistory);
  } else {
    const yearly = await queryCost(client, subscriptionId, {
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
    }, maxAttempts);

    if (yearly.failed || !isNumericCost(yearly.cost)) {
      const reason = yearly.warning ?? "未获取";
      if (cachedAcc !== null) {
        accumulated = formatCost(cachedAcc);
        history = cachedHistory !== null ? formatCost(cachedHistory) : "未获取";
        status = status === "ok" ? "cached" : status;
        warnings.push(`累计消费：${reason}，已沿用上一次成功结果`);
      } else {
        accumulated = mtdText;
        // Deliberately NOT "0.00". A fabricated zero would be persisted, and the
        // next run would treat it as a known history and take the `acc = mtd +
        // history` shortcut forever, silently pinning the accumulated figure to
        // the month-to-date value. An unknown history must stay unknown so the
        // yearly query is attempted again on the next refresh.
        history = "未获取";
        warnings.push("累计消费暂不可用，当前累计值仅展示本月消费");
      }
    } else {
      const mtdValue = Number(mtdText);
      const yearlyValue = Math.max(Number(yearly.cost), mtdValue);
      accumulated = formatCost(yearlyValue);
      history = formatCost(Math.max(0, yearlyValue - mtdValue));
      currency = yearly.currency || currency;
    }
  }

  // Never report a lower accumulated figure than one already known to be true.
  if (cachedAcc !== null) {
    const current = numericOrNull(accumulated);
    if (current !== null && current < cachedAcc) {
      accumulated = formatCost(cachedAcc);
      if (cachedHistory !== null) history = formatCost(cachedHistory);
    }
  }

  return {
    mtd: mtdText,
    acc: accumulated,
    history,
    currency,
    // Only claim freshness when month-to-date actually came back this time.
    queriedAt: freshMtd ? nowIso() : (cached?.updatedAt ?? nowIso()),
    warning: warnings.length ? warnings.join("；") : null,
    status,
  };
}

function numericOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cached history is only trustworthy while the cached result is from this month. */
function isSameMonth(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth();
}

function costStatusFrom(result: CostQueryResult): CostStatus {
  const reason = `${result.warning ?? ""}`.toLowerCase();
  if (result.httpStatus === 401 || result.httpStatus === 403 || reason.includes("无权限")) return "denied";
  if (result.httpStatus === 400 || result.httpStatus === 404 || result.httpStatus === 422) return "unsupported";
  return "unavailable";
}

function costStatusLabel(result: CostQueryResult): string {
  switch (costStatusFrom(result)) {
    case "denied":
      return "无权限（可能为赞助/学生订阅）";
    case "unsupported":
      return "该订阅不支持查询";
    default:
      return "未获取";
  }
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
  maxAttempts: number = COST_MAX_ATTEMPTS,
): Promise<CostQueryResult> {
  const path = `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query`;
  let lastWarning = "";
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await client.requestResponse("POST", path, {
        apiVersion: AZURE_API_VERSIONS.costManagement,
        body: payload,
      });

      if (response.status === 204) {
        return { cost: "0.00", currency: "", warning: "Cost Management 暂无返回数据", failed: false };
      }

      const bodyText = await response.text();
      if (response.ok) {
        return { ...parseCostResponse(parseJson<CostResponse>(bodyText)), warning: null, failed: false };
      }

      const azureError = parseAzureError(bodyText);
      if (response.status === 401) {
        return {
          cost: "未获取",
          currency: "",
          warning: "Azure 认证失败或查看费用权限未启用",
          failed: true,
          httpStatus: 401,
        };
      }
      if (response.status === 403) {
        return {
          cost: "未获取",
          currency: "",
          warning: "权限不足：需要 Cost Management Reader 或对应计费权限",
          failed: true,
          httpStatus: 403,
        };
      }
      if (response.status === 400 || response.status === 404 || response.status === 422) {
        return {
          cost: "未获取",
          currency: "",
          warning: classifyCostError(response.status, azureError),
          failed: true,
          httpStatus: response.status,
        };
      }
      lastStatus = response.status;

      lastWarning = isRetryableStatus(response.status)
        ? `Azure 成本服务暂时不可用或触发限流（HTTP ${response.status}）`
        : `Cost Management 查询失败（HTTP ${response.status}）`;

      if (!isRetryableStatus(response.status) || attempt === maxAttempts - 1) {
        return { cost: "未获取", currency: "", warning: lastWarning, failed: true, httpStatus: response.status };
      }

      const retryAfter = parseRetryAfterMs(
        response.headers.get("x-ms-ratelimit-microsoft.consumption-retry-after")
          ?? response.headers.get("Retry-After"),
      );
      const backoff = Math.min(COST_RETRY_MAX_MS, COST_RETRY_BASE_MS * 2 ** attempt);
      await delay(retryAfter ?? backoff);
    } catch (error) {
      lastWarning = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts - 1) {
        return {
          cost: "未获取",
          currency: "",
          warning: lastWarning.startsWith("azure_auth_failed:")
            ? "Azure 认证失败，请检查租户、Client ID 和 Client Secret"
            : "网络或服务异常，未更新上次成功结果",
          failed: true,
          httpStatus: null,
        };
      }
      await delay(Math.min(COST_RETRY_MAX_MS, COST_RETRY_BASE_MS * 2 ** attempt));
    }
  }

  return { cost: "未获取", currency: "", warning: lastWarning || "查询失败", failed: true, httpStatus: lastStatus };
}

function classifyCostError(status: number, error: AzureErrorPayload): string {
  switch (error.code) {
    case "SubscriptionTypeNotSupported":
      return "当前订阅类型不支持 Cost Management 查询";
    case "SubscriptionNotFound":
      return "订阅不存在，或当前服务主体无权访问";
    case "AuthorizationFailed":
    case "RBACAccessDenied":
    case "BillingAccessDenied":
      return "权限不足：需要 Cost Management Reader 或对应计费权限";
    case "MissingSubscriptionRegistration":
    case "NoRegisteredProviderFound":
      return "Microsoft.CostManagement Provider 未注册或尚未完成注册";
    case "BadRequest":
      return "Cost Management 请求参数不受当前订阅支持";
    default:
      return `Cost Management 查询失败（HTTP ${status}${error.code ? `，${error.code}` : ""}）`;
  }
}

function parseCostResponse(data: CostResponse | null): { cost: string; currency: string } {
  const columns = data?.properties?.columns ?? [];
  const row = data?.properties?.rows?.[0] ?? [];
  const costIndex = columns.findIndex((column) => column.name === "PreTaxCost" || column.name === "Cost");
  const currencyIndex = columns.findIndex((column) => column.name === "Currency");
  const rawCost = costIndex >= 0 ? row[costIndex] : row[0];
  const rawCurrency = currencyIndex >= 0 ? row[currencyIndex] : "";
  const numeric = Number(rawCost);
  if (!Number.isFinite(numeric)) {
    return { cost: "0.00", currency: rawCurrency ? String(rawCurrency) : "" };
  }
  return { cost: formatCost(numeric), currency: rawCurrency ? String(rawCurrency) : "" };
}

function parseAzureError(bodyText: string): AzureErrorPayload {
  const payload = parseJson<{
    error?: { code?: string; message?: string; innererror?: { code?: string; message?: string } };
  }>(bodyText);
  const error = payload?.error ?? {};
  const generatedCode = error.innererror?.code || error.code || "";
  const message = error.innererror?.message || error.message || "";
  const requestIdMatch = bodyText.match(/"?x-ms-request-id"?\s*[:=]\s*"?([0-9a-f-]+)/i);
  return {
    code: String(generatedCode || "").trim(),
    message: String(message || "").trim(),
    requestId: requestIdMatch?.[1] ?? null,
  };
}

function parseJson<T>(text: string): T | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isNumericCost(value: string): boolean {
  return Number.isFinite(Number(value));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, COST_RETRY_MAX_MS);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), COST_RETRY_MAX_MS));
  return null;
}

function formatCost(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "未获取";
}
