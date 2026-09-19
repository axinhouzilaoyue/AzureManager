import type { AppEnv } from "../types";
import { createSelectionCookie, getAuthContext, requireAuth } from "../lib/auth";
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
  listAccountOperationLogs,
  listAccounts,
  reorderAccounts,
  setGlobalSshSettings,
  setGlobalStartupScript,
  updateAccountCost,
  updateAccountCredentials,
  updateAccountInsights,
} from "../lib/db";
import { startChangeIp, startCreateVm, startVmLifecycle } from "../lib/background";
import { AzureArmClient } from "../lib/azure/client";
import { countVirtualMachines, listVmSizes } from "../lib/azure/compute";
import {
  getVmCacheStats,
  getVmList,
  invalidateVmList,
  resetVmCache,
} from "../lib/azure/vm-cache";
import {
  invalidateAzureAccessToken,
  resetAzureTokenCache,
} from "../lib/azure/token-cache";
import { CostQueryError, getAzureCosts, getQuotaTier } from "../lib/azure/cost";
import { getIpPermission } from "../lib/azure/network";
import { getSubscriptionDetails, listDeployableLocations, registerRequiredProviders } from "../lib/azure/subscription";
import {
  accountCheckSchema,
  changeIpSchema,
  createAccountSchema,
  createVmSchema,
  editAccountSchema,
  importAccountsSchema,
  reorderAccountsSchema,
  selectAccountSchema,
  updateGlobalSshSchema,
  updateStartupScriptSchema,
  vmActionSchema,
} from "../lib/validation";
import { accountJson, errorResponse, jsonResponse } from "../lib/utils";
import { exportPayload, normalizeImportedAccounts } from "../lib/account-io";
import {
  BULK_REFRESH_CONCURRENCY,
  OVERVIEW_ACCOUNT_CONCURRENCY,
  formatAzureError,
  isTimeoutError,
  mapWithConcurrency,
  messageOf,
  parseBody,
} from "../lib/http-helpers";

