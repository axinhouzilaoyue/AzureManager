import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { AppEnv } from "./types";
import { createLogoutCookie, createLoginCookie, createSelectionCookie, getAuthContext, requireAuth } from "./lib/auth";
import {
  accountNameExists,
  createAccount,
  createTask,
  deleteAccount,
  getAccountById,
  getGlobalStartupScript,
  getTaskResponse,
  initializeDatabase,
  listAccounts,
  setGlobalStartupScript,
  updateAccountMetadata,
  writeAuditEvent,
} from "./lib/db";
import { startChangeIp, startCreateVm, startVmLifecycle } from "./lib/background";
import { AzureArmClient } from "./lib/azure/client";
import { listVirtualMachines } from "./lib/azure/compute";
import { getSubscriptionDetails, listSubscriptionLocations } from "./lib/azure/subscription";
import { getDecryptedAccountOrThrow } from "./lib/workflow-support";
import {
  accountCheckSchema,
  changeIpSchema,
  createAccountSchema,
  createVmSchema,
  editAccountSchema,
  loginSchema,
  selectAccountSchema,
  updateStartupScriptSchema,
  vmActionSchema,
} from "./lib/validation";
import { errorResponse, jsonResponse, readJson } from "./lib/utils";
import type { ZodType } from "zod";

// ---- env bootstrap ----
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

mkdirSync("data", { recursive: true });
const db = new Database("data/azure-manager.db");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
initializeDatabase(db);

const ENV: AppEnv = {
  APP_NAME: process.env.APP_NAME ?? "Azure VM Management Panel",
  APP_PASSWORD: requireEnv("APP_PASSWORD"),
  SESSION_SECRET: requireEnv("SESSION_SECRET"),
  ACCOUNT_ENCRYPTION_KEY: requireEnv("ACCOUNT_ENCRYPTION_KEY"),
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
  return new Response(Bun.file(path), { headers: { "content-type": contentType } });
}

function formatAzureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("azure_auth_failed:")) return "Azure 认证失败，请检查客户端 ID、客户端密码和租户 ID 是否正确。";
  if (message.includes("SubscriptionNotFound")) return "订阅不存在，或当前服务主体无权访问该订阅。";
  if (message.includes("AuthorizationFailed")) return "凭据有效，但当前服务主体没有足够的订阅权限。";
  if (message.includes("account_not_found")) return "账户不存在。";
  return "Azure 检查失败，请确认订阅 ID、租户、服务主体权限以及当前目录是否正确。";
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
        expirationDate: null,
        createdAt: "",
        updatedAt: "",
      };
      const client = new AzureArmClient(ENV, tempAccount);
      const sub = await getSubscriptionDetails(client, body.subscriptionId);
      const regions = await listSubscriptionLocations(client, body.subscriptionId);
      return jsonResponse({ subscriptionDisplayName: sub.displayName, state: sub.state, availableRegionCount: regions.length, warnings: [], checkedAt: new Date().toISOString() });
    } catch (error) {
      return errorResponse(400, formatAzureError(error));
    }
  }

  // create account
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await parseBody(req, createAccountSchema);
    if (body instanceof Response) return body;
    if (await accountNameExists(ENV, body.name)) return errorResponse(409, "账户名称已存在");
    const created = await createAccount(ENV, { id: crypto.randomUUID(), ...body });
    await writeAuditEvent(ENV, { actor: auth.actor, action: "account.created", targetType: "account", targetId: created.id, metadata: { name: created.name } });
    return jsonResponse(created, { status: 201 });
  }

  // edit account
  if (req.method === "POST" && url.pathname === "/api/accounts/edit") {
    const body = await parseBody(req, editAccountSchema);
    if (body instanceof Response) return body;
    if (!(await getAccountById(ENV, body.accountId))) return errorResponse(404, "账户未找到");
    if (await accountNameExists(ENV, body.newName, body.accountId)) return errorResponse(409, "新的账户名称已存在");
    await updateAccountMetadata(ENV, { accountId: body.accountId, newName: body.newName, expirationDate: body.expirationDate ?? null });
    await writeAuditEvent(ENV, { actor: auth.actor, action: "account.updated", targetType: "account", targetId: body.accountId });
    let headers: HeadersInit | undefined;
    if (auth.session.selectedAccountId === body.accountId) {
      headers = { "Set-Cookie": await createSelectionCookie(ENV, req, body.accountId) };
    }
    return jsonResponse({ success: true }, { headers });
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
      const regions = await listSubscriptionLocations(client, account.subscriptionId);
      return jsonResponse({ subscriptionDisplayName: sub.displayName, state: sub.state, availableRegionCount: regions.length, warnings: [], checkedAt: new Date().toISOString() });
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
    await writeAuditEvent(ENV, { actor: auth.actor, action: "account.deleted", targetType: "account", targetId: deleteMatch[1] });
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
    await createTask(ENV, { id: taskId, accountId: selectedId, type: `vm.${body.action}`, workflowName: "vm-lifecycle-workflow", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: msg });
    startVmLifecycle(ENV, { taskId, accountId: selectedId, actor: auth.actor, action: body.action, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ message: msg, taskId });
  }

  if (req.method === "POST" && url.pathname === "/api/vm-change-ip") {
    const body = await parseBody(req, changeIpSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.vmName} 的更换公网 IP 任务`;
    await createTask(ENV, { id: taskId, accountId: selectedId, type: "vm.change-ip", workflowName: "change-ip-workflow", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: msg });
    startChangeIp(ENV, { taskId, accountId: selectedId, actor: auth.actor, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ message: msg, taskId });
  }

  if (req.method === "POST" && url.pathname === "/api/create-vm") {
    const body = await parseBody(req, createVmSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.region} 区域的创建虚拟机任务`;
    await createTask(ENV, { id: taskId, accountId: selectedId, type: "vm.create", workflowName: "create-vm-workflow", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: msg });
    startCreateVm(ENV, { taskId, accountId: selectedId, actor: auth.actor, region: body.region, vmSize: body.vmSize, osImage: body.osImage, diskSize: body.diskSize, ipType: body.ipType, userData: body.userData ?? null });
    return jsonResponse({ message: msg, taskId });
  }

  const taskMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/task_status\/([0-9a-fA-F-]{36})$/)
    : null;
  if (taskMatch) {
    const task = await getTaskResponse(ENV, taskMatch[1]);
    if (!task) return errorResponse(404, "任务未找到");
    return jsonResponse(task);
  }

  return errorResponse(404, "接口不存在");
}
