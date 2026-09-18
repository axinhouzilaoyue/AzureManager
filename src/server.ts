import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AppEnv } from "./types";
import { toBase64Url } from "./lib/utils";
import { createLogoutCookie, createLoginCookie, createSelectionCookie, getAuthContext, requireAuth } from "./lib/auth";
import {
  accountNameExists,
  createAccount,
  createTask,
  deleteAccount,
  getAccountById,
  getDecryptedAccountById,
  getDecryptedAccountOrThrow,
  getGlobalSshSettings,
  getGlobalStartupScript,
  getTaskResponse,
  listTasksForAccount,
  initializeDatabase,
  listAccounts,
  reorderAccounts,
  setGlobalSshSettings,
  setGlobalStartupScript,
  updateAccountCost,
  updateAccountCredentials,
  updateAccountInsights,
} from "./lib/db";
import { startChangeIp, startCreateVm, startVmLifecycle } from "./lib/background";
import { AzureArmClient } from "./lib/azure/client";
import { countVirtualMachines, listVmSizes } from "./lib/azure/compute";
import {
  getVmCacheStats,
  getVmList,
  invalidateVmList,
  resetVmCache,
} from "./lib/azure/vm-cache";
import {
  invalidateAzureAccessToken,
  resetAzureTokenCache,
} from "./lib/azure/token-cache";
import { CostQueryError, getAzureCosts, getQuotaTier } from "./lib/azure/cost";
import { getIpPermission } from "./lib/azure/network";
import { getSubscriptionDetails, listDeployableLocations, registerRequiredProviders } from "./lib/azure/subscription";
import {
  accountCheckSchema,
  changeIpSchema,
  createAccountSchema,
  createVmSchema,
  editAccountSchema,
  importAccountsSchema,
  loginSchema,
  reorderAccountsSchema,
  selectAccountSchema,
  updateGlobalSshSchema,
  updateStartupScriptSchema,
  vmActionSchema,
} from "./lib/validation";
import { accountJson, errorResponse, jsonResponse, readJson } from "./lib/utils";
import type { ZodType } from "zod";

// ---- secrets ----
interface Secrets {
  sessionSecret: string;
  encryptionKey: string;
}

function loadOrCreateSecrets(): Secrets {
  const path = "data/.secret";
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as Secrets;
  }
  const secrets: Secrets = {
    sessionSecret: toBase64Url(crypto.getRandomValues(new Uint8Array(48))),
    encryptionKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
  writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  console.log("First run: generated secrets saved to data/.secret");
  return secrets;
}

// ---- env bootstrap ----
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) throw new Error("Missing required env var: APP_PASSWORD");

mkdirSync("data", { recursive: true });
const secrets = loadOrCreateSecrets();
const db = new Database("data/azure-manager.db");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
initializeDatabase(db);

const ENV: AppEnv = {
  APP_NAME: process.env.APP_NAME ?? "Azure VM Management Panel",
  APP_PASSWORD,
  SESSION_SECRET: secrets.sessionSecret,
  ACCOUNT_ENCRYPTION_KEY: secrets.encryptionKey,
  SESSION_TTL_SECONDS: parseInt(process.env.SESSION_TTL_SECONDS ?? "604800"),
  LOCK_TIMEOUT_SECONDS: parseInt(process.env.LOCK_TIMEOUT_SECONDS ?? "900"),
  AZURE_ARM_BASE_URL: process.env.AZURE_ARM_BASE_URL ?? "https://management.azure.com",
  AZURE_AUTH_BASE_URL: process.env.AZURE_AUTH_BASE_URL ?? "https://login.microsoftonline.com",
  DB: db,
};

// ---- helpers ----
const OVERVIEW_ACCOUNT_CONCURRENCY = parseInt(process.env.OVERVIEW_ACCOUNT_CONCURRENCY ?? "3");
const BULK_REFRESH_CONCURRENCY = parseInt(process.env.BULK_REFRESH_CONCURRENCY ?? "3");

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T | Response> {
  const payload = await readJson<unknown>(req);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return errorResponse(400, parsed.error.issues[0]?.message ?? "请求参数无效");
  return parsed.data;
}