export async function handleApi(env: AppEnv, req: Request, url: URL): Promise<Response> {
  // session info (public)
  if (req.method === "GET" && url.pathname === "/api/session") {
    const auth = await getAuthContext(env, req);
    const selected = auth.session.selectedAccountId
      ? await getAccountById(env, auth.session.selectedAccountId)
      : null;
    return jsonResponse({
      loggedIn: auth.authenticated,
      selectedAccountId: selected?.id ?? null,
      selectedAccountName: selected?.name ?? null,
    });
  }

  const auth = await requireAuth(env, req);
  if (auth instanceof Response) return auth;

  // session account selection.
  // UI memory only ("which account was I last looking at"). It MUST NOT be read
  // to decide whose data a request returns — account identity belongs in the
  // request path (see the account-scoped routes below). A reordered or stale
  // write here can therefore never change what data a request gets back.
  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await parseBody(req, selectAccountSchema);
    if (body instanceof Response) return body;
    if (body.accountId && !(await getAccountById(env, body.accountId))) return errorResponse(404, "账户未找到");
    const cookie = await createSelectionCookie(env, req, body.accountId);
    return jsonResponse({ success: true, selectedAccountId: body.accountId }, { headers: { "Set-Cookie": cookie } });
  }
  if (req.method === "DELETE" && url.pathname === "/api/session") {
    const cookie = await createSelectionCookie(env, req, null);
    return jsonResponse({ success: true }, { headers: { "Set-Cookie": cookie } });
  }

  // accounts list
  if (req.method === "GET" && url.pathname === "/api/accounts") {
    return jsonResponse(await listAccounts(env));
  }

  if (req.method === "GET" && url.pathname === "/api/accounts/export") {
    const includeSecrets = url.searchParams.get("includeSecrets") === "true";
    const accounts = await listAccounts(env);
    const exported = await Promise.all(accounts.map(async (account) => {
      const decrypted = await getDecryptedAccountById(env, account.id);
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
      if (await accountNameExists(env, parsed.data.name)) {
        skipped.push({ name: parsed.data.name, reason: "账户名称已存在" });
        continue;
      }
      await createAccount(env, {
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
    await reorderAccounts(env, body.accountIds);
    return jsonResponse({ success: true });
  }

  // Refresh every account's data in one action: VM list, subscription/quota
  // insights and cost. Bounded concurrency keeps a large fleet from saturating
  // the egress or tripping ARM throttling, and per-account failures are reported
  // instead of aborting the whole batch.
  if (req.method === "POST" && url.pathname === "/api/accounts/refresh-all") {
    const accounts = await listAccounts(env);
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
        decrypted = await getDecryptedAccountOrThrow(env, account.id);
      } catch (error) {
        return { ...summary, ok: false, errors: [messageOf(error)], warnings };
      }
      const client = new AzureArmClient(env, decrypted);

      try {
        const snapshot = await getVmList(env, account.id, { force: true });
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
        await updateAccountInsights(env, {
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
        await updateAccountCost(env, account.id, cost);
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
    const accounts = await listAccounts(env);
    const degradedAccountIds: string[] = [];
    // Default path reuses the per-account TTL cache. `?refresh=1` forces upstream.
    const force = url.searchParams.get("refresh") === "1";
    // Reuses the same per-account cache the account workspace reads, and bounds
    // concurrency so a large fleet cannot saturate the egress or trip ARM throttling.
    const chunks = await mapWithConcurrency(accounts, OVERVIEW_ACCOUNT_CONCURRENCY, async (account) => {
      try {
        const snapshot = await getVmList(env, account.id, { force });
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
      const client = new AzureArmClient(env, tempAccount);
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
    if (await accountNameExists(env, body.name)) return errorResponse(409, "账户名称已存在");
    const created = await createAccount(env, {
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
    const existing = await getDecryptedAccountById(env, body.accountId);
    if (!existing) return errorResponse(404, "账户未找到");
    if (await accountNameExists(env, body.newName, body.accountId)) return errorResponse(409, "新的账户名称已存在");

    const clientId = body.clientId ?? existing.clientId;
    const tenantId = body.tenantId ?? existing.tenantId;
    const subscriptionId = body.subscriptionId ?? existing.subscriptionId;
    const credentialsChanged = clientId !== existing.clientId
      || tenantId !== existing.tenantId
      || subscriptionId !== existing.subscriptionId
      || Boolean(body.clientSecret);

    await updateAccountCredentials(env, {
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
      headers = { "Set-Cookie": await createSelectionCookie(env, req, body.accountId) };
    }
    return jsonResponse({ success: true, credentialsChanged }, { headers });
  }

  // One-shot card payload: insights + cost without forcing the client to fan out.
  const summaryMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/summary$/)
    : null;
  if (summaryMatch) {
    const accountId = summaryMatch[1];
    const force = url.searchParams.get("refresh") === "1";
    try {
      const account = await getDecryptedAccountOrThrow(env, accountId);
      const client = new AzureArmClient(env, account);
      void registerRequiredProviders(client, account.subscriptionId).catch((error) => {
        console.warn("Provider registration skipped", account.id, error);
      });

      const [subResult, vmsResult, quotaResult, costResult] = await Promise.allSettled([
        getSubscriptionDetails(client, account.subscriptionId),
        countVirtualMachines(client, account.subscriptionId),
        getQuotaTier(client, account.subscriptionId),
        getAzureCosts(
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
          force ? undefined : { maxAttempts: 2, cooldownMs: 0 },
        ),
      ]);

      const sub = subResult.status === "fulfilled" ? subResult.value : null;
      const vmCount = vmsResult.status === "fulfilled" ? vmsResult.value : null;
      const quotaTier = quotaResult.status === "fulfilled"
        ? quotaResult.value
        : (account.quotaTier ?? "未获取");

      await updateAccountInsights(env, {
        accountId,
        subscriptionName: sub?.displayName ?? account.subscriptionName,
        subscriptionState: sub?.state ?? account.subscriptionState,
        quotaTier,
      });

      let cost: {
        mtd: string | null;
        acc: string | null;
        history: string | null;
        currency: string | null;
        queriedAt: string | null;
        warning: string | null;
        status: string | null;
        cached: boolean;
      } | null = null;

      if (costResult.status === "fulfilled") {
        const value = costResult.value;
        await updateAccountCost(env, accountId, value);
        cost = {
          mtd: value.mtd,
          acc: value.acc,
          history: value.history,
          currency: value.currency,
          queriedAt: value.queriedAt,
          warning: value.warning,
          status: value.status ?? (value.warning ? "cached" : "ok"),
          cached: value.status !== "ok" && value.status !== undefined,
        };
      } else if (account.costMtd !== null) {
        cost = {
          mtd: account.costMtd,
          acc: account.costAcc,
          history: account.costHistory,
          currency: account.costCurrency,
          queriedAt: account.costUpdatedAt,
          warning: `实时查询失败，已显示缓存：${messageOf(costResult.reason)}`,
          status: "cached",
          cached: true,
        };
      }

      return accountJson(accountId, {
        id: accountId,
        subscriptionDisplayName: sub?.displayName ?? account.subscriptionName ?? account.subscriptionId,
        state: sub?.state ?? account.subscriptionState ?? "Unknown",
        vmCount: vmCount ?? 0,
        quotaTier,
        cost,
        vmError: vmsResult.status === "rejected" ? messageOf(vmsResult.reason) : null,
        subscriptionError: subResult.status === "rejected" ? messageOf(subResult.reason) : null,
        costError: costResult.status === "rejected" && account.costMtd === null
          ? messageOf(costResult.reason)
          : null,
      }, { headers: { "x-account-id": accountId } });
    } catch (error) {
      return errorResponse(400, formatAzureError(error), { accountId });
    }
  }

  // Quota tier only: one lightweight ARM call, so the insights bar can refresh
  // just the quota figure without re-pulling VMs or cost.
  const quotaMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/quota$/)
    : null;
  if (quotaMatch) {
    const accountId = quotaMatch[1];
    try {
      const account = await getDecryptedAccountOrThrow(env, accountId);
      const client = new AzureArmClient(env, account);
      const quotaTier = await getQuotaTier(client, account.subscriptionId);
      await updateAccountInsights(env, {
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
      const account = await getDecryptedAccountOrThrow(env, overviewMatch[1]);
      const client = new AzureArmClient(env, account);
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
      await updateAccountInsights(env, {
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
      const account = await getDecryptedAccountOrThrow(env, checkMatch[1]);
      const client = new AzureArmClient(env, account);
      const sub = await getSubscriptionDetails(client, account.subscriptionId);
      const [regionListing, quotaTier, providerWarnings] = await Promise.all([
        listDeployableLocations(client, account.subscriptionId),
        getQuotaTier(client, account.subscriptionId),
        registerRequiredProviders(client, account.subscriptionId),
      ]);
      await updateAccountInsights(env, {
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
    const account = await getDecryptedAccountById(env, deleteMatch[1]);
    if (!account) return errorResponse(404, "账户未找到");
    await deleteAccount(env, deleteMatch[1]);
    invalidateVmList(deleteMatch[1], "account_deleted");
    await invalidateAzureAccessToken(account, "account_deleted");
    const headers: HeadersInit = {};
    if (auth.session.selectedAccountId === deleteMatch[1]) {
      headers["Set-Cookie"] = await createSelectionCookie(env, req, null);
    }
    return jsonResponse({ success: true }, { headers });
  }

  // startup script
  if (req.method === "GET" && url.pathname === "/api/settings/startup-script") {
    return jsonResponse({ userData: await getGlobalStartupScript(env) });
  }
  if (req.method === "POST" && url.pathname === "/api/settings/startup-script") {
    const body = await parseBody(req, updateStartupScriptSchema);
    if (body instanceof Response) return body;
    await setGlobalStartupScript(env, { userData: body.userData, updatedBy: auth.actor });
    return jsonResponse({ success: true, userData: body.userData });
  }

  if (req.method === "GET" && url.pathname === "/api/settings/global-ssh") {
    const settings = await getGlobalSshSettings(env);
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
    await setGlobalSshSettings(env, {
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
    const account = await getDecryptedAccountById(env, detailMatch[1]);
    if (!account) return errorResponse(404, "账户未找到");
    return jsonResponse(exportPayload(account, true));
  }

  const costMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/cost$/)
    : null;
  if (costMatch) {
    const accountId = costMatch[1];
    const account = await getDecryptedAccountOrThrow(env, accountId).catch(() => null);
    if (!account) return errorResponse(404, "账户未找到");
    const client = new AzureArmClient(env, account);
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
      await updateAccountCost(env, accountId, cost);
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
    const task = await getTaskResponse(env, taskMatch[1]);
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
    if (!(await getAccountById(env, accountId))) return errorResponse(404, "账户未找到");
    const force = url.searchParams.get("refresh") === "1";
    try {
      const snapshot = await getVmList(env, accountId, { force });
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
    const account = await getAccountById(env, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    const body = await parseBody(req, vmActionSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = body.action === "delete"
      ? `已提交删除资源组 ${body.resourceGroup} 的任务`
      : `已提交 ${body.vmName} 的 ${body.action} 任务`;
    await createTask(env, { id: taskId, accountId, type: `vm.${body.action}`, lockKey: account.subscriptionId, createdBy: auth.actor, message: msg });
    startVmLifecycle(env, { taskId, accountId, actor: auth.actor, action: body.action, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ accountId, message: msg, taskId });
  }

  const accountChangeIpMatch = req.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/vm-change-ip$/)
    : null;
  if (accountChangeIpMatch) {
    const accountId = accountChangeIpMatch[1];
    const account = await getAccountById(env, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    const body = await parseBody(req, changeIpSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.vmName} 的更换公网 IP 任务`;
    await createTask(env, { id: taskId, accountId, type: "vm.change-ip", lockKey: account.subscriptionId, createdBy: auth.actor, message: msg });
    startChangeIp(env, { taskId, accountId, actor: auth.actor, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ accountId, message: msg, taskId });
  }

  const accountCreateVmMatch = req.method === "POST"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/create-vm$/)
    : null;
  if (accountCreateVmMatch) {
    const accountId = accountCreateVmMatch[1];
    const account = await getAccountById(env, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    const body = await parseBody(req, createVmSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    const msg = `已提交 ${body.region} 区域的创建虚拟机任务`;
    await createTask(env, { id: taskId, accountId, type: "vm.create", lockKey: account.subscriptionId, createdBy: auth.actor, message: msg });
    startCreateVm(env, {
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

  const accountRegionsMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/regions$/)
    : null;
  if (accountRegionsMatch) {
    const accountId = accountRegionsMatch[1];
    try {
      const account = await getDecryptedAccountOrThrow(env, accountId);
      const client = new AzureArmClient(env, account);
      // Returns the deployable regions *and* why others were dropped, so the
      // create-VM dialog can show what the subscription/policy actually allows
      // instead of silently offering regions that cannot be used.
      const listing = await listDeployableLocations(client, account.subscriptionId);
      const { locations, ...filterMeta } = listing;
      return accountJson(accountId, locations, { headers: { "x-account-id": accountId } }, filterMeta);
    } catch (error) {
      return errorResponse(400, formatAzureError(error), { accountId });
    }
  }

  const accountIpPermissionMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/ip-permission$/)
    : null;
  if (accountIpPermissionMatch) {
    const accountId = accountIpPermissionMatch[1];
    const location = (url.searchParams.get("location") || "").trim();
    if (!location) return errorResponse(400, "请提供 location 参数", { accountId });
    try {
      const account = await getDecryptedAccountOrThrow(env, accountId);
      const client = new AzureArmClient(env, account);
      const permission = await getIpPermission(client, account.subscriptionId, location);
      return accountJson(accountId, { location, permission }, { headers: { "x-account-id": accountId } });
    } catch (error) {
      return errorResponse(400, formatAzureError(error), { accountId });
    }
  }

  const accountVmSizesMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/vm-sizes$/)
    : null;
  if (accountVmSizesMatch) {
    const accountId = accountVmSizesMatch[1];
    const location = (url.searchParams.get("location") || "").trim();
    if (!location) return errorResponse(400, "请提供 location 参数", { accountId });
    try {
      const account = await getDecryptedAccountOrThrow(env, accountId);
      const client = new AzureArmClient(env, account);
      const sizes = await listVmSizes(client, account.subscriptionId, location);
      return accountJson(accountId, sizes, { headers: { "x-account-id": accountId } });
    } catch (error) {
      return errorResponse(400, formatAzureError(error), { accountId });
    }
  }

  const logsMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/logs$/)
    : null;
  if (logsMatch) {
    const accountId = logsMatch[1];
    const account = await getAccountById(env, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    return accountJson(accountId, await listAccountOperationLogs(env, accountId), {
      headers: { "x-account-id": accountId },
    });
  }

  const accountTasksMatch = req.method === "GET"
    ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/tasks$/)
    : null;
  if (accountTasksMatch) {
    const accountId = accountTasksMatch[1];
    const account = await getAccountById(env, accountId);
    if (!account) return errorResponse(404, "账户未找到");
    return accountJson(accountId, await listTasksForAccount(env, accountId), {
      headers: { "x-account-id": accountId },
    });
  }

  // Legacy account-free routes are gone on purpose: they resolved the account
  // from the session cookie, which is exactly what allowed one account's data to
  // be rendered for another. Fail loudly instead of silently answering wrong.
  if (
    url.pathname === "/api/vms"
    || url.pathname === "/api/vm-action"
    || url.pathname === "/api/vm-change-ip"
    || url.pathname === "/api/create-vm"
    || url.pathname === "/api/regions"
    || url.pathname === "/api/vm-sizes"
    || url.pathname === "/api/ip-permission"
    || url.pathname === "/api/tasks"
  ) {
    return errorResponse(410, "该接口已下线：账户身份现在必须显式出现在请求路径中，请刷新页面以加载最新前端。", {
      code: "route_gone",
    });
  }

  return errorResponse(404, "接口不存在");
}
