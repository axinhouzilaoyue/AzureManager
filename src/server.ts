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
  updateAccountInsights,
  updateAccountMetadata,
} from "./lib/db";
import { startChangeIp, startCreateVm, startVmLifecycle } from "./lib/background";
import { AzureArmClient } from "./lib/azure/client";
import { listVirtualMachines, listVmSizes } from "./lib/azure/compute";
import { getAzureCosts, getQuotaTier } from "./lib/azure/cost";
import { getIpPermission } from "./lib/azure/network";
import { getSubscriptionDetails, listSubscriptionLocations, registerRequiredProviders } from "./lib/azure/subscription";
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
import { errorResponse, jsonResponse, readJson } from "./lib/utils";
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

  // session account selection
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

  // cross-account VM fleet for overview page
  if (req.method === "GET" && url.pathname === "/api/overview/vms") {
    const accounts = await listAccounts(ENV);
    const chunks = await Promise.all(
      accounts.map(async (account) => {
        try {
          const decrypted = await getDecryptedAccountOrThrow(ENV, account.id);
          const client = new AzureArmClient(ENV, decrypted);
          const vms = await listVirtualMachines(client, decrypted.subscriptionId);
          const accountLabel = (account.email || account.name || "未命名账户").trim();
          return vms.map((vm) => ({
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
        } catch {
          return [] as Array<Record<string, unknown>>;
        }
      }),
    );
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
      items,
    });
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
        createdAt: "",
        updatedAt: "",
      };
      const client = new AzureArmClient(ENV, tempAccount);
      const sub = await getSubscriptionDetails(client, body.subscriptionId);
      const [regions, providerWarnings] = await Promise.all([
        listSubscriptionLocations(client, body.subscriptionId),
        registerRequiredProviders(client, body.subscriptionId),
      ]);
      return jsonResponse({
        subscriptionDisplayName: sub.displayName,
        state: sub.state,
        availableRegionCount: regions.length,
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
    if (!(await getAccountById(ENV, body.accountId))) return errorResponse(404, "账户未找到");
    if (await accountNameExists(ENV, body.newName, body.accountId)) return errorResponse(409, "新的账户名称已存在");
    await updateAccountMetadata(ENV, {
      accountId: body.accountId,
      newName: body.newName,
      email: body.email ?? null,
      expirationDate: body.expirationDate ?? null,
    });
    let headers: HeadersInit | undefined;
    if (auth.session.selectedAccountId === body.accountId) {
      headers = { "Set-Cookie": await createSelectionCookie(ENV, req, body.accountId) };
    }
    return jsonResponse({ success: true }, { headers });
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
      const [sub, vms, quotaTier] = await Promise.all([
        getSubscriptionDetails(client, account.subscriptionId),
        listVirtualMachines(client, account.subscriptionId),
        getQuotaTier(client, account.subscriptionId),
      ]);
      await updateAccountInsights(ENV, {
        accountId: account.id,
        subscriptionName: sub.displayName,
        subscriptionState: sub.state,
        quotaTier,
      });
      return jsonResponse({
        id: account.id,
        subscriptionDisplayName: sub.displayName,
        state: sub.state,
        vmCount: vms.length,
        quotaTier,
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
      const [regions, quotaTier, providerWarnings] = await Promise.all([
        listSubscriptionLocations(client, account.subscriptionId),
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
        availableRegionCount: regions.length,
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
    const account = await getAccountById(ENV, deleteMatch[1]);
    if (!account) return errorResponse(404, "账户未找到");
    await deleteAccount(ENV, deleteMatch[1]);
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

  const costMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/cost$/)
    : null;
  if (costMatch) {
    const accountId = costMatch[1];
    const account = await getDecryptedAccountOrThrow(ENV, accountId).catch(() => null);
    if (!account) return errorResponse(404, "账户未找到");
    const client = new AzureArmClient(ENV, account);
    try {
      const cost = await getAzureCosts(client, account.subscriptionId, account.expirationDate);
      await updateAccountCost(ENV, accountId, cost);
      return jsonResponse({ success: true, cached: false, ...cost });
    } catch (error) {
      const cached = account.costMtd !== null;
      const detail = error instanceof Error ? error.message : String(error);
      if (cached) {
        return jsonResponse({
          success: true,
          cached: true,
          mtd: account.costMtd,
          acc: account.costAcc,
          history: account.costHistory,
          currency: account.costCurrency ?? "",
          queriedAt: account.costUpdatedAt,
          warning: `实时查询失败，已显示缓存：${detail}`,
        });
      }
      return errorResponse(502, "Azure 成本查询失败", { detail });
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

  // routes requiring selected account
  const selectedId = auth.session.selectedAccountId;
  if (!selectedId) return errorResponse(403, "请先选择一个 Azure 账户");
  const selectedAccount = await getAccountById(ENV, selectedId);
  if (!selectedAccount) return errorResponse(404, "当前选择的 Azure 账户不存在");

  if (req.method === "GET" && url.pathname === "/api/regions") {
    const account = await getDecryptedAccountOrThrow(ENV, selectedId);
    const client = new AzureArmClient(ENV, account);
    const regions = await listSubscriptionLocations(client, account.subscriptionId);
    return jsonResponse(regions.sort((a, b) => a.displayName.localeCompare(b.displayName)));
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

  if (req.method === "GET" && url.pathname === "/api/vms") {
    const account = await getDecryptedAccountOrThrow(ENV, selectedId);
    const client = new AzureArmClient(ENV, account);
    return jsonResponse(await listVirtualMachines(client, account.subscriptionId));
  }

  if (req.method === "POST" && url.pathname === "/api/vm-action") {
    const body = await parseBody(req, vmActionSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = body.action === "delete"
      ? `已提交删除资源组 ${body.resourceGroup} 的任务`
      : `已提交 ${body.vmName} 的 ${body.action} 任务`;
    await createTask(ENV, { id: taskId, accountId: selectedId, type: `vm.${body.action}`, lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: msg });
    startVmLifecycle(ENV, { taskId, accountId: selectedId, actor: auth.actor, action: body.action, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ message: msg, taskId });
  }

  if (req.method === "POST" && url.pathname === "/api/vm-change-ip") {
    const body = await parseBody(req, changeIpSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.vmName} 的更换公网 IP 任务`;
    await createTask(ENV, { id: taskId, accountId: selectedId, type: "vm.change-ip", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: msg });
    startChangeIp(ENV, { taskId, accountId: selectedId, actor: auth.actor, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ message: msg, taskId });
  }

  if (req.method === "POST" && url.pathname === "/api/create-vm") {
    const body = await parseBody(req, createVmSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.region} 区域的创建虚拟机任务`;
    await createTask(ENV, { id: taskId, accountId: selectedId, type: "vm.create", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: msg });
    startCreateVm(ENV, {
      taskId,
      accountId: selectedId,
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
    return jsonResponse({ message: msg, taskId });
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    return jsonResponse(await listTasksForAccount(ENV, selectedId));
  }

  return errorResponse(404, "接口不存在");
}
