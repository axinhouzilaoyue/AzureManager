# Docker Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目从 Cloudflare Workers 迁移到 Bun + SQLite Docker 部署，保留所有功能，重写 UI 为暖灰极简风格（仿 Cli-Proxy-API-Management-Center）。

**Architecture:** Bun HTTP server 处理请求，bun:sqlite 替代 D1（同步 API），in-memory Map 替代 Durable Objects 锁，后台 async 函数替代 CF Workflows。所有 Azure API 调用代码直接复用。

**Tech Stack:** Bun, bun:sqlite, Vanilla JS + CSS (无前端框架), Docker

---

## 文件结构

### 删除
- `wrangler.jsonc`
- `src/cloudflare.d.ts`
- `src/index.ts` (CF 入口)
- `src/durable/subscriptionLock.ts`
- `src/workflows/createVm.ts`
- `src/workflows/vmLifecycle.ts`
- `src/workflows/changeIp.ts`

### 新建
- `src/server.ts` — Bun HTTP server 入口，路由处理
- `src/lib/background.ts` — 后台任务执行（替代 Workflows）
- `Dockerfile`
- `docker-compose.yml`

### 修改
- `src/types.ts` — 移除 CF 类型，AppEnv 改为读取 process.env
- `src/lib/db.ts` — 全部改为 bun:sqlite 同步 API
- `src/lib/locks.ts` — 改为 in-memory Map
- `src/lib/utils.ts` — createCookie 的 Secure 改为可选（HTTP 环境）
- `src/lib/workflow-support.ts` — 移除 CF 类型依赖
- `src/lib/auth.ts` — 适配 AppEnv 变化
- `package.json` — 移除 wrangler，运行时改为 bun
- `tsconfig.json` — target 适配 Bun
- `public/index.html` — 全新 UI
- `public/app.js` — 全新前端逻辑

---

## Task 1: 更新 package.json 和 tsconfig.json

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: 更新 package.json**

```json
{
  "name": "azure-manager",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: 更新 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: 安装依赖**

```bash
bun install
```

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json bun.lock
git commit -m "chore: switch runtime to Bun"
```

---

## Task 2: 重写 src/types.ts

**Files:**
- Modify: `src/types.ts`

移除所有 Cloudflare 绑定类型（SqlDatabase、DurableObjectNamespaceBinding、WorkflowBinding 等），AppEnv 改为普通对象从环境变量构建。

- [ ] **Step 1: 替换 src/types.ts**

```typescript
import type { Database } from "bun:sqlite";

export type JsonRecord = Record<string, unknown>;

export type TaskStatus = "queued" | "running" | "success" | "failure";

export type VmAction = "start" | "stop" | "restart" | "delete";

export type WorkflowName =
  | "create-vm-workflow"
  | "vm-lifecycle-workflow"
  | "change-ip-workflow";

export interface AppEnv {
  APP_NAME: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  ACCOUNT_ENCRYPTION_KEY: string;
  SESSION_TTL_SECONDS: number;
  LOCK_TIMEOUT_SECONDS: number;
  AZURE_ARM_BASE_URL: string;
  AZURE_AUTH_BASE_URL: string;
  DB: Database;
}

export interface SessionState {
  v: 1;
  selectedAccountId: string | null;
  localAuthExp: number | null;
}

export interface AuthContext {
  authenticated: boolean;
  actor: string;
  session: SessionState;
}

export interface AccountRecord {
  id: string;
  name: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
  clientSecretCiphertext: string;
  expirationDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedAccountRecord extends Omit<AccountRecord, "clientSecretCiphertext"> {
  clientSecret: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
  expirationDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCheckResult {
  subscriptionDisplayName: string;
  state: string;
  availableRegionCount: number;
  warnings: string[];
  checkedAt: string;
}

export interface TaskRecord {
  id: string;
  accountId: string;
  type: string;
  status: TaskStatus;
  workflowName: WorkflowName;
  workflowInstanceId: string | null;
  lockKey: string | null;
  message: string | null;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TaskLogRecord {
  id: number;
  taskId: string;
  step: string;
  level: string;
  message: string;
  detailJson: string | null;
  createdAt: string;
}

export interface TaskResponse {
  id: string;
  status: TaskStatus;
  message: string | null;
  result: JsonRecord | string | null;
  errorCode: string | null;
  errorMessage: string | null;
  workflowName: WorkflowName;
  workflowInstanceId: string | null;
  logs: Array<{
    id: number;
    step: string;
    level: string;
    message: string;
    detail: unknown;
    createdAt: string;
  }>;
}

export interface CreateVmParams {
  taskId: string;
  accountId: string;
  actor: string;
  region: string;
  vmSize: string;
  osImage: string;
  diskSize: number;
  ipType: string;
  userData: string | null;
}

export interface VmLifecycleParams {
  taskId: string;
  accountId: string;
  actor: string;
  action: VmAction;
  resourceGroup: string;
  vmName: string;
}

export interface ChangeIpParams {
  taskId: string;
  accountId: string;
  actor: string;
  resourceGroup: string;
  vmName: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "refactor: rewrite types.ts for Bun runtime"
```

---

## Task 3: 重写 src/lib/db.ts（D1 → bun:sqlite）

**Files:**
- Modify: `src/lib/db.ts`

bun:sqlite 是**同步 API**，但为了让调用方代码变动最小，函数仍返回 `Promise<T>`（内部用 `Promise.resolve()` 包裹）。

- [ ] **Step 1: 替换 src/lib/db.ts 开头 import 和初始化**

```typescript
import type { Database } from "bun:sqlite";
import type {
  AccountRecord,
  AccountSummary,
  AppEnv,
  DecryptedAccountRecord,
  JsonRecord,
  TaskLogRecord,
  TaskRecord,
  TaskResponse,
  TaskStatus,
  WorkflowName,
} from "../types";
import { decryptString, encryptString } from "./crypto";
import { nowIso, parseJsonOrNull } from "./utils";
```

- [ ] **Step 2: 替换 initializeDatabase**

```typescript
export function initializeDatabase(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      client_secret_ciphertext TEXT NOT NULL,
      expiration_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_subscription_id ON accounts(subscription_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      workflow_instance_id TEXT,
      lock_key TEXT,
      message TEXT,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id, id);
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);
}
```

注意：bun:sqlite 的 `db.exec()` **支持多语句**，直接传整块 SQL 即可。

- [ ] **Step 3: 替换所有查询函数**

将文件中所有使用 `env.DB.prepare(...).bind(...).first<T>()` / `.all<T>()` / `.run()` 的函数，改为 bun:sqlite 的同步 API：

```typescript
// bun:sqlite 对应写法：
// D1: await env.DB.prepare(sql).bind(...).first<T>()
// Bun: db.prepare(sql).get(...) as T | null

// D1: await env.DB.prepare(sql).bind(...).all<T>()
// Bun: db.prepare(sql).all(...) as T[]

// D1: await env.DB.prepare(sql).bind(...).run()
// Bun: db.prepare(sql).run(...)

// 所有函数保持 async 签名，内部直接操作同步结果再 return
```

完整替换后的 db.ts 关键函数示例（其他函数同理）：

```typescript
export const DEFAULT_STARTUP_SCRIPT = `#!/bin/bash
set -euxo pipefail
echo "Provisioned by Azure VM Management Panel" > /etc/motd`;

const STARTUP_SCRIPT_SETTING_KEY = "global_startup_script";

export async function listAccounts(env: AppEnv): Promise<AccountSummary[]> {
  const rows = env.DB.prepare(
    `SELECT id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, expiration_date, created_at, updated_at
       FROM accounts ORDER BY name ASC`
  ).all() as AccountRow[];
  return rows.map((r) => toSummary(mapAccountRow(r)));
}

export async function getAccountById(env: AppEnv, accountId: string): Promise<AccountRecord | null> {
  const row = env.DB.prepare(
    `SELECT id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, expiration_date, created_at, updated_at
       FROM accounts WHERE id = ?`
  ).get(accountId) as AccountRow | null;
  return row ? mapAccountRow(row) : null;
}

export async function accountNameExists(env: AppEnv, name: string, excludeAccountId?: string): Promise<boolean> {
  const row = env.DB.prepare(
    `SELECT id FROM accounts WHERE name = ? AND (? IS NULL OR id != ?) LIMIT 1`
  ).get(name, excludeAccountId ?? null, excludeAccountId ?? null) as { id: string } | null;
  return Boolean(row);
}

export async function createAccount(env: AppEnv, input: {
  id: string; name: string; clientId: string; tenantId: string;
  subscriptionId: string; clientSecret: string; expirationDate: string | null;
}): Promise<AccountSummary> {
  const timestamp = nowIso();
  const ciphertext = await encryptString(env.ACCOUNT_ENCRYPTION_KEY, input.clientSecret);
  env.DB.prepare(
    `INSERT INTO accounts (id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, expiration_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.id, input.name, input.clientId, input.tenantId, input.subscriptionId, ciphertext, input.expirationDate, timestamp, timestamp);
  return { id: input.id, name: input.name, clientId: input.clientId, tenantId: input.tenantId, subscriptionId: input.subscriptionId, expirationDate: input.expirationDate, createdAt: timestamp, updatedAt: timestamp };
}