function serveFile(path: string, contentType: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "content-type": contentType,
      // Avoid sticky cached UI/JS after deploys.
      "cache-control": "no-store, max-age=0",
    },
  });
}

function formatAzureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("azure_auth_failed:")) return "Azure 认证失败，请检查客户端 ID、客户端密码和租户 ID 是否正确。";
  if (message.includes("SubscriptionNotFound")) return "订阅不存在，或当前服务主体无权访问该订阅。";
  if (message.includes("AuthorizationFailed")) return "凭据有效，但当前服务主体没有足够的订阅权限。";
  if (message.includes("account_not_found")) return "账户不存在。";
  return "Azure 检查失败，请确认订阅 ID、租户、服务主体权限以及当前目录是否正确。";
}

/** `AbortSignal.timeout` surfaces as a DOMException named TimeoutError. */
function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Small bounded-concurrency map so cross-account fan-out cannot saturate the egress. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeImportedAccounts(raw: unknown): Array<{
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

function exportPayload(account: Awaited<ReturnType<typeof getDecryptedAccountById>>, includeSecrets: boolean) {
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

// ---- server ----
const server = Bun.serve({
  port: parseInt(process.env.PORT ?? "8080"),

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // static files
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile("public/index.html", "text/html; charset=utf-8");
    }
    if (url.pathname === "/app.js") {
      return serveFile("public/app.js", "application/javascript");
    }
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    try {
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, service: ENV.APP_NAME, timestamp: new Date().toISOString() });
      }
      if (url.pathname.startsWith("/auth/")) return handleAuth(req, url);
      if (url.pathname.startsWith("/api/")) return handleApi(req, url);
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Unhandled error", error);
      return errorResponse(500, "服务器内部错误", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

console.log(`Azure Manager running on http://localhost:${server.port}`);

// ---- auth routes ----
async function handleAuth(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await parseBody(req, loginSchema);
    if (body instanceof Response) return body;
    if (body.password !== ENV.APP_PASSWORD) return errorResponse(401, "密码错误");
    const existing = await getAuthContext(ENV, req);
    const cookie = await createLoginCookie(ENV, existing.session);
    return jsonResponse({ success: true }, { headers: { "Set-Cookie": cookie } });
  }
  if (req.method === "POST" && url.pathname === "/auth/logout") {
    return jsonResponse({ success: true }, { headers: { "Set-Cookie": createLogoutCookie() } });
  }
  return errorResponse(404, "接口不存在");
}

// ---- api routes ----
async function handleApi(req: Request, url: URL): Promise<Response> {
  // session info (public)
  if (req.method === "GET" && url.pathname === "/api/session") {
    const auth = await getAuthContext(ENV, req);
    const selected = auth.session.selectedAccountId
      ? await getAccountById(ENV, auth.session.selectedAccountId)
      : null;
    return jsonResponse({
      loggedIn: auth.authenticated,
      selectedAccountId: selected?.id ?? null,
      selectedAccountName: selected?.name ?? null,
    });
  }

  const auth = await requireAuth(ENV, req);
  if (auth instanceof Response) return auth;

  // session account selection.
  // UI memory only ("which account was I last looking at"). It MUST NOT be read
  // to decide whose data a request returns — account identity belongs in the
  // request path (see the account-scoped routes below). A reordered or stale
  // write here can therefore never change what data a request gets back.
  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await parseBody(req, selectAccountSchema);
    if (body instanceof Response) return body;
    if (body.accountId && !(await getAccountById(ENV, body.accountId))) return errorResponse(404, "账户未找到");
    const cookie = await createSelectionCookie(ENV, req, body.accountId);
    return jsonResponse({ success: true, selectedAccountId: body.accountId }, { headers: { "Set-Cookie": cookie } });
  }
  if (req.method === "DELETE" && url.pathname === "/api/session") {
    const cookie = await createSelectionCookie(ENV, req, null);
    return jsonResponse({ success: true }, { headers: { "Set-Cookie": cookie } });
  }

  // accounts list
  if (req.method === "GET" && url.pathname === "/api/accounts") {
    return jsonResponse(await listAccounts(ENV));
  }

  if (req.method === "GET" && url.pathname === "/api/accounts/export") {
    const includeSecrets = url.searchParams.get("includeSecrets") === "true";
    const accounts = await listAccounts(ENV);
    const exported = await Promise.all(accounts.map(async (account) => {
      const decrypted = await getDecryptedAccountById(ENV, account.id);
      return exportPayload(decrypted, includeSecrets);
    }));
    const body = JSON.stringify({
      exportedAt: new Date().toISOString(),
      includeSecrets,
      accounts: exported.filter(Boolean),
    }, null, 2);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="azure-accounts-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store",
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts/import") {
    const body = await parseBody(req, importAccountsSchema);
    if (body instanceof Response) return body;
    const normalized = normalizeImportedAccounts(body.data);
    const imported: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const item of normalized) {
      const parsed = createAccountSchema.safeParse(item);
      if (!parsed.success) {
        skipped.push({ name: item.name || "未命名账户", reason: parsed.error.issues[0]?.message ?? "数据无效" });
        continue;
      }
      if (await accountNameExists(ENV, parsed.data.name)) {
        skipped.push({ name: parsed.data.name, reason: "账户名称已存在" });
        continue;
      }
      await createAccount(ENV, {
        id: crypto.randomUUID(),
        name: parsed.data.name,
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        tenantId: parsed.data.tenantId,
        subscriptionId: parsed.data.subscriptionId,
        email: parsed.data.email ?? null,
        expirationDate: parsed.data.expirationDate ?? null,
      });
      imported.push(parsed.data.name);
    }
    return jsonResponse({ imported, skipped });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts/reorder") {
    const body = await parseBody(req, reorderAccountsSchema);
    if (body instanceof Response) return body;
    await reorderAccounts(ENV, body.accountIds);
    return jsonResponse({ success: true });
  }

  // Refresh every account's data in one action: VM list, subscription/quota
  // insights and cost. Bounded concurrency keeps a large fleet from saturating
  // the egress or tripping ARM throttling, and per-account failures are reported
  // instead of aborting the whole batch.
  if (req.method === "POST" && url.pathname === "/api/accounts/refresh-all") {
    const accounts = await listAccounts(ENV);
    const results = await mapWithConcurrency(accounts, BULK_REFRESH_CONCURRENCY, async (account) => {
      const errors: string[] = [];
      // Degraded-but-expected outcomes (e.g. a subscription that does not support
      // Cost Management) are reported separately so they do not mark the account failed.
      const warnings: string[] = [];
      const summary = {
        accountId: account.id,
        name: account.name,
        vmCount: null as number | null,
        subscriptionDisplayName: account.subscriptionName,
        state: account.subscriptionState,
        quotaTier: account.quotaTier,
        cost: null as { mtd: string; acc: string; history: string; currency: string } | null,
      };
      let decrypted;
      try {
        decrypted = await getDecryptedAccountOrThrow(ENV, account.id);
      } catch (error) {
        return { ...summary, ok: false, errors: [messageOf(error)], warnings };
      }
      const client = new AzureArmClient(ENV, decrypted);

      try {
        const snapshot = await getVmList(ENV, account.id, { force: true });
        summary.vmCount = snapshot.vms.length;
      } catch (error) {
        errors.push(`虚拟机：${messageOf(error)}`);
      }

      try {
        const [subResult, quotaResult] = await Promise.allSettled([
          getSubscriptionDetails(client, decrypted.subscriptionId),
          getQuotaTier(client, decrypted.subscriptionId),
        ]);
        if (subResult.status === "fulfilled") {
          summary.subscriptionDisplayName = subResult.value.displayName;
          summary.state = subResult.value.state;
        } else {
          errors.push(`订阅信息：${messageOf(subResult.reason)}`);
        }
        if (quotaResult.status === "fulfilled") {
          summary.quotaTier = quotaResult.value;
        } else {
          errors.push(`AI 配额：${messageOf(quotaResult.reason)}`);
        }
        await updateAccountInsights(ENV, {
          accountId: account.id,
          subscriptionName: summary.subscriptionDisplayName,
          subscriptionState: summary.state,
          quotaTier: summary.quotaTier,
        });
      } catch (error) {
        errors.push(`订阅信息：${messageOf(error)}`);
      }

      try {
        const cost = await getAzureCosts(
          client,
          decrypted.subscriptionId,
          decrypted.expirationDate,
          {
            mtd: account.costMtd,
            acc: account.costAcc,
            history: account.costHistory,
            currency: account.costCurrency,
            updatedAt: account.costUpdatedAt,
          },
          // Keep the batch moving: one retry instead of five.
          { maxAttempts: 2, cooldownMs: 0 },
        );
        await updateAccountCost(ENV, account.id, cost);
        summary.cost = { mtd: cost.mtd, acc: cost.acc, history: cost.history, currency: cost.currency };
        if (cost.warning) warnings.push(`消费：${cost.warning}`);
      } catch (error) {
        errors.push(`消费：${messageOf(error)}`);
      }

      return { ...summary, ok: errors.length === 0, errors, warnings };
    });

    return jsonResponse({
      total: accounts.length,
      refreshed: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok),
      results,
    });
  }

  // cross-account VM fleet for overview page
  if (req.method === "GET" && url.pathname === "/api/overview/vms") {
    const accounts = await listAccounts(ENV);
    const degradedAccountIds: string[] = [];
    // Reuses the same per-account cache the account workspace reads, and bounds
    // concurrency so a large fleet cannot saturate the egress or trip ARM throttling.
    const chunks = await mapWithConcurrency(accounts, OVERVIEW_ACCOUNT_CONCURRENCY, async (account) => {
      try {
        const snapshot = await getVmList(ENV, account.id);
        const accountLabel = (account.email || account.name || "未命名账户").trim();
        return snapshot.vms.map((vm) => ({
          accountId: account.id,
          accountLabel,
          name: vm.name,
          status: vm.status,
          location: vm.location,
          vmSize: vm.vmSize,
          publicIp: vm.publicIp,
          ipAllocationMethod: vm.ipAllocationMethod,
          diskSizeGb: vm.diskSizeGb,
          uptimeDays: vm.uptimeDays,
          timeCreated: vm.timeCreated,
          resourceGroup: vm.resourceGroup,
        }));
      } catch (error) {
        degradedAccountIds.push(account.id);
        console.warn("Overview VM fetch failed", account.id, error);
        return [] as Array<Record<string, unknown>>;
      }
    });
    const items = chunks.flat().sort((a, b) => {
      const byAccount = String(a.accountLabel).localeCompare(String(b.accountLabel));
      if (byAccount !== 0) return byAccount;
      return String(a.name).localeCompare(String(b.name));
    });
    const running = items.filter((vm) => String(vm.status || "").toLowerCase().includes("running")).length;
    return jsonResponse({
      accountCount: accounts.length,
      vmCount: items.length,
      runningCount: running,
      stoppedCount: Math.max(0, items.length - running),
      degradedAccountIds,
      items,
    });
  }

  // Cache diagnostics are test/ops only and stay off unless explicitly enabled.
  if (req.method === "POST" && url.pathname === "/api/_debug/cache/reset") {
    if (process.env.DEBUG_CACHE !== "1") return errorResponse(404, "接口不存在");
    resetVmCache();
    resetAzureTokenCache();
    return jsonResponse({ ok: true, ...getVmCacheStats() });
  }

  // account check (with credentials in body)
  if (req.method === "POST" && url.pathname === "/api/accounts/check") {
    const body = await parseBody(req, accountCheckSchema);
    if (body instanceof Response) return body;
    try {
      const tempAccount = {
        id: "check",
        name: "check",
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        tenantId: body.tenantId,
        subscriptionId: body.subscriptionId,
        email: null,
        expirationDate: null,
        displayOrder: 0,
        subscriptionName: null,
        subscriptionState: null,
        quotaTier: null,
        costMtd: null,
        costAcc: null,
        costHistory: null,
        costCurrency: null,
        costUpdatedAt: null,
        costWarning: null,
        createdAt: "",
        updatedAt: "",
      };
      const client = new AzureArmClient(ENV, tempAccount);
      const sub = await getSubscriptionDetails(client, body.subscriptionId);
      const [regionListing, providerWarnings] = await Promise.all([
        listDeployableLocations(client, body.subscriptionId),
        registerRequiredProviders(client, body.subscriptionId),
      ]);
      return jsonResponse({
        subscriptionDisplayName: sub.displayName,
        state: sub.state,
        availableRegionCount: regionListing.locations.length,
        warnings: providerWarnings,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      return errorResponse(400, formatAzureError(error));
    }
  }

  // create account
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await parseBody(req, createAccountSchema);
    if (body instanceof Response) return body;
    if (await accountNameExists(ENV, body.name)) return errorResponse(409, "账户名称已存在");
    const created = await createAccount(ENV, {
      id: crypto.randomUUID(),
      name: body.name,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      tenantId: body.tenantId,
      subscriptionId: body.subscriptionId,
      email: body.email ?? null,
      expirationDate: body.expirationDate ?? null,
    });
    return jsonResponse(created, { status: 201 });
  }

  // edit account
  if (req.method === "POST" && url.pathname === "/api/accounts/edit") {
    const body = await parseBody(req, editAccountSchema);
    if (body instanceof Response) return body;
    const existing = await getDecryptedAccountById(ENV, body.accountId);
    if (!existing) return errorResponse(404, "账户未找到");
    if (await accountNameExists(ENV, body.newName, body.accountId)) return errorResponse(409, "新的账户名称已存在");

    const clientId = body.clientId ?? existing.clientId;
    const tenantId = body.tenantId ?? existing.tenantId;
    const subscriptionId = body.subscriptionId ?? existing.subscriptionId;
    const credentialsChanged = clientId !== existing.clientId
      || tenantId !== existing.tenantId
      || subscriptionId !== existing.subscriptionId
      || Boolean(body.clientSecret);

    await updateAccountCredentials(ENV, {
      accountId: body.accountId,
      name: body.newName,
      clientId,
      tenantId,
      subscriptionId,
      clientSecret: body.clientSecret ?? null,
      email: body.email ?? null,
      expirationDate: body.expirationDate ?? null,
    });

    if (credentialsChanged) {
      // Cached Azure data belongs to the previous credentials/subscription.
      invalidateVmList(body.accountId, "account_credentials_changed");
      await invalidateAzureAccessToken(existing, "account_credentials_changed");
    }

    let headers: HeadersInit | undefined;
    if (auth.session.selectedAccountId === body.accountId) {
      headers = { "Set-Cookie": await createSelectionCookie(ENV, req, body.accountId) };
    }
    return jsonResponse({ success: true, credentialsChanged }, { headers });
  }

  // Quota tier only: one lightweight ARM call, so the insights bar can refresh
  // just the quota figure without re-pulling VMs or cost.
  const quotaMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/quota$/)
    : null;
  if (quotaMatch) {
    const accountId = quotaMatch[1];
    try {
      const account = await getDecryptedAccountOrThrow(ENV, accountId);
      const client = new AzureArmClient(ENV, account);
      const quotaTier = await getQuotaTier(client, account.subscriptionId);
      await updateAccountInsights(ENV, {
        accountId,
        subscriptionName: account.subscriptionName,
        subscriptionState: account.subscriptionState,
        quotaTier,
      });
      return accountJson(accountId, { quotaTier }, { headers: { "x-account-id": accountId } });
    } catch (error) {
      return errorResponse(400, formatAzureError(error), { accountId });
    }
  }

  // account overview (subscription label + vm count) without changing selected session
  const overviewMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/overview$/)
    : null;
  if (overviewMatch) {
    try {
      const account = await getDecryptedAccountOrThrow(ENV, overviewMatch[1]);
      const client = new AzureArmClient(ENV, account);
      void registerRequiredProviders(client, account.subscriptionId).catch((error) => {
        console.warn("Provider registration skipped", account.id, error);
      });
      // 概览只需要台数与订阅信息，用轻量计数代替完整 VM 列表（后者要为每台 VM 拉取详情）。
      const [subResult, vmsResult, quotaResult] = await Promise.allSettled([
        getSubscriptionDetails(client, account.subscriptionId),
        countVirtualMachines(client, account.subscriptionId),
        getQuotaTier(client, account.subscriptionId),
      ]);
      const sub = subResult.status === "fulfilled" ? subResult.value : null;
      const vmCount = vmsResult.status === "fulfilled" ? vmsResult.value : null;
      const quotaTier = quotaResult.status === "fulfilled"
        ? quotaResult.value
        : (account.quotaTier ?? "未获取");
      await updateAccountInsights(ENV, {
        accountId: account.id,
        subscriptionName: sub?.displayName ?? account.subscriptionName,
        subscriptionState: sub?.state ?? account.subscriptionState,
        quotaTier,
      });
      return jsonResponse({
        id: account.id,
        subscriptionDisplayName: sub?.displayName ?? account.subscriptionName ?? account.subscriptionId,
        state: sub?.state ?? account.subscriptionState ?? "Unknown",
        vmCount: vmCount ?? 0,
        quotaTier,
        vmError: vmsResult.status === "rejected"
          ? (vmsResult.reason instanceof Error ? vmsResult.reason.message : String(vmsResult.reason))
          : null,
        subscriptionError: subResult.status === "rejected"
          ? (subResult.reason instanceof Error ? subResult.reason.message : String(subResult.reason))
          : null,
      });
    } catch (error) {
      return errorResponse(400, formatAzureError(error));
    }
  }

  // check existing account
  const checkMatch = req.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/check$/)
    : null;
  if (checkMatch) {
    try {
      const account = await getDecryptedAccountOrThrow(ENV, checkMatch[1]);
      const client = new AzureArmClient(ENV, account);
      const sub = await getSubscriptionDetails(client, account.subscriptionId);
      const [regionListing, quotaTier, providerWarnings] = await Promise.all([
        listDeployableLocations(client, account.subscriptionId),
        getQuotaTier(client, account.subscriptionId),
        registerRequiredProviders(client, account.subscriptionId),
      ]);
      await updateAccountInsights(ENV, {
        accountId: account.id,
        subscriptionName: sub.displayName,
        subscriptionState: sub.state,
        quotaTier,
      });
      return jsonResponse({
        subscriptionDisplayName: sub.displayName,
        state: sub.state,
        availableRegionCount: regionListing.locations.length,
        warnings: providerWarnings,
        quotaTier,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      return errorResponse(400, formatAzureError(error));
    }
  }

  // delete account
  const deleteMatch = req.method === "DELETE"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})$/)
    : null;
  if (deleteMatch) {
    const account = await getDecryptedAccountById(ENV, deleteMatch[1]);
    if (!account) return errorResponse(404, "账户未找到");
    await deleteAccount(ENV, deleteMatch[1]);
    invalidateVmList(deleteMatch[1], "account_deleted");
    await invalidateAzureAccessToken(account, "account_deleted");
    const headers: HeadersInit = {};
    if (auth.session.selectedAccountId === deleteMatch[1]) {
      headers["Set-Cookie"] = await createSelectionCookie(ENV, req, null);
    }
    return jsonResponse({ success: true }, { headers });
  }

  // startup script
  if (req.method === "GET" && url.pathname === "/api/settings/startup-script") {
    return jsonResponse({ userData: await getGlobalStartupScript(ENV) });
  }
  if (req.method === "POST" && url.pathname === "/api/settings/startup-script") {
    const body = await parseBody(req, updateStartupScriptSchema);
    if (body instanceof Response) return body;
    await setGlobalStartupScript(ENV, { userData: body.userData, updatedBy: auth.actor });
    return jsonResponse({ success: true, userData: body.userData });
  }

  if (req.method === "GET" && url.pathname === "/api/settings/global-ssh") {
    const settings = await getGlobalSshSettings(ENV);
    return jsonResponse({
      publicKey: settings.publicKey,
      username: settings.username,
      passwordSet: Boolean(settings.password),
      updatedAt: settings.updatedAt,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/settings/global-ssh") {
    const body = await parseBody(req, updateGlobalSshSchema);
    if (body instanceof Response) return body;
    await setGlobalSshSettings(ENV, {
      publicKey: body.publicKey,
      username: body.username,
      password: body.password,
      updatedBy: auth.actor,
    });
    return jsonResponse({ success: true });
  }

  const detailMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/detail$/)
    : null;
  if (detailMatch) {
    const account = await getDecryptedAccountById(ENV, detailMatch[1]);
    if (!account) return errorResponse(404, "账户未找到");
    return jsonResponse(exportPayload(account, true));
  }

  const costMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/cost$/)
    : null;
  if (costMatch) {
    const accountId = costMatch[1];
    const account = await getDecryptedAccountOrThrow(ENV, accountId).catch(() => null);
    if (!account) return errorResponse(404, "账户未找到");
    const client = new AzureArmClient(ENV, account);
    try {
      await registerRequiredProviders(client, account.subscriptionId).catch(() => {});
      const cost = await getAzureCosts(
        client,
        account.subscriptionId,
        account.expirationDate,
        {
          mtd: account.costMtd,
          acc: account.costAcc,
          history: account.costHistory,
          currency: account.costCurrency,
          updatedAt: account.costUpdatedAt,
        },
      );
      await updateAccountCost(ENV, accountId, cost);
      return jsonResponse({ success: true, cached: cost.status !== "ok", ...cost });
    } catch (error) {
      // Query failures no longer throw (they degrade to cached/status values);
      // this only catches unexpected errors such as a decryption failure.
      const detail = error instanceof Error ? error.message : String(error);
      const hasCache = account.costMtd !== null;
      if (hasCache) {
        return jsonResponse({
          success: true,
          cached: true,
          mtd: account.costMtd,
          acc: account.costAcc,
          history: account.costHistory,
          currency: account.costCurrency ?? "",
          queriedAt: account.costUpdatedAt,
          warning: `实时查询失败，已显示缓存：${detail}`,
          status: "cached",
        });
      }
      return errorResponse(502, error instanceof CostQueryError ? error.message : "Azure 成本查询失败", { detail });
    }
  }

  // task status only needs login (so background polling survives account deselection)
  const taskMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/task_status\/([0-9a-fA-F-]{36})$/)
    : null;
  if (taskMatch) {
    const task = await getTaskResponse(ENV, taskMatch[1]);
    if (!task) return errorResponse(404, "任务未找到");
    return jsonResponse(task);
  }

  // ---- account-scoped data routes ----
  // The account being read is named in the path, never taken from the session
  // cookie. A stale or reordered POST /api/session therefore cannot change which
  // account's machines a given request returns.
  const accountVmsMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/vms$/)
    : null;
  if (accountVmsMatch) {
    const accountId = accountVmsMatch[1];
    if (!(await getAccountById(ENV, accountId))) return errorResponse(404, "账户未找到");
    const force = url.searchParams.get("refresh") === "1";
    try {
      const snapshot = await getVmList(ENV, accountId, { force });
      const headers: Record<string, string> = {
        "x-account-id": accountId,
        "x-cache": snapshot.stale ? "stale" : snapshot.cached ? "hit" : "miss",
      };
      if (snapshot.warning) headers["x-refresh-warning"] = "1";
      return accountJson(accountId, snapshot.vms, { headers }, {
        cached: snapshot.cached,
        stale: snapshot.stale,
        warning: snapshot.warning,
        cacheAgeMs: Math.max(0, Date.now() - snapshot.fetchedAt),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return errorResponse(504, "Azure 查询超时，请稍后重试", {
          accountId,
          code: "azure_timeout",
          retryable: true,
        });
      }
      return errorResponse(400, formatAzureError(error), { accountId });
    }
  }

  const accountVmActionMatch = req.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/vm-action$/)
    : null;
  if (accountVmActionMatch) {
    const accountId = accountVmActionMatch[1];
    const account = await getAccountById(ENV, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    const body = await parseBody(req, vmActionSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = body.action === "delete"
      ? `已提交删除资源组 ${body.resourceGroup} 的任务`
      : `已提交 ${body.vmName} 的 ${body.action} 任务`;
    await createTask(ENV, { id: taskId, accountId, type: `vm.${body.action}`, lockKey: account.subscriptionId, createdBy: auth.actor, message: msg });
    startVmLifecycle(ENV, { taskId, accountId, actor: auth.actor, action: body.action, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ accountId, message: msg, taskId });
  }

  const accountChangeIpMatch = req.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/vm-change-ip$/)
    : null;
  if (accountChangeIpMatch) {
    const accountId = accountChangeIpMatch[1];
    const account = await getAccountById(ENV, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    const body = await parseBody(req, changeIpSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.vmName} 的更换公网 IP 任务`;
    await createTask(ENV, { id: taskId, accountId, type: "vm.change-ip", lockKey: account.subscriptionId, createdBy: auth.actor, message: msg });
    startChangeIp(ENV, { taskId, accountId, actor: auth.actor, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ accountId, message: msg, taskId });
  }

  const accountCreateVmMatch = req.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/create-vm$/)
    : null;
  if (accountCreateVmMatch) {
    const accountId = accountCreateVmMatch[1];
    const account = await getAccountById(ENV, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    const body = await parseBody(req, createVmSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.region} 区域的创建虚拟机任务`;
    await createTask(ENV, { id: taskId, accountId, type: "vm.create", lockKey: account.subscriptionId, createdBy: auth.actor, message: msg });
    startCreateVm(ENV, {
      taskId,
      accountId,
      actor: auth.actor,
      region: body.region,
      vmSize: body.vmSize,
      osImage: body.osImage,
      diskSize: body.diskSize,
      diskType: body.diskType,
      ipType: body.ipType,
      userData: body.userData ?? null,
      vmName: body.vmName ?? null,
      adminUsername: body.adminUsername ?? null,
      adminPassword: body.adminPassword ?? null,
      useGlobalSsh: body.useGlobalSsh,
      enableRoot: body.enableRoot,
      nsgEnabled: body.nsgEnabled,
      nsgPorts: body.nsgPorts,
      nsgOpenAllInbound: body.nsgOpenAllInbound,
      nsgOpenAllOutbound: body.nsgOpenAllOutbound,
    });
    return jsonResponse({ accountId, message: msg, taskId });
  }

  // Legacy account-free routes are gone on purpose: they resolved the account
  // from the session cookie, which is exactly what allowed one account's data to
  // be rendered for another. Fail loudly instead of silently answering wrong.
  if (
    url.pathname === "/api/vms"
    || url.pathname === "/api/vm-action"
    || url.pathname === "/api/vm-change-ip"
    || url.pathname === "/api/create-vm"
  ) {
    return errorResponse(410, "该接口已下线：账户身份现在必须显式出现在请求路径中，请刷新页面以加载最新前端。", {
      code: "route_gone",
    });
  }

  // Remaining session-scoped routes are read-only metadata for the create-VM
  // dialog. They are scheduled for the same explicit-account treatment; until
  // then the client guards against applying their answers to another account.
  const selectedId = auth.session.selectedAccountId;
  if (!selectedId) return errorResponse(403, "请先选择一个 Azure 账户");
  if (!(await getAccountById(ENV, selectedId))) {
    return errorResponse(404, "当前选择的 Azure 账户不存在");
  }

  if (req.method === "GET" && url.pathname === "/api/regions") {
    const account = await getDecryptedAccountOrThrow(ENV, selectedId);
    const client = new AzureArmClient(ENV, account);
    // Returns the deployable regions *and* why others were dropped, so the
    // create-VM dialog can show what the subscription/policy actually allows
    // instead of silently offering regions that cannot be used.
    const listing = await listDeployableLocations(client, account.subscriptionId);
    const { locations, ...filterMeta } = listing;
    return jsonResponse({ accountId: account.id, items: locations, ...filterMeta });
  }

  if (req.method === "GET" && url.pathname === "/api/ip-permission") {
    const location = (url.searchParams.get("location") || "").trim();
    if (!location) return errorResponse(400, "请提供 location 参数");
    const account = await getDecryptedAccountOrThrow(ENV, selectedId);
    const client = new AzureArmClient(ENV, account);
    return jsonResponse({ location, permission: await getIpPermission(client, account.subscriptionId, location) });
  }

  // VM sizes available in a specific region (live from Azure)
  if (req.method === "GET" && url.pathname === "/api/vm-sizes") {
    const location = (url.searchParams.get("location") || "").trim();
    if (!location) return errorResponse(400, "请提供 location 参数");
    try {
      const account = await getDecryptedAccountOrThrow(ENV, selectedId);
      const client = new AzureArmClient(ENV, account);
      const sizes = await listVmSizes(client, account.subscriptionId, location);
      return jsonResponse(sizes);
    } catch (error) {
      return errorResponse(400, formatAzureError(error));
    }
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    return jsonResponse(await listTasksForAccount(ENV, selectedId));
  }

  return errorResponse(404, "接口不存在");
}
