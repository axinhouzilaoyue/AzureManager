import type {
  AccountCheckResult,
  AppEnv,
  AuthContext,
  ChangeIpParams,
  DecryptedAccountRecord,
  CreateVmParams,
  JsonRecord,
  VmLifecycleParams,
  WorkflowBinding,
  WorkflowName,
} from "./types";
import { SubscriptionLock } from "./durable/subscriptionLock";
import { createLogoutCookie, createLoginCookie, createSelectionCookie, getAuthContext, requireAuth } from "./lib/auth";
import {
  accountNameExists,
  createAccount,
  deleteAccount,
  getAccountById,
  getGlobalStartupScript,
  listAccounts,
  setGlobalStartupScript,
  updateAccountMetadata,
} from "./lib/db";
import { listVirtualMachines } from "./lib/azure/compute";
import { AzureArmClient } from "./lib/azure/client";
import { getSubscriptionDetails, listSubscriptionLocations } from "./lib/azure/subscription";
import { enqueueTask, getTaskResponse, registerWorkflowInstance, taskFailed, taskLog, audit } from "./lib/tasks";
import { accountCheckSchema, createAccountSchema, createVmSchema, changeIpSchema, editAccountSchema, loginSchema, selectAccountSchema, updateStartupScriptSchema, vmActionSchema } from "./lib/validation";
import { getDecryptedAccountOrThrow } from "./lib/workflow-support";
import { errorResponse, jsonResponse, readJson } from "./lib/utils";
import { ChangeIpWorkflow } from "./workflows/changeIp";
import { CreateVmWorkflow } from "./workflows/createVm";
import { VmLifecycleWorkflow } from "./workflows/vmLifecycle";
import type { ZodType } from "zod";

export { SubscriptionLock, CreateVmWorkflow, VmLifecycleWorkflow, ChangeIpWorkflow };

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: env.APP_NAME,
          timestamp: new Date().toISOString(),
        });
      }

      if (url.pathname.startsWith("/auth/")) {
        return handleAuthRoutes(request, env, url);
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApiRoutes(request, env, url);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (isValidationError(error)) {
        return errorResponse(400, error.issues[0]?.message ?? "请求参数无效", {
          issues: error.issues,
        });
      }

      console.error("Unhandled request error", error);
      return errorResponse(500, "服务器内部错误", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

async function handleAuthRoutes(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/auth/login") {
    const existingAuth = await getAuthContext(env, request);
    const body = await parseRequestBody(request, loginSchema);
    if (body instanceof Response) {
      return body;
    }
    if (!env.APP_PASSWORD) {
      return errorResponse(500, "未配置 APP_PASSWORD，无法使用本地登录");
    }

    if (body.password !== env.APP_PASSWORD) {
      return errorResponse(401, "密码错误");
    }

    const cookie = await createLoginCookie(env, existingAuth.session);
    return jsonResponse(
      {
        success: true,
      },
      {
        headers: {
          "Set-Cookie": cookie,
        },
      },
    );
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    return jsonResponse(
      {
        success: true,
      },
      {
        headers: {
          "Set-Cookie": createLogoutCookie(),
        },
      },
    );
  }

  return errorResponse(404, "接口不存在");
}

async function parseRequestBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T | Response> {
  const payload = await readJson(request);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, parsed.error.issues[0]?.message ?? "请求参数无效", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function isValidationError(
  error: unknown,
): error is { issues: Array<{ message?: string }> } {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (!("issues" in error)) {
    return false;
  }

  return Array.isArray((error as { issues?: unknown }).issues);
}

function createEphemeralAccount(input: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  subscriptionId: string;
}): DecryptedAccountRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "account-check",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    expirationDate: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function buildAccountCheckResult(
  env: AppEnv,
  account: DecryptedAccountRecord,
): Promise<AccountCheckResult> {
  const client = new AzureArmClient(env, account);
  const subscription = await getSubscriptionDetails(client, account.subscriptionId);
  const regions = await listSubscriptionLocations(client, account.subscriptionId);

  return {
    subscriptionDisplayName: subscription.displayName,
    state: subscription.state,
    availableRegionCount: regions.length,
    warnings: [],
    checkedAt: new Date().toISOString(),
  };
}

function formatAccountCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("azure_auth_failed:")) {
    return "Azure 认证失败，请检查客户端 ID、客户端密码和租户 ID 是否正确。";
  }

  if (message.includes("SubscriptionNotFound")) {
    return "订阅不存在，或当前服务主体无权访问该订阅。";
  }

  if (message.includes("AuthorizationFailed")) {
    return "凭据有效，但当前服务主体没有足够的订阅权限。";
  }

  if (message.includes("account_not_found")) {
    return "账户不存在。";
  }

  if (message.startsWith("azure_arm_request_failed:403:")) {
    return "Azure API 已鉴权，但请求被拒绝。请确认该服务主体至少拥有订阅读取权限，创建资源建议使用测试订阅上的 Contributor。";
  }

  if (message.startsWith("azure_arm_request_failed:404:")) {
    return "Azure API 返回 404，请检查订阅 ID、租户和当前目录是否匹配。";
  }

  return "Azure 检查失败，请确认订阅 ID、租户、服务主体权限以及当前目录是否正确。";
}