export async function updateAccountMetadata(env: AppEnv, input: { accountId: string; newName: string; expirationDate: string | null }): Promise<void> {
  env.DB.prepare(
    `UPDATE accounts SET name = ?, expiration_date = ?, updated_at = ? WHERE id = ?`
  ).run(input.newName, input.expirationDate, nowIso(), input.accountId);
}

export async function deleteAccount(env: AppEnv, accountId: string): Promise<void> {
  env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
}

export async function getDecryptedAccountById(env: AppEnv, accountId: string): Promise<DecryptedAccountRecord | null> {
  const account = await getAccountById(env, accountId);
  if (!account) return null;
  return {
    id: account.id, name: account.name, clientId: account.clientId,
    tenantId: account.tenantId, subscriptionId: account.subscriptionId,
    clientSecret: await decryptString(env.ACCOUNT_ENCRYPTION_KEY, account.clientSecretCiphertext),
    expirationDate: account.expirationDate, createdAt: account.createdAt, updatedAt: account.updatedAt,
  };
}

export async function getGlobalStartupScript(env: AppEnv): Promise<string> {
  const row = env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(STARTUP_SCRIPT_SETTING_KEY) as { value: string } | null;
  return row?.value ?? DEFAULT_STARTUP_SCRIPT;
}

export async function setGlobalStartupScript(env: AppEnv, input: { userData: string; updatedBy: string }): Promise<void> {
  env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(STARTUP_SCRIPT_SETTING_KEY, input.userData, nowIso(), input.updatedBy);
}

export async function createTask(env: AppEnv, input: {
  id: string; accountId: string; type: string; workflowName: WorkflowName;
  lockKey: string; createdBy: string; message: string;
}): Promise<void> {
  const timestamp = nowIso();
  env.DB.prepare(
    `INSERT INTO tasks (id, account_id, type, status, workflow_name, workflow_instance_id, lock_key, message,
      result_json, error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at)
     VALUES (?, ?, ?, 'queued', ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`
  ).run(input.id, input.accountId, input.type, input.workflowName, input.lockKey, input.message, crypto.randomUUID(), input.createdBy, timestamp, timestamp);
}

export async function setTaskWorkflowInstance(env: AppEnv, taskId: string, workflowInstanceId: string): Promise<void> {
  env.DB.prepare(`UPDATE tasks SET workflow_instance_id = ?, updated_at = ? WHERE id = ?`).run(workflowInstanceId, nowIso(), taskId);
}

export async function markTaskRunning(env: AppEnv, taskId: string, message: string): Promise<void> {
  const ts = nowIso();
  env.DB.prepare(
    `UPDATE tasks SET status = 'running', message = ?, updated_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`
  ).run(message, ts, ts, taskId);
}

export async function markTaskSuccess(env: AppEnv, taskId: string, message: string, result: JsonRecord | string | null): Promise<void> {
  const ts = nowIso();
  env.DB.prepare(
    `UPDATE tasks SET status = 'success', message = ?, result_json = ?, error_code = NULL, error_message = NULL, updated_at = ?, completed_at = ? WHERE id = ?`
  ).run(message, result === null ? null : JSON.stringify(result), ts, ts, taskId);
}

export async function markTaskFailure(env: AppEnv, taskId: string, input: { message: string; errorCode?: string | null; errorMessage?: string | null; result?: JsonRecord | string | null }): Promise<void> {
  const ts = nowIso();
  env.DB.prepare(
    `UPDATE tasks SET status = 'failure', message = ?, result_json = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`
  ).run(input.message, input.result === undefined || input.result === null ? null : JSON.stringify(input.result), input.errorCode ?? null, input.errorMessage ?? null, ts, ts, taskId);
}

export async function appendTaskLog(env: AppEnv, taskId: string, input: { step: string; message: string; level?: string; detail?: JsonRecord | string | null }): Promise<void> {
  env.DB.prepare(
    `INSERT INTO task_logs (task_id, step, level, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, input.step, input.level ?? "info", input.message, input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail), nowIso());
}

export async function writeAuditEvent(env: AppEnv, input: { actor: string; action: string; targetType: string; targetId?: string | null; metadata?: JsonRecord | null }): Promise<void> {
  env.DB.prepare(
    `INSERT INTO audit_events (actor, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(input.actor, input.action, input.targetType, input.targetId ?? null, input.metadata ? JSON.stringify(input.metadata) : null, nowIso());
}

export async function getTaskResponse(env: AppEnv, taskId: string): Promise<TaskResponse | null> {
  const taskRow = env.DB.prepare(
    `SELECT id, account_id, type, status, workflow_name, workflow_instance_id, lock_key, message, result_json,
            error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at
       FROM tasks WHERE id = ?`
  ).get(taskId) as TaskRow | null;
  if (!taskRow) return null;
  const logs = env.DB.prepare(
    `SELECT id, task_id, step, level, message, detail_json, created_at FROM task_logs WHERE task_id = ? ORDER BY id ASC`
  ).all(taskId) as TaskLogRow[];
  const task = mapTaskRow(taskRow);
  return {
    id: task.id, status: task.status, message: task.message, result: parseJsonOrNull<JsonRecord | string>(task.resultJson),
    errorCode: task.errorCode, errorMessage: task.errorMessage, workflowName: task.workflowName, workflowInstanceId: task.workflowInstanceId,
    logs: logs.map((r) => {
      const l = mapTaskLogRow(r);
      return { id: l.id, step: l.step, level: l.level, message: l.message, detail: parseJsonOrNull(l.detailJson), createdAt: l.createdAt };
    }),
  };
}

// ---- row type interfaces (private) ----
interface AccountRow { id: string; name: string; client_id: string; tenant_id: string; subscription_id: string; client_secret_ciphertext: string; expiration_date: string | null; created_at: string; updated_at: string }
interface TaskRow { id: string; account_id: string; type: string; status: TaskStatus; workflow_name: WorkflowName; workflow_instance_id: string | null; lock_key: string | null; message: string | null; result_json: string | null; error_code: string | null; error_message: string | null; idempotency_key: string; created_by: string; created_at: string; updated_at: string; started_at: string | null; completed_at: string | null }
interface TaskLogRow { id: number; task_id: string; step: string; level: string; message: string; detail_json: string | null; created_at: string }
interface AppSettingRow { key: string; value: string; updated_at: string; updated_by: string | null }

function mapAccountRow(r: AccountRow): AccountRecord { return { id: r.id, name: r.name, clientId: r.client_id, tenantId: r.tenant_id, subscriptionId: r.subscription_id, clientSecretCiphertext: r.client_secret_ciphertext, expirationDate: r.expiration_date, createdAt: r.created_at, updatedAt: r.updated_at } }
function toSummary(a: AccountRecord): AccountSummary { return { id: a.id, name: a.name, clientId: a.clientId, tenantId: a.tenantId, subscriptionId: a.subscriptionId, expirationDate: a.expirationDate, createdAt: a.createdAt, updatedAt: a.updatedAt } }
function mapTaskRow(r: TaskRow): TaskRecord { return { id: r.id, accountId: r.account_id, type: r.type, status: r.status, workflowName: r.workflow_name, workflowInstanceId: r.workflow_instance_id, lockKey: r.lock_key, message: r.message, resultJson: r.result_json, errorCode: r.error_code, errorMessage: r.error_message, idempotencyKey: r.idempotency_key, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, completedAt: r.completed_at } }
function mapTaskLogRow(r: TaskLogRow): TaskLogRecord { return { id: r.id, taskId: r.task_id, step: r.step, level: r.level, message: r.message, detailJson: r.detail_json, createdAt: r.created_at } }
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/db.ts
git commit -m "refactor: rewrite db.ts for bun:sqlite sync API"
```

---

## Task 4: 重写 src/lib/locks.ts（Durable Objects → in-memory Map）

**Files:**
- Modify: `src/lib/locks.ts`

- [ ] **Step 1: 替换 src/lib/locks.ts**

```typescript
import { delay } from "./utils";

interface LockEntry {
  owner: string;
  expiresAt: number;
}

const activeLocks = new Map<string, LockEntry>();

export async function acquireSubscriptionLock(input: {
  lockKey: string;
  owner: string;
  timeoutSeconds: number;
  ttlSeconds: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const existing = activeLocks.get(input.lockKey);
    if (!existing || existing.expiresAt < Date.now()) {
      activeLocks.set(input.lockKey, {
        owner: input.owner,
        expiresAt: Date.now() + input.ttlSeconds * 1000,
      });
      return;
    }
    await delay(2000);
  }

  throw new Error("subscription_lock_timeout");
}

export function releaseSubscriptionLock(input: { lockKey: string; owner: string }): void {
  const existing = activeLocks.get(input.lockKey);
  if (existing?.owner === input.owner) {
    activeLocks.delete(input.lockKey);
  }
}
```

- [ ] **Step 2: 更新 src/lib/workflow-support.ts（移除 CF 类型依赖）**

```typescript
import type { AppEnv, DecryptedAccountRecord } from "../types";
import { getDecryptedAccountById } from "./db";

export async function getDecryptedAccountOrThrow(env: AppEnv, accountId: string): Promise<DecryptedAccountRecord> {
  const account = await getDecryptedAccountById(env, accountId);
  if (!account) throw new Error("account_not_found");
  return account;
}

export function getLockTimeoutSeconds(env: AppEnv): number {
  return env.LOCK_TIMEOUT_SECONDS;
}

export function generateAdminPassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/locks.ts src/lib/workflow-support.ts
git commit -m "refactor: replace Durable Objects with in-memory lock"
```

---

## Task 5: 新建 src/lib/background.ts（替代 CF Workflows）

**Files:**
- Create: `src/lib/background.ts`
- Delete: `src/workflows/createVm.ts`, `src/workflows/vmLifecycle.ts`, `src/workflows/changeIp.ts`
- Delete: `src/durable/subscriptionLock.ts`

后台任务 fire-and-forget，不需要步骤持久化。任务状态写 SQLite。

- [ ] **Step 1: 新建 src/lib/background.ts**

```typescript
import type { AppEnv, ChangeIpParams, CreateVmParams, VmLifecycleParams } from "../types";
import { appendTaskLog, markTaskFailure, markTaskRunning, markTaskSuccess } from "./db";
import { acquireSubscriptionLock, releaseSubscriptionLock } from "./locks";
import { generateAdminPassword, getDecryptedAccountOrThrow, getLockTimeoutSeconds } from "./workflow-support";
import { AzureArmClient } from "./azure/client";
import { createVirtualMachine, listVirtualMachines, startVmAction } from "./azure/compute";
import {
  buildNetworkInterfacePayload,
  createOrUpdateNetworkInterface,
  createPublicIpAddress,
  deletePublicIpAddress,
  getNetworkInterface,
} from "./azure/network";
import { createOrUpdateResourceGroup, deleteResourceGroup } from "./azure/resource";
import { getPublicIpAddress } from "./azure/network";

export function startCreateVm(env: AppEnv, params: CreateVmParams): void {
  runCreateVm(env, params).catch(() => {});
}

export function startVmLifecycle(env: AppEnv, params: VmLifecycleParams): void {
  runVmLifecycle(env, params).catch(() => {});
}

export function startChangeIp(env: AppEnv, params: ChangeIpParams): void {
  runChangeIp(env, params).catch(() => {});
}

async function runCreateVm(env: AppEnv, params: CreateVmParams): Promise<void> {
  const account = await getDecryptedAccountOrThrow(env, params.accountId);
  const client = new AzureArmClient(env, account);
  const adminPassword = generateAdminPassword();
  const timestamp = Date.now();
  const slugRegion = params.region.replace(/\s+/g, "").toLowerCase();
  const vmName = `vm-${slugRegion}-${timestamp}`;
  const resourceGroup = `vm-${slugRegion}-${timestamp}`;
  const lockKey = account.subscriptionId;
  const ttl = getLockTimeoutSeconds(env);

  try {
    await acquireSubscriptionLock({ lockKey, owner: params.taskId, timeoutSeconds: ttl, ttlSeconds: ttl });
    await markTaskRunning(env, params.taskId, `正在为账户 ${account.name} 创建虚拟机...`);
    await appendTaskLog(env, params.taskId, { step: "lock", message: `已获取订阅锁 ${lockKey}` });

    await createOrUpdateResourceGroup(client, account.subscriptionId, resourceGroup, params.region);
    await appendTaskLog(env, params.taskId, { step: "resource-group", message: `资源组 ${resourceGroup} 已创建` });

    const vnet = await createVirtualNetwork(client, account.subscriptionId, resourceGroup, `vnet-${vmName}`, params.region);
    await appendTaskLog(env, params.taskId, { step: "network", message: `虚拟网络 ${vnet.name} 已创建` });

    const subnetId = vnet.properties.subnets[0]?.id;
    if (!subnetId) throw new Error("subnet_not_created");

    const publicIp = await createPublicIpAddress(client, account.subscriptionId, resourceGroup, `pip-${vmName}`, params.region, params.ipType);
    await appendTaskLog(env, params.taskId, { step: "public-ip", message: `公网 IP 资源 pip-${vmName} 已创建` });

    const nicName = `nic-${vmName}`;
    await createOrUpdateNetworkInterface(client, account.subscriptionId, resourceGroup, nicName, {
      location: params.region,
      properties: { ipConfigurations: [{ name: "ipconfig1", properties: { subnet: { id: subnetId }, publicIPAddress: { id: publicIp.id } } }] },
    });
    await appendTaskLog(env, params.taskId, { step: "network", message: `网卡 ${nicName} 已创建` });

    const nicId = `/subscriptions/${account.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}`;
    await createVirtualMachine(client, account.subscriptionId, resourceGroup, vmName, {
      location: params.region, vmSize: params.vmSize, osImage: params.osImage,
      diskSizeGb: params.diskSize, networkInterfaceId: nicId, adminPassword, userData: params.userData,
    });
    await appendTaskLog(env, params.taskId, { step: "vm", message: `虚拟机 ${vmName} 已创建` });

    const finalIp = await getPublicIpAddress(client, account.subscriptionId, resourceGroup, `pip-${vmName}`);
    await markTaskSuccess(env, params.taskId, `虚拟机 ${vmName} 创建成功`, {
      vmName, resourceGroup, publicIp: finalIp.properties?.ipAddress ?? "N/A", username: "azureuser", password: adminPassword,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await appendTaskLog(env, params.taskId, { step: "error", message: msg, level: "error" });
    await markTaskFailure(env, params.taskId, { message: `虚拟机创建失败: ${msg}`, errorMessage: msg });
    try {
      await deleteResourceGroup(client, account.subscriptionId, resourceGroup);
      await appendTaskLog(env, params.taskId, { step: "cleanup", message: `已回收资源组 ${resourceGroup}` });
    } catch (cleanupError) {
      await appendTaskLog(env, params.taskId, { step: "cleanup", message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError), level: "error" });
    }
  } finally {
    releaseSubscriptionLock({ lockKey, owner: params.taskId });
  }
}

async function runVmLifecycle(env: AppEnv, params: VmLifecycleParams): Promise<void> {
  const account = await getDecryptedAccountOrThrow(env, params.accountId);
  const client = new AzureArmClient(env, account);
  const lockKey = account.subscriptionId;
  const ttl = getLockTimeoutSeconds(env);

  try {
    await acquireSubscriptionLock({ lockKey, owner: params.taskId, timeoutSeconds: ttl, ttlSeconds: ttl });
    await markTaskRunning(env, params.taskId, `正在执行 ${params.action} 操作...`);
    await appendTaskLog(env, params.taskId, { step: "lock", message: `已获取订阅锁 ${lockKey}` });

    if (params.action === "delete") {
      await deleteResourceGroup(client, account.subscriptionId, params.resourceGroup);
      await appendTaskLog(env, params.taskId, { step: "resource-group", message: `资源组 ${params.resourceGroup} 已删除` });
    } else {
      await startVmAction(client, account.subscriptionId, params.resourceGroup, params.vmName, params.action);
      await appendTaskLog(env, params.taskId, { step: "vm-action", message: `${params.vmName} ${params.action} 操作已完成` });
    }

    await markTaskSuccess(env, params.taskId, `${params.vmName} ${params.action} 操作成功`, {
      action: params.action, resourceGroup: params.resourceGroup, vmName: params.vmName,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await appendTaskLog(env, params.taskId, { step: "error", message: msg, level: "error" });
    await markTaskFailure(env, params.taskId, { message: `虚拟机操作失败: ${msg}`, errorMessage: msg });
  } finally {
    releaseSubscriptionLock({ lockKey, owner: params.taskId });
  }
}

async function runChangeIp(env: AppEnv, params: ChangeIpParams): Promise<void> {
  const account = await getDecryptedAccountOrThrow(env, params.accountId);
  const client = new AzureArmClient(env, account);
  const lockKey = account.subscriptionId;
  const ttl = getLockTimeoutSeconds(env);

  try {
    await acquireSubscriptionLock({ lockKey, owner: params.taskId, timeoutSeconds: ttl, ttlSeconds: ttl });
    await markTaskRunning(env, params.taskId, `正在为 ${params.vmName} 更换公网 IP...`);
    await appendTaskLog(env, params.taskId, { step: "lock", message: `已获取订阅锁 ${lockKey}` });

    const vm = await getVirtualMachine(client, account.subscriptionId, params.resourceGroup, params.vmName);
    const nicId = vm.properties.networkProfile?.networkInterfaces?.[0]?.id;
    if (!nicId) throw new Error("vm_network_interface_not_found");
    const nicName = nicId.split("/").at(-1)!;

    const nic = await getNetworkInterface(client, account.subscriptionId, params.resourceGroup, nicName);
    const oldIpId = nic.properties.ipConfigurations?.[0]?.properties?.publicIPAddress?.id ?? null;

    if (oldIpId) {
      await createOrUpdateNetworkInterface(client, account.subscriptionId, params.resourceGroup, nicName, buildNetworkInterfacePayload(nic, null));
      await appendTaskLog(env, params.taskId, { step: "network", message: `已从网卡 ${nicName} 卸载旧公网 IP` });
      const oldIpName = oldIpId.split("/").at(-1)!;
      await deletePublicIpAddress(client, account.subscriptionId, params.resourceGroup, oldIpName);
      await appendTaskLog(env, params.taskId, { step: "public-ip", message: `旧公网 IP ${oldIpName} 已删除` });
    }

    const newIpName = `pip-${params.vmName}-${Date.now()}`;
    const newIp = await createPublicIpAddress(client, account.subscriptionId, params.resourceGroup, newIpName, vm.location, "Static");
    await appendTaskLog(env, params.taskId, { step: "public-ip", message: `新公网 IP 资源 ${newIpName} 已创建` });

    const refreshedNic = await getNetworkInterface(client, account.subscriptionId, params.resourceGroup, nicName);
    await createOrUpdateNetworkInterface(client, account.subscriptionId, params.resourceGroup, nicName, buildNetworkInterfacePayload(refreshedNic, newIp.id));
    await appendTaskLog(env, params.taskId, { step: "network", message: `已为 ${params.vmName} 绑定新的公网 IP` });

    await markTaskSuccess(env, params.taskId, `${params.vmName} 更换公网 IP 成功`, {
      vmName: params.vmName, resourceGroup: params.resourceGroup, publicIp: newIp.properties?.ipAddress ?? "N/A",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await appendTaskLog(env, params.taskId, { step: "error", message: msg, level: "error" });
    await markTaskFailure(env, params.taskId, { message: `更换公网 IP 失败: ${msg}`, errorMessage: msg });
  } finally {
    releaseSubscriptionLock({ lockKey, owner: params.taskId });
  }
}

// 从 azure/network.ts 导入 createVirtualNetwork（需确认该函数已导出）
import { createVirtualNetwork } from "./azure/network";
import { getVirtualMachine } from "./azure/compute";
```

- [ ] **Step 2: 删除 CF 专属文件**

```bash
rm -rf src/workflows/ src/durable/ src/cloudflare.d.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/background.ts src/lib/locks.ts
git rm -r src/workflows/ src/durable/ src/cloudflare.d.ts
git commit -m "refactor: replace CF Workflows/Durable Objects with background async tasks"
```

---

## Task 6: 更新 src/lib/utils.ts（移除 Secure cookie 硬编码）

**Files:**
- Modify: `src/lib/utils.ts`

- [ ] **Step 1: 修改 createCookie 中 Secure 默认值**

将 `src/lib/utils.ts` 中 `createCookie` 的 secure 默认值从 `true` 改为 `false`：

```typescript
// 修改这一行
if (options.secure ?? false) {   // 原来是 ?? true
  parts.push("Secure");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/utils.ts
git commit -m "fix: default cookie Secure to false for HTTP Docker deployment"
```

---

## Task 7: 新建 src/server.ts（Bun HTTP server）

**Files:**
- Create: `src/server.ts`
- Delete: `src/index.ts`

这是最核心的一步。将 `src/index.ts` 中的所有路由逻辑迁移到 Bun HTTP server，同时构建 `AppEnv` 对象（从 `process.env` 读取）。

- [ ] **Step 1: 新建 src/server.ts**

```typescript
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { AppEnv, ChangeIpParams, CreateVmParams, VmLifecycleParams } from "./types";
import { createLogoutCookie, createLoginCookie, createSelectionCookie, getAuthContext, requireAuth } from "./lib/auth";
import {
  accountNameExists, appendTaskLog, createAccount, createTask,
  deleteAccount, getAccountById, getGlobalStartupScript, getTaskResponse,
  initializeDatabase, listAccounts, markTaskFailure, setGlobalStartupScript,
  setTaskWorkflowInstance, updateAccountMetadata, writeAuditEvent,
} from "./lib/db";
import { startChangeIp, startCreateVm, startVmLifecycle } from "./lib/background";
import { AzureArmClient } from "./lib/azure/client";
import { listVirtualMachines } from "./lib/azure/compute";
import { getSubscriptionDetails, listSubscriptionLocations } from "./lib/azure/subscription";
import { getDecryptedAccountOrThrow } from "./lib/workflow-support";
import {
  accountCheckSchema, changeIpSchema, createAccountSchema, createVmSchema,
  editAccountSchema, loginSchema, selectAccountSchema, updateStartupScriptSchema, vmActionSchema,
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

// ---- routing helpers ----
async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T | Response> {
  const payload = await readJson(req);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return errorResponse(400, parsed.error.issues[0]?.message ?? "请求参数无效");
  return parsed.data;
}

// ---- server ----
const server = Bun.serve({
  port: parseInt(process.env.PORT ?? "8080"),
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // static files
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file("public/index.html"));
    }
    if (url.pathname === "/app.js") {
      return new Response(Bun.file("public/app.js"), { headers: { "content-type": "application/javascript" } });
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
      return errorResponse(500, "服务器内部错误", { detail: error instanceof Error ? error.message : String(error) });
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
  if (req.method === "GET" && url.pathname === "/api/session") {
    const auth = await getAuthContext(ENV, req);
    const selected = auth.session.selectedAccountId ? await getAccountById(ENV, auth.session.selectedAccountId) : null;
    return jsonResponse({ loggedIn: auth.authenticated, selectedAccountId: selected?.id ?? null, selectedAccountName: selected?.name ?? null });
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

  // accounts
  if (req.method === "GET" && url.pathname === "/api/accounts") return jsonResponse(await listAccounts(ENV));

  if (req.method === "POST" && url.pathname === "/api/accounts/check") {
    const body = await parseBody(req, accountCheckSchema);
    if (body instanceof Response) return body;
    try {
      const client = new AzureArmClient(ENV, { ...body, id: "check", name: "check", expirationDate: null, createdAt: "", updatedAt: "" } as any);
      const sub = await getSubscriptionDetails(client, body.subscriptionId);
      const regions = await listSubscriptionLocations(client, body.subscriptionId);
      return jsonResponse({ subscriptionDisplayName: sub.displayName, state: sub.state, availableRegionCount: regions.length, warnings: [], checkedAt: new Date().toISOString() });
    } catch (error) {
      return errorResponse(400, formatAzureError(error));
    }
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await parseBody(req, createAccountSchema);
    if (body instanceof Response) return body;
    if (await accountNameExists(ENV, body.name)) return errorResponse(409, "账户名称已存在");
    const created = await createAccount(ENV, { id: crypto.randomUUID(), ...body });
    await writeAuditEvent(ENV, { actor: auth.actor, action: "account.created", targetType: "account", targetId: created.id, metadata: { name: created.name } });
    return jsonResponse(created, { status: 201 });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts/edit") {
    const body = await parseBody(req, editAccountSchema);
    if (body instanceof Response) return body;
    if (!(await getAccountById(ENV, body.accountId))) return errorResponse(404, "账户未找到");
    if (await accountNameExists(ENV, body.newName, body.accountId)) return errorResponse(409, "新的账户名称已存在");
    await updateAccountMetadata(ENV, { accountId: body.accountId, newName: body.newName, expirationDate: body.expirationDate });
    await writeAuditEvent(ENV, { actor: auth.actor, action: "account.updated", targetType: "account", targetId: body.accountId });
    let headers: HeadersInit | undefined;
    if (auth.session.selectedAccountId === body.accountId) {
      headers = { "Set-Cookie": await createSelectionCookie(ENV, req, body.accountId) };
    }
    return jsonResponse({ success: true }, { headers });
  }

  const checkMatch = req.method === "POST" ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})\/check$/) : null;
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

  const deleteMatch = req.method === "DELETE" ? url.pathname.match(/^\/api\/accounts\/([0-9a-fA-F-]{36})$/) : null;
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

  // settings
  if (req.method === "GET" && url.pathname === "/api/settings/startup-script") {
    return jsonResponse({ userData: await getGlobalStartupScript(ENV) });
  }
  if (req.method === "POST" && url.pathname === "/api/settings/startup-script") {
    const body = await parseBody(req, updateStartupScriptSchema);
    if (body instanceof Response) return body;
    await setGlobalStartupScript(ENV, { userData: body.userData, updatedBy: auth.actor });
    return jsonResponse({ success: true, userData: body.userData });
  }

  // selected account required below
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
    await createTask(ENV, { id: taskId, accountId: selectedId, type: `vm.${body.action}`, workflowName: "vm-lifecycle-workflow", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: `已提交 ${body.vmName} 的 ${body.action} 任务` });
    startVmLifecycle(ENV, { taskId, accountId: selectedId, actor: auth.actor, action: body.action, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ message: `已提交 ${body.vmName} 的 ${body.action} 任务`, taskId });
  }

  if (req.method === "POST" && url.pathname === "/api/vm-change-ip") {
    const body = await parseBody(req, changeIpSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    await createTask(ENV, { id: taskId, accountId: selectedId, type: "vm.change-ip", workflowName: "change-ip-workflow", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: `已提交 ${body.vmName} 的更换公网 IP 任务` });
    startChangeIp(ENV, { taskId, accountId: selectedId, actor: auth.actor, resourceGroup: body.resourceGroup, vmName: body.vmName });
    return jsonResponse({ message: `已提交 ${body.vmName} 的更换公网 IP 任务`, taskId });
  }

  if (req.method === "POST" && url.pathname === "/api/create-vm") {
    const body = await parseBody(req, createVmSchema);
    if (body instanceof Response) return body;
    const taskId = crypto.randomUUID();
    await createTask(ENV, { id: taskId, accountId: selectedId, type: "vm.create", workflowName: "create-vm-workflow", lockKey: selectedAccount.subscriptionId, createdBy: auth.actor, message: `已提交 ${body.region} 区域的创建虚拟机任务` });
    startCreateVm(ENV, { taskId, accountId: selectedId, actor: auth.actor, ...body });
    return jsonResponse({ message: `已提交 ${body.region} 区域的创建虚拟机任务`, taskId });
  }

  const taskMatch = req.method === "GET" ? url.pathname.match(/^\/api\/task_status\/([0-9a-fA-F-]{36})$/) : null;
  if (taskMatch) {
    const task = await getTaskResponse(ENV, taskMatch[1]);
    if (!task) return errorResponse(404, "任务未找到");
    return jsonResponse(task);
  }

  return errorResponse(404, "接口不存在");
}

function formatAzureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("azure_auth_failed:")) return "Azure 认证失败，请检查客户端 ID、客户端密码和租户 ID 是否正确。";
  if (message.includes("SubscriptionNotFound")) return "订阅不存在，或当前服务主体无权访问该订阅。";
  if (message.includes("AuthorizationFailed")) return "凭据有效，但当前服务主体没有足够的订阅权限。";
  if (message.includes("account_not_found")) return "账户不存在。";
  return "Azure 检查失败，请确认订阅 ID、租户、服务主体权限以及当前目录是否正确。";
}
```

- [ ] **Step 2: 删除旧入口**

```bash
rm src/index.ts wrangler.jsonc
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

修复所有类型错误后继续。

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git rm src/index.ts wrangler.jsonc
git commit -m "feat: replace CF Workers entry with Bun HTTP server"
```

---

## Task 8: 新建 Dockerfile 和 docker-compose.yml

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: 新建 Dockerfile**

```dockerfile
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

VOLUME ["/app/data"]

EXPOSE 8080

CMD ["bun", "src/server.ts"]
```

- [ ] **Step 2: 新建 docker-compose.yml**

```yaml
services:
  azure-manager:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
    environment:
      APP_PASSWORD: "change-me"
      SESSION_SECRET: "change-me-at-least-32-chars-long"
      ACCOUNT_ENCRYPTION_KEY: "change-me-exactly-32-bytes-base64"
    restart: unless-stopped
```

- [ ] **Step 3: 新建 .dockerignore**

```
node_modules/
.wrangler/
.git/
data/
docs/
*.md
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: add Dockerfile and docker-compose.yml"
```

---

## Task 9: 重写前端 public/index.html

**Files:**
- Modify: `public/index.html`

UI 风格：暖灰极简（参考 Cli-Proxy-API-Management-Center）
- 背景 `#faf9f5`，卡片 `#f0eee8`，主色 `#8b8680`，文字 `#2d2a26`
- 左侧固定侧边栏 + 右侧内容区布局
- 无第三方 CSS 框架，纯手写 CSS

页面结构：
- **登录页**：全屏居中，密码输入框 + 登录按钮
- **主界面**：
  - 侧边栏：账户列表（可点击切换）+ 底部退出按钮
  - 内容区顶部标签页：虚拟机 / 任务 / 设置
  - VM 列表：表格展示，每行有操作按钮
  - 任务列表：展示后台任务状态
  - 创建 VM：弹窗表单
  - 添加账户：弹窗表单

- [ ] **Step 1: 写 public/index.html**

内容较长，核心结构如下（完整实现见 app.js 配合）：

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Azure Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #faf9f5;
      --bg2: #f0eee8;
      --bg3: #e8e5de;
      --border: #e3e1db;
      --text: #2d2a26;
      --text2: #6d6760;
      --primary: #8b8680;
      --primary-hover: #7f7a74;
      --success: #10b981;
      --error: #c65746;
      --warning: #f59e0b;
      --sidebar-w: 240px;
      --radius: 8px;
    }

    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }

    /* login */
    #login-screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 40px; width: 360px; }
    .login-card h1 { font-size: 20px; margin-bottom: 8px; }
    .login-card p { color: var(--text2); margin-bottom: 24px; font-size: 13px; }

    /* layout */
    #app { display: none; }
    .layout { display: flex; min-height: 100vh; }

    /* sidebar */
    .sidebar { width: var(--sidebar-w); background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; top: 0; left: 0; bottom: 0; overflow-y: auto; }
    .sidebar-header { padding: 20px 16px 12px; border-bottom: 1px solid var(--border); }
    .sidebar-header h2 { font-size: 15px; font-weight: 600; }
    .sidebar-header p { font-size: 12px; color: var(--text2); margin-top: 2px; }
    .sidebar-section { padding: 12px 8px; border-bottom: 1px solid var(--border); flex: 1; overflow-y: auto; }
    .sidebar-section-label { font-size: 11px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.05em; padding: 0 8px; margin-bottom: 4px; }
    .account-item { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; transition: background 0.15s; font-size: 13px; }
    .account-item:hover { background: var(--bg3); }
    .account-item.active { background: var(--bg3); font-weight: 500; }
    .account-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
    .account-dot.ok { background: var(--success); }
    .sidebar-footer { padding: 12px 8px; }
    .btn-add-account { width: 100%; }

    /* main content */
    .main { margin-left: var(--sidebar-w); flex: 1; padding: 24px; }
    .main-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .main-header h1 { font-size: 18px; font-weight: 600; }

    /* tabs */
    .tabs { display: flex; gap: 2px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
    .tab { padding: 8px 16px; cursor: pointer; color: var(--text2); font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); border-bottom-color: var(--primary); font-weight: 500; }

    /* table */
    .table-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 16px; font-size: 11px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.04em; background: var(--bg3); border-bottom: 1px solid var(--border); }
    td { padding: 10px 16px; border-bottom: 1px solid var(--border); }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(0,0,0,0.02); }

    /* badges */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 500; }
    .badge-success { background: #d1fae5; color: #065f46; }
    .badge-error { background: #fee2e2; color: #991b1b; }
    .badge-warning { background: #fef3c7; color: #92400e; }
    .badge-info { background: var(--bg3); color: var(--text2); }
    .badge-running { background: #dbeafe; color: #1e40af; }

    /* buttons */
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); font-size: 13px; cursor: pointer; transition: all 0.15s; font-family: inherit; white-space: nowrap; }
    .btn:hover { background: var(--bg3); }
    .btn-primary { background: var(--primary); color: white; border-color: var(--primary); }
    .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .btn-danger { color: var(--error); border-color: #fca5a5; }
    .btn-danger:hover { background: #fee2e2; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-group { display: flex; gap: 4px; }

    /* forms */
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    input, select, textarea { width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 13px; font-family: inherit; transition: border-color 0.15s; outline: none; }
    input:focus, select:focus, textarea:focus { border-color: var(--primary); }
    textarea { resize: vertical; min-height: 80px; }
    .form-hint { font-size: 12px; color: var(--text2); margin-top: 4px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

    /* modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 24px; }
    .modal { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; }
    .modal-lg { max-width: 560px; }
    .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .modal-header h3 { font-size: 15px; font-weight: 600; }
    .modal-body { padding: 20px; }
    .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 20px; border-top: 1px solid var(--border); }
    .modal-close { background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text2); padding: 4px; }

    /* toast */
    #toast-container { position: fixed; top: 16px; right: 16px; z-index: 200; display: flex; flex-direction: column; gap: 8px; }
    .toast { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 320px; animation: slide-in 0.2s ease; }
    .toast-success { border-left: 3px solid var(--success); }
    .toast-error { border-left: 3px solid var(--error); }
    @keyframes slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* task log */
    .log-list { display: flex; flex-direction: column; gap: 4px; }
    .log-item { display: flex; gap: 8px; font-size: 12px; font-family: monospace; padding: 4px 8px; border-radius: 4px; background: var(--bg2); }
    .log-item.error { background: #fee2e2; }
    .log-time { color: var(--text2); flex-shrink: 0; }
    .log-step { color: var(--primary); min-width: 80px; flex-shrink: 0; }

    /* empty state */
    .empty { text-align: center; padding: 48px 24px; color: var(--text2); }
    .empty p { margin-top: 8px; font-size: 13px; }

    /* no account selected */
    .no-account { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--text2); font-size: 14px; }

    .hidden { display: none !important; }
    .flex { display: flex; }
    .gap-2 { gap: 8px; }
    .align-center { align-items: center; }
    .justify-between { justify-content: space-between; }
    .mb-4 { margin-bottom: 16px; }
    .text-sm { font-size: 12px; }
    .text-muted { color: var(--text2); }
  </style>
</head>
<body>

<!-- Toast container -->
<div id="toast-container"></div>

<!-- Login -->
<div id="login-screen">
  <div class="login-card">
    <h1>Azure Manager</h1>
    <p>输入访问密码登录</p>
    <div class="form-group">
      <label>密码</label>
      <input type="password" id="login-password" placeholder="访问密码" autocomplete="current-password" />
    </div>
    <button class="btn btn-primary" style="width:100%" id="login-btn">登录</button>
    <div id="login-error" class="hidden" style="margin-top:12px;color:var(--error);font-size:13px;"></div>
  </div>
</div>

<!-- App -->
<div id="app">
  <div class="layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>Azure Manager</h2>
        <p id="sidebar-account-count" class="text-muted text-sm">加载中...</p>
      </div>
      <div class="sidebar-section" style="flex:1">
        <div class="sidebar-section-label">Azure 账户</div>
        <div id="account-list"></div>
      </div>
      <div class="sidebar-footer" style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-sm btn-add-account" id="btn-add-account">+ 添加账户</button>
        <button class="btn btn-sm" id="btn-logout">退出登录</button>
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <!-- no account selected -->
      <div id="view-no-account">
        <div class="main-header">
          <h1>Azure Manager</h1>
        </div>
        <div class="no-account">请从左侧选择一个 Azure 账户</div>
      </div>

      <!-- account selected -->
      <div id="view-account" class="hidden">
        <div class="main-header">
          <h1 id="account-title">-</h1>
          <div class="btn-group">
            <button class="btn btn-sm" id="btn-refresh">刷新</button>
            <button class="btn btn-sm" id="btn-create-vm">创建虚拟机</button>
            <button class="btn btn-sm" id="btn-edit-account">编辑</button>
            <button class="btn btn-sm btn-danger" id="btn-delete-account">删除账户</button>
          </div>
        </div>

        <div class="tabs">
          <div class="tab active" data-tab="vms">虚拟机</div>
          <div class="tab" data-tab="tasks">任务</div>
          <div class="tab" data-tab="settings">设置</div>
        </div>

        <!-- VMs tab -->
        <div id="tab-vms">
          <div class="table-wrap" id="vm-table-wrap">
            <table>
              <thead><tr><th>名称</th><th>资源组</th><th>区域</th><th>大小</th><th>状态</th><th>公网 IP</th><th>操作</th></tr></thead>
              <tbody id="vm-tbody"></tbody>
            </table>
          </div>
        </div>

        <!-- Tasks tab -->
        <div id="tab-tasks" class="hidden">
          <div id="task-list"></div>
        </div>

        <!-- Settings tab -->
        <div id="tab-settings" class="hidden">
          <div style="max-width:600px">
            <div class="form-group">
              <label>全局开机脚本（User Data）</label>
              <textarea id="startup-script" rows="10" style="font-family:monospace;font-size:12px"></textarea>
              <div class="form-hint">创建虚拟机时默认使用此脚本，可在创建时覆盖</div>
            </div>
            <button class="btn btn-primary" id="btn-save-script">保存脚本</button>
          </div>
        </div>
      </div>
    </main>
  </div>
</div>

<!-- Modal: 添加账户 -->
<div id="modal-add-account" class="modal-overlay hidden">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modal-add-title">添加 Azure 账户</h3>
      <button class="modal-close" data-close="modal-add-account">×</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label>账户名称</label><input type="text" id="add-name" placeholder="例：My Azure Account" /></div>
      <div class="form-group"><label>Client ID</label><input type="text" id="add-client-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></div>
      <div class="form-group"><label>Client Secret</label><input type="password" id="add-client-secret" /></div>
      <div class="form-group"><label>Tenant ID</label><input type="text" id="add-tenant-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></div>
      <div class="form-group"><label>Subscription ID</label><input type="text" id="add-subscription-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></div>
      <div class="form-group"><label>过期日期（可选）</label><input type="date" id="add-expiration" /></div>
      <div id="add-check-result" class="hidden" style="padding:10px;border-radius:6px;font-size:13px;margin-top:8px;"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" data-close="modal-add-account">取消</button>
      <button class="btn" id="btn-check-account">检查账户</button>
      <button class="btn btn-primary" id="btn-save-account">保存</button>
    </div>
  </div>
</div>

<!-- Modal: 编辑账户 -->
<div id="modal-edit-account" class="modal-overlay hidden">
  <div class="modal">
    <div class="modal-header">
      <h3>编辑账户</h3>
      <button class="modal-close" data-close="modal-edit-account">×</button>
    </div>
    <div class="modal-body">
      <input type="hidden" id="edit-account-id" />
      <div class="form-group"><label>账户名称</label><input type="text" id="edit-name" /></div>
      <div class="form-group"><label>过期日期（可选）</label><input type="date" id="edit-expiration" /></div>
    </div>
    <div class="modal-footer">
      <button class="btn" data-close="modal-edit-account">取消</button>
      <button class="btn btn-primary" id="btn-save-edit">保存</button>
    </div>
  </div>
</div>

<!-- Modal: 创建 VM -->
<div id="modal-create-vm" class="modal-overlay hidden">
  <div class="modal modal-lg">
    <div class="modal-header">
      <h3>创建虚拟机</h3>
      <button class="modal-close" data-close="modal-create-vm">×</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label>区域</label>
          <select id="create-region"><option value="">加载中...</option></select>
        </div>
        <div class="form-group">
          <label>实例类型</label>
          <select id="create-vm-size">
            <option value="Standard_B1s">Standard_B1s (1vCPU / 1GB)</option>
            <option value="Standard_B1ms">Standard_B1ms (1vCPU / 2GB)</option>
            <option value="Standard_B2s">Standard_B2s (2vCPU / 4GB)</option>
            <option value="Standard_B2ms">Standard_B2ms (2vCPU / 8GB)</option>
            <option value="Standard_D2s_v3">Standard_D2s_v3 (2vCPU / 8GB)</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>操作系统</label>
          <select id="create-os">
            <option value="debian12">Debian 12</option>
            <option value="debian11">Debian 11</option>
            <option value="ubuntu22">Ubuntu 22.04</option>
            <option value="ubuntu20">Ubuntu 20.04</option>
          </select>
        </div>
        <div class="form-group">
          <label>磁盘大小 (GB)</label>
          <input type="number" id="create-disk" value="30" min="30" max="1024" />
        </div>
      </div>
      <div class="form-group">
        <label>公网 IP 类型</label>
        <select id="create-ip-type">
          <option value="Static">静态 (Static)</option>
          <option value="Dynamic">动态 (Dynamic)</option>
        </select>
      </div>
      <div class="form-group">
        <label>开机脚本（留空使用全局默认）</label>
        <textarea id="create-userdata" rows="5" style="font-family:monospace;font-size:12px" placeholder="#!/bin/bash&#10;..."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" data-close="modal-create-vm">取消</button>
      <button class="btn btn-primary" id="btn-submit-create-vm">创建</button>
    </div>
  </div>
</div>

<!-- Modal: VM 操作确认 -->
<div id="modal-vm-action" class="modal-overlay hidden">
  <div class="modal">
    <div class="modal-header">
      <h3 id="vm-action-title">确认操作</h3>
      <button class="modal-close" data-close="modal-vm-action">×</button>
    </div>
    <div class="modal-body">
      <p id="vm-action-desc" style="font-size:14px;"></p>
    </div>
    <div class="modal-footer">
      <button class="btn" data-close="modal-vm-action">取消</button>
      <button class="btn btn-primary" id="btn-confirm-vm-action">确认</button>
    </div>
  </div>
</div>

<!-- Modal: 任务详情 -->
<div id="modal-task-detail" class="modal-overlay hidden">
  <div class="modal modal-lg">
    <div class="modal-header">
      <h3>任务详情</h3>
      <button class="modal-close" data-close="modal-task-detail">×</button>
    </div>
    <div class="modal-body">
      <div id="task-detail-info" style="margin-bottom:16px;"></div>
      <div class="log-list" id="task-detail-logs"></div>
    </div>
  </div>
</div>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: redesign UI with warm gray minimal style"
```

---

## Task 10: 重写前端 public/app.js

**Files:**
- Modify: `public/app.js`

全量替换，保留所有原有功能（账户管理、VM 操作、任务轮询等），调用同样的 API 端点。

- [ ] **Step 1: 写 public/app.js（完整实现）**

```javascript
// ---- state ----
let state = {
  loggedIn: false,
  accounts: [],
  selectedAccountId: null,
  selectedAccountName: null,
  vms: [],
  tasks: [],
  regions: [],
  startupScript: '',
  activeTab: 'vms',
  pendingVmAction: null,
};

// ---- api ----
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

// ---- toast ----
function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---- modal ----
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) closeModal(close.dataset.close);
  const overlay = e.target.closest('.modal-overlay');
  if (overlay && e.target === overlay) closeModal(overlay.id);
});

// ---- render ----
function renderAccountList() {
  const list = document.getElementById('account-list');
  const count = document.getElementById('sidebar-account-count');
  count.textContent = `${state.accounts.length} 个账户`;
  if (!state.accounts.length) {
    list.innerHTML = '<div style="padding:8px;font-size:13px;color:var(--text2)">暂无账户</div>';
    return;
  }
  list.innerHTML = state.accounts.map(a => `
    <div class="account-item ${a.id === state.selectedAccountId ? 'active' : ''}" data-id="${a.id}">
      <span class="account-dot ok"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span>
    </div>
  `).join('');
  list.querySelectorAll('.account-item').forEach(item => {
    item.addEventListener('click', () => selectAccount(item.dataset.id));
  });
}

function renderVms() {
  const tbody = document.getElementById('vm-tbody');
  if (!state.vms.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">暂无虚拟机</div></td></tr>';
    return;
  }
  tbody.innerHTML = state.vms.map(vm => {
    const status = vm.powerState || '-';
    const ip = vm.publicIpAddress || '-';
    const badgeClass = status.includes('running') ? 'badge-success' : status.includes('stopped') ? 'badge-error' : 'badge-info';
    return `
      <tr>
        <td><strong>${esc(vm.name)}</strong></td>
        <td class="text-muted">${esc(vm.resourceGroup)}</td>
        <td class="text-muted">${esc(vm.location)}</td>
        <td class="text-muted">${esc(vm.vmSize || '-')}</td>
        <td><span class="badge ${badgeClass}">${esc(status)}</span></td>
        <td style="font-family:monospace;font-size:12px">${esc(ip)}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="vmAction('start','${esc(vm.resourceGroup)}','${esc(vm.name)}')">启动</button>
            <button class="btn btn-sm" onclick="vmAction('stop','${esc(vm.resourceGroup)}','${esc(vm.name)}')">停止</button>
            <button class="btn btn-sm" onclick="vmAction('restart','${esc(vm.resourceGroup)}','${esc(vm.name)}')">重启</button>
            <button class="btn btn-sm" onclick="changeIp('${esc(vm.resourceGroup)}','${esc(vm.name)}')">换IP</button>
            <button class="btn btn-sm btn-danger" onclick="vmAction('delete','${esc(vm.resourceGroup)}','${esc(vm.name)}')">删除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderTasks() {
  const list = document.getElementById('task-list');
  if (!state.tasks.length) {
    list.innerHTML = '<div class="empty"><p>暂无任务</p></div>';
    return;
  }
  list.innerHTML = state.tasks.map(t => {
    const badgeClass = { success: 'badge-success', failure: 'badge-error', running: 'badge-running', queued: 'badge-info' }[t.status] || 'badge-info';
    return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:8px;cursor:pointer" onclick="openTaskDetail('${t.id}')">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:13px;font-weight:500">${esc(t.message || t.type)}</span>
          <span class="badge ${badgeClass}">${esc(t.status)}</span>
        </div>
        <div style="font-size:12px;color:var(--text2)">${esc(t.createdAt || '')}</div>
      </div>
    `;
  }).join('');
}

// ---- actions ----
async function selectAccount(id) {
  try {
    await api('POST', '/api/session', { accountId: id });
    state.selectedAccountId = id;
    const acc = state.accounts.find(a => a.id === id);
    state.selectedAccountName = acc?.name || '';
    renderAccountList();
    document.getElementById('account-title').textContent = state.selectedAccountName;
    document.getElementById('view-no-account').classList.add('hidden');
    document.getElementById('view-account').classList.remove('hidden');
    await Promise.all([loadVms(), loadRegions(), loadStartupScript()]);
  } catch (e) { toast(e.message, 'error'); }
}

async function loadVms() {
  try {
    state.vms = await api('GET', '/api/vms');
    renderVms();
  } catch (e) { toast(`加载虚拟机失败: ${e.message}`, 'error'); }
}

async function loadRegions() {
  try {
    state.regions = await api('GET', '/api/regions');
    const sel = document.getElementById('create-region');
    sel.innerHTML = state.regions.map(r => `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`).join('');
  } catch (e) { /* non-critical */ }
}

async function loadStartupScript() {
  try {
    const data = await api('GET', '/api/settings/startup-script');
    state.startupScript = data.userData || '';
    document.getElementById('startup-script').value = state.startupScript;
  } catch (e) { /* non-critical */ }
}

function vmAction(action, resourceGroup, vmName) {
  const labels = { start: '启动', stop: '停止', restart: '重启', delete: '删除资源组' };
  state.pendingVmAction = { action, resourceGroup, vmName };
  document.getElementById('vm-action-title').textContent = `${labels[action]} - ${vmName}`;
  document.getElementById('vm-action-desc').textContent = action === 'delete'
    ? `确认删除资源组 ${resourceGroup}？此操作不可撤销，将删除该资源组内所有资源。`
    : `确认对虚拟机 ${vmName} 执行 ${labels[action]} 操作？`;
  openModal('modal-vm-action');
}

function changeIp(resourceGroup, vmName) {
  state.pendingVmAction = { action: 'change-ip', resourceGroup, vmName };
  document.getElementById('vm-action-title').textContent = `更换公网 IP - ${vmName}`;
  document.getElementById('vm-action-desc').textContent = `确认为虚拟机 ${vmName} 更换公网 IP？操作期间 IP 将短暂不可用。`;
  openModal('modal-vm-action');
}

async function openTaskDetail(taskId) {
  try {
    const task = await api('GET', `/api/task_status/${taskId}`);
    const info = document.getElementById('task-detail-info');
    const badgeClass = { success: 'badge-success', failure: 'badge-error', running: 'badge-running', queued: 'badge-info' }[task.status] || 'badge-info';
    info.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
        <span class="badge ${badgeClass}">${esc(task.status)}</span>
        <span style="font-size:13px">${esc(task.message || '')}</span>
      </div>
      ${task.result ? `<pre style="font-size:12px;background:var(--bg2);padding:12px;border-radius:6px;overflow:auto;margin-bottom:12px">${esc(JSON.stringify(task.result, null, 2))}</pre>` : ''}
    `;
    const logsEl = document.getElementById('task-detail-logs');
    logsEl.innerHTML = (task.logs || []).map(l => `
      <div class="log-item ${l.level === 'error' ? 'error' : ''}">
        <span class="log-time">${l.createdAt?.slice(11, 19) || ''}</span>
        <span class="log-step">[${esc(l.step)}]</span>
        <span>${esc(l.message)}</span>
      </div>
    `).join('');
    openModal('modal-task-detail');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- init ----
async function init() {
  try {
    const session = await api('GET', '/api/session');
    if (!session.loggedIn) { showLogin(); return; }
    state.loggedIn = true;
    state.selectedAccountId = session.selectedAccountId;
    state.selectedAccountName = session.selectedAccountName;
    await loadAccounts();
    showApp();
    if (state.selectedAccountId) {
      const acc = state.accounts.find(a => a.id === state.selectedAccountId);
      if (acc) {
        document.getElementById('account-title').textContent = acc.name;
        document.getElementById('view-no-account').classList.add('hidden');
        document.getElementById('view-account').classList.remove('hidden');
        await Promise.all([loadVms(), loadRegions(), loadStartupScript()]);
      }
    }
  } catch (e) { showLogin(); }
}

async function loadAccounts() {
  state.accounts = await api('GET', '/api/accounts');
  renderAccountList();
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- event wiring ----
document.getElementById('login-btn').addEventListener('click', async () => {
  const pw = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/auth/login', { password: pw });
    state.loggedIn = true;
    await loadAccounts();
    showApp();
  } catch (e) {
    err.textContent = e.status === 401 ? '密码错误' : e.message;
    err.classList.remove('hidden');
  }
});

document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

document.getElementById('btn-refresh').addEventListener('click', async () => {
  if (!state.selectedAccountId) return;
  await loadVms();
  toast('已刷新');
});

// tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-vms').classList.toggle('hidden', state.activeTab !== 'vms');
    document.getElementById('tab-tasks').classList.toggle('hidden', state.activeTab !== 'tasks');
    document.getElementById('tab-settings').classList.toggle('hidden', state.activeTab !== 'settings');
    if (state.activeTab === 'tasks') loadTaskList();
  });
});

async function loadTaskList() {
  // 简单：直接从最近任务 API 获取（当前 API 只有 task_status/:id，用已知任务 id 轮询）
  // TODO: 如需完整任务列表可添加 /api/tasks 接口
  renderTasks();
}

// add account
document.getElementById('btn-add-account').addEventListener('click', () => {
  ['add-name','add-client-id','add-client-secret','add-tenant-id','add-subscription-id','add-expiration'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('add-check-result').classList.add('hidden');
  openModal('modal-add-account');
});

document.getElementById('btn-check-account').addEventListener('click', async () => {
  const btn = document.getElementById('btn-check-account');
  const result = document.getElementById('add-check-result');
  btn.disabled = true;
  btn.textContent = '检查中...';
  try {
    const data = await api('POST', '/api/accounts/check', {
      clientId: document.getElementById('add-client-id').value.trim(),
      clientSecret: document.getElementById('add-client-secret').value.trim(),
      tenantId: document.getElementById('add-tenant-id').value.trim(),
      subscriptionId: document.getElementById('add-subscription-id').value.trim(),
    });
    result.style.background = '#d1fae5';
    result.style.color = '#065f46';
    result.textContent = `✓ ${data.subscriptionDisplayName} | 状态: ${data.state} | 可用区域: ${data.availableRegionCount}`;
    result.classList.remove('hidden');
  } catch (e) {
    result.style.background = '#fee2e2';
    result.style.color = '#991b1b';
    result.textContent = `✗ ${e.message}`;
    result.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '检查账户';
  }
});

document.getElementById('btn-save-account').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-account');
  btn.disabled = true;
  try {
    const expVal = document.getElementById('add-expiration').value;
    await api('POST', '/api/accounts', {
      name: document.getElementById('add-name').value.trim(),
      clientId: document.getElementById('add-client-id').value.trim(),
      clientSecret: document.getElementById('add-client-secret').value.trim(),
      tenantId: document.getElementById('add-tenant-id').value.trim(),
      subscriptionId: document.getElementById('add-subscription-id').value.trim(),
      expirationDate: expVal || null,
    });
    closeModal('modal-add-account');
    await loadAccounts();
    toast('账户已添加', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// edit account
document.getElementById('btn-edit-account').addEventListener('click', () => {
  const acc = state.accounts.find(a => a.id === state.selectedAccountId);
  if (!acc) return;
  document.getElementById('edit-account-id').value = acc.id;
  document.getElementById('edit-name').value = acc.name;
  document.getElementById('edit-expiration').value = acc.expirationDate || '';
  openModal('modal-edit-account');
});

document.getElementById('btn-save-edit').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-edit');
  btn.disabled = true;
  try {
    const expVal = document.getElementById('edit-expiration').value;
    await api('POST', '/api/accounts/edit', {
      accountId: document.getElementById('edit-account-id').value,
      newName: document.getElementById('edit-name').value.trim(),
      expirationDate: expVal || null,
    });
    closeModal('modal-edit-account');
    await loadAccounts();
    state.selectedAccountName = document.getElementById('edit-name').value.trim();
    document.getElementById('account-title').textContent = state.selectedAccountName;
    toast('账户已更新', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// delete account
document.getElementById('btn-delete-account').addEventListener('click', async () => {
  if (!state.selectedAccountId) return;
  const acc = state.accounts.find(a => a.id === state.selectedAccountId);
  if (!confirm(`确认删除账户 "${acc?.name}"？`)) return;
  try {
    await api('DELETE', `/api/accounts/${state.selectedAccountId}`);
    state.selectedAccountId = null;
    state.selectedAccountName = null;
    document.getElementById('view-account').classList.add('hidden');
    document.getElementById('view-no-account').classList.remove('hidden');
    await loadAccounts();
    toast('账户已删除', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// create VM
document.getElementById('btn-create-vm').addEventListener('click', () => openModal('modal-create-vm'));

document.getElementById('btn-submit-create-vm').addEventListener('click', async () => {
  const btn = document.getElementById('btn-submit-create-vm');
  btn.disabled = true;
  try {
    const userData = document.getElementById('create-userdata').value.trim();
    const task = await api('POST', '/api/create-vm', {
      region: document.getElementById('create-region').value,
      vmSize: document.getElementById('create-vm-size').value,
      osImage: document.getElementById('create-os').value,
      diskSize: parseInt(document.getElementById('create-disk').value),
      ipType: document.getElementById('create-ip-type').value,
      userData: userData || null,
    });
    closeModal('modal-create-vm');
    toast(`创建任务已提交: ${task.taskId}`, 'success');
    trackTask(task.taskId);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// vm action confirm
document.getElementById('btn-confirm-vm-action').addEventListener('click', async () => {
  const p = state.pendingVmAction;
  if (!p) return;
  closeModal('modal-vm-action');
  state.pendingVmAction = null;
  try {
    let task;
    if (p.action === 'change-ip') {
      task = await api('POST', '/api/vm-change-ip', { resourceGroup: p.resourceGroup, vmName: p.vmName });
    } else {
      task = await api('POST', '/api/vm-action', { action: p.action, resourceGroup: p.resourceGroup, vmName: p.vmName });
    }
    toast(`操作已提交: ${task.taskId}`, 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
});

// save startup script
document.getElementById('btn-save-script').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-script');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings/startup-script', { userData: document.getElementById('startup-script').value });
    toast('脚本已保存', 'success');
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
});

// ---- task polling ----
const trackingTasks = new Set();

function trackTask(taskId) {
  if (trackingTasks.has(taskId)) return;
  trackingTasks.add(taskId);
  pollTask(taskId);
}

async function pollTask(taskId) {
  let tries = 0;
  while (tries < 180) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const task = await api('GET', `/api/task_status/${taskId}`);
      if (task.status === 'success') {
        toast(`任务完成`, 'success');
        trackingTasks.delete(taskId);
        if (state.selectedAccountId) loadVms();
        return;
      }
      if (task.status === 'failure') {
        toast(`任务失败: ${task.errorMessage || task.message}`, 'error');
        trackingTasks.delete(taskId);
        return;
      }
    } catch (e) { /* continue polling */ }
    tries++;
  }
  trackingTasks.delete(taskId);
}

// ---- start ----
init();
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: rewrite frontend with warm gray minimal UI"
```

---

## Task 11: 更新 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 替换 README.md**

```markdown
# Azure VM Management Panel

Azure 虚拟机管理面板，运行在 Docker 容器中，用于管理多个 Azure 订阅下的虚拟机。

## 快速部署

### 1. 克隆仓库

```bash
git clone <repo-url>
cd AzureManager
```

### 2. 生成密钥

```bash
# SESSION_SECRET（任意长随机字符串）
openssl rand -base64 48

# ACCOUNT_ENCRYPTION_KEY（必须是 32 字节 base64url）
openssl rand -base64 32
```

### 3. 编辑 docker-compose.yml，填入密钥

```yaml
environment:
  APP_PASSWORD: "your-password"
  SESSION_SECRET: "your-session-secret"
  ACCOUNT_ENCRYPTION_KEY: "your-32-byte-key"
```

### 4. 启动

```bash
docker compose up -d
```

访问 `http://localhost:8080`，用 `APP_PASSWORD` 登录。

## 迁移

数据存储在 `./data/azure-manager.db`，迁移只需复制此文件和 `ACCOUNT_ENCRYPTION_KEY`。

## 功能

- 管理多个 Azure Service Principal 账户
- 查看订阅下的虚拟机列表
- 创建、启动、停止、重启虚拟机
- 更换虚拟机公网 IP
- 删除资源组
- 全局默认开机脚本

## 安全说明

- `ACCOUNT_ENCRYPTION_KEY` 用于加密存储 Azure `client_secret`，请妥善保管，修改后已有数据无法解密
- 建议在反向代理（nginx/caddy）后面运行并启用 HTTPS
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for Docker deployment"
```

---

## Task 12: 验证端到端可运行

- [ ] **Step 1: 检查 azure/network.ts 是否导出 createVirtualNetwork**

```bash
grep -n "export.*createVirtualNetwork\|export.*getVirtualMachine" src/lib/azure/network.ts src/lib/azure/compute.ts
```

如果未导出，在对应文件中添加 export。

- [ ] **Step 2: 运行 typecheck**

```bash
bun run typecheck
```

修复所有类型错误。

- [ ] **Step 3: 本地启动测试**

```bash
APP_PASSWORD=test SESSION_SECRET=test-secret-at-least-32-chars-long ACCOUNT_ENCRYPTION_KEY=$(openssl rand -base64 32) bun src/server.ts
```

访问 `http://localhost:8080`，验证：
- 登录页正常显示
- 密码登录成功
- 页面跳转到主界面
- 添加账户弹窗正常
- `/health` 返回 `{"ok":true,...}`

- [ ] **Step 4: Docker 构建测试**

```bash
docker build -t azure-manager .
docker run -p 8080:8080 -e APP_PASSWORD=test -e SESSION_SECRET=test-secret-at-least-32-chars-long -e ACCOUNT_ENCRYPTION_KEY=$(openssl rand -base64 32) azure-manager
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: complete Docker migration"
git push origin codex/ui-refresh
```

---

## 检查清单

- [x] 所有原有 API 端点保留（`/api/accounts`, `/api/vms`, `/api/create-vm`, `/api/vm-action`, `/api/vm-change-ip`, `/api/task_status/:id`, `/api/settings/startup-script`, `/api/session`, `/auth/login`, `/auth/logout`, `/health`）
- [x] 数据文件在 Docker volume 中持久化（`./data/azure-manager.db`）
- [x] 迁移只需复制 SQLite 文件
- [x] 无 Cloudflare 依赖
- [x] 单命令 `docker compose up -d` 启动
- [x] 任务状态轮询保留
- [x] Azure 账户加密存储保留
- [x] 暖灰 UI 风格