async function handleApiRoutes(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/session") {
    const auth = await getAuthContext(env, request);
    const selectedAccount =
      auth.session.selectedAccountId !== null
        ? await getAccountById(env, auth.session.selectedAccountId)
        : null;

    return jsonResponse({
      loggedIn: auth.authenticated,
      selectedAccountId: selectedAccount?.id ?? null,
      selectedAccountName: selectedAccount?.name ?? null,
    });
  }

  const auth = await requireAuth(env, request);
  if (auth instanceof Response) {
    return auth;
  }

  if (request.method === "POST" && url.pathname === "/api/session") {
    const body = await parseRequestBody(request, selectAccountSchema);
    if (body instanceof Response) {
      return body;
    }
    if (body.accountId) {
      const account = await getAccountById(env, body.accountId);
      if (!account) {
        return errorResponse(404, "账户未找到");
      }
    }

    const cookie = await createSelectionCookie(env, request, body.accountId);
    return jsonResponse(
      {
        success: true,
        selectedAccountId: body.accountId,
      },
      {
        headers: {
          "Set-Cookie": cookie,
        },
      },
    );
  }

  if (request.method === "DELETE" && url.pathname === "/api/session") {
    const cookie = await createSelectionCookie(env, request, null);
    return jsonResponse(
      {
        success: true,
      },
      {
        headers: {
          "Set-Cookie": cookie,
        },
      },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/accounts") {
    return jsonResponse(await listAccounts(env));
  }

  if (request.method === "GET" && url.pathname === "/api/settings/startup-script") {
    return jsonResponse({
      userData: await getGlobalStartupScript(env),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/settings/startup-script") {
    const body = await parseRequestBody(request, updateStartupScriptSchema);
    if (body instanceof Response) {
      return body;
    }

    await setGlobalStartupScript(env, {
      userData: body.userData,
      updatedBy: auth.actor,
    });
    await audit(env, {
      actor: auth.actor,
      action: "setting.updated",
      targetType: "app_setting",
      targetId: "global_startup_script",
      metadata: {
        size: body.userData.length,
      },
    });

    return jsonResponse({
      success: true,
      userData: body.userData,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/accounts/check") {
    const body = await parseRequestBody(request, accountCheckSchema);
    if (body instanceof Response) {
      return body;
    }

    try {
      const result = await buildAccountCheckResult(env, createEphemeralAccount(body));
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(400, formatAccountCheckError(error));
    }
  }

  if (request.method === "POST" && url.pathname === "/api/accounts") {
    const body = await parseRequestBody(request, createAccountSchema);
    if (body instanceof Response) {
      return body;
    }
    if (await accountNameExists(env, body.name)) {
      return errorResponse(409, "账户名称已存在");
    }

    const created = await createAccount(env, {
      id: crypto.randomUUID(),
      name: body.name,
      clientId: body.clientId,
      tenantId: body.tenantId,
      subscriptionId: body.subscriptionId,
      clientSecret: body.clientSecret,
      expirationDate: body.expirationDate,
    });

    await audit(env, {
      actor: auth.actor,
      action: "account.created",
      targetType: "account",
      targetId: created.id,
      metadata: {
        name: created.name,
        subscriptionId: created.subscriptionId,
      },
    });

    return jsonResponse(created, { status: 201 });
  }

  if (request.method === "POST" && url.pathname === "/api/accounts/edit") {
    const body = await parseRequestBody(request, editAccountSchema);
    if (body instanceof Response) {
      return body;
    }
    const account = await getAccountById(env, body.accountId);
    if (!account) {
      return errorResponse(404, "账户未找到");
    }

    if (await accountNameExists(env, body.newName, body.accountId)) {
      return errorResponse(409, "新的账户名称已存在");
    }

    await updateAccountMetadata(env, {
      accountId: body.accountId,
      newName: body.newName,
      expirationDate: body.expirationDate,
    });

    await audit(env, {
      actor: auth.actor,
      action: "account.updated",
      targetType: "account",
      targetId: body.accountId,
      metadata: {
        newName: body.newName,
        expirationDate: body.expirationDate,
      },
    });

    let responseHeaders: HeadersInit | undefined;
    if (auth.session.selectedAccountId === body.accountId) {
      responseHeaders = {
        "Set-Cookie": await createSelectionCookie(env, request, body.accountId),
      };
    }

    return jsonResponse(
      {
        success: true,
      },
      {
        headers: responseHeaders,
      },
    );
  }

  const accountCheckMatch = request.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/check$/)
    : null;
  if (accountCheckMatch) {
    try {
      const account = await getDecryptedAccountOrThrow(env, accountCheckMatch[1]);
      return jsonResponse(await buildAccountCheckResult(env, account));
    } catch (error) {
      return errorResponse(400, formatAccountCheckError(error));
    }
  }

  const accountDeleteMatch = request.method === "DELETE"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})$/)
    : null;
  if (accountDeleteMatch) {
    const accountId = accountDeleteMatch[1];
    const account = await getAccountById(env, accountId);
    if (!account) {
      return errorResponse(404, "账户未找到");
    }

    await deleteAccount(env, accountId);
    await audit(env, {
      actor: auth.actor,
      action: "account.deleted",
      targetType: "account",
      targetId: accountId,
      metadata: {
        name: account.name,
      },
    });

    const headers: HeadersInit = {};
    if (auth.session.selectedAccountId === accountId) {
      headers["Set-Cookie"] = await createSelectionCookie(env, request, null);
    }

    return jsonResponse(
      {
        success: true,
      },
      {
        headers,
      },
    );
  }

  const selectedAccountId = auth.session.selectedAccountId;
  if (!selectedAccountId) {
    return errorResponse(403, "请先选择一个 Azure 账户");
  }

  const selectedAccount = await getAccountById(env, selectedAccountId);
  if (!selectedAccount) {
    return errorResponse(404, "当前选择的 Azure 账户不存在");
  }

  if (request.method === "GET" && url.pathname === "/api/regions") {
    const account = await getDecryptedAccountOrThrow(env, selectedAccountId);
    const client = new AzureArmClient(env, account);
    const regions = await listSubscriptionLocations(client, account.subscriptionId);
    return jsonResponse(
      regions.sort((left, right) => left.displayName.localeCompare(right.displayName)),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/vms") {
    const account = await getDecryptedAccountOrThrow(env, selectedAccountId);
    const client = new AzureArmClient(env, account);
    const virtualMachines = await listVirtualMachines(client, account.subscriptionId);
    return jsonResponse(virtualMachines);
  }

  if (request.method === "POST" && url.pathname === "/api/vm-action") {
    const body = await parseRequestBody(request, vmActionSchema);
    if (body instanceof Response) {
      return body;
    }
    return enqueueAndStartTask(env, {
      accountId: selectedAccountId,
      actor: auth.actor,
      workflowName: "vm-lifecycle-workflow",
      taskType: `vm.${body.action}`,
      lockKey: selectedAccount.subscriptionId,
      params: {
        taskId: crypto.randomUUID(),
        accountId: selectedAccountId,
        actor: auth.actor,
        action: body.action,
        resourceGroup: body.resourceGroup,
        vmName: body.vmName,
      } satisfies VmLifecycleParams,
      workflowBinding: env.VM_LIFECYCLE_WORKFLOW,
      queuedMessage:
        body.action === "delete"
          ? `已提交删除资源组 ${body.resourceGroup} 的任务`
          : `已提交 ${body.vmName} 的 ${body.action} 任务`,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/vm-change-ip") {
    const body = await parseRequestBody(request, changeIpSchema);
    if (body instanceof Response) {
      return body;
    }
    return enqueueAndStartTask(env, {
      accountId: selectedAccountId,
      actor: auth.actor,
      workflowName: "change-ip-workflow",
      taskType: "vm.change-ip",
      lockKey: selectedAccount.subscriptionId,
      params: {
        taskId: crypto.randomUUID(),
        accountId: selectedAccountId,
        actor: auth.actor,
        resourceGroup: body.resourceGroup,
        vmName: body.vmName,
      } satisfies ChangeIpParams,
      workflowBinding: env.CHANGE_IP_WORKFLOW,
      queuedMessage: `已提交 ${body.vmName} 的更换公网 IP 任务`,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/create-vm") {
    const body = await parseRequestBody(request, createVmSchema);
    if (body instanceof Response) {
      return body;
    }
    return enqueueAndStartTask(env, {
      accountId: selectedAccountId,
      actor: auth.actor,
      workflowName: "create-vm-workflow",
      taskType: "vm.create",
      lockKey: selectedAccount.subscriptionId,
      params: {
        taskId: crypto.randomUUID(),
        accountId: selectedAccountId,
        actor: auth.actor,
        region: body.region,
        vmSize: body.vmSize,
        osImage: body.osImage,
        diskSize: body.diskSize,
        ipType: body.ipType,
        userData: body.userData,
      } satisfies CreateVmParams,
      workflowBinding: env.CREATE_VM_WORKFLOW,
      queuedMessage: `已提交 ${body.region} 区域的创建虚拟机任务`,
    });
  }

  const taskMatch = request.method === "GET"
    ? url.pathname.match(/^\/api\/task_status\/([0-9a-fA-F-]{36})$/)
    : null;
  if (taskMatch) {
    const task = await getTaskResponse(env, taskMatch[1]);
    if (!task) {
      return errorResponse(404, "任务未找到");
    }
    return jsonResponse(task);
  }

  return errorResponse(404, "接口不存在");
}

async function enqueueAndStartTask<TParams extends { taskId: string }>(
  env: AppEnv,
  input: {
    accountId: string;
    actor: string;
    workflowName: WorkflowName;
    workflowBinding: WorkflowBinding<TParams>;
    taskType: string;
    lockKey: string;
    params: TParams;
    queuedMessage: string;
  },
): Promise<Response> {
  await enqueueTask(env, {
    id: input.params.taskId,
    accountId: input.accountId,
    type: input.taskType,
    workflowName: input.workflowName,
    lockKey: input.lockKey,
    createdBy: input.actor,
    message: input.queuedMessage,
  });

  try {
    const instance = await input.workflowBinding.create({
      id: input.params.taskId,
      params: input.params,
    });

    await registerWorkflowInstance(env, input.params.taskId, instance.id);
    await audit(env, {
      actor: input.actor,
      action: "task.enqueued",
      targetType: "task",
      targetId: input.params.taskId,
      metadata: {
        workflowName: input.workflowName,
        taskType: input.taskType,
        accountId: input.accountId,
      },
    });

    return jsonResponse({
      message: input.queuedMessage,
      taskId: input.params.taskId,
      workflowInstanceId: instance.id,
    });
  } catch (error) {
    await taskLog(
      env,
      input.params.taskId,
      "workflow",
      error instanceof Error ? error.message : String(error),
      null,
      "error",
    );
    await taskFailed(env, input.params.taskId, {
      message: "任务提交到 Workflow 失败",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
