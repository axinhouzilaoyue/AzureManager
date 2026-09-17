import type { Database } from "bun:sqlite";
import type {
  AccountRecord,
  AccountSummary,
  AppEnv,
  DecryptedAccountRecord,
  GlobalSshSettings,
  JsonRecord,
  TaskLogRecord,
  TaskRecord,
  TaskResponse,
  TaskStatus,
} from "../types";
import { decryptString, encryptString } from "./crypto";
import { nowIso, parseJsonOrNull } from "./utils";

// ---- row types (private) ----
interface AccountRow {
  id: string; name: string; client_id: string; tenant_id: string;
  subscription_id: string; client_secret_ciphertext: string;
  email: string | null; expiration_date: string | null;
  display_order: number;
  subscription_name: string | null; subscription_state: string | null; quota_tier: string | null;
  cost_mtd: string | null; cost_acc: string | null; cost_history: string | null;
  cost_currency: string | null; cost_updated_at: string | null;
  created_at: string; updated_at: string;
}
interface TaskRow {
  id: string; account_id: string; type: string; status: TaskStatus;
  lock_key: string | null; message: string | null; result_json: string | null;
  error_code: string | null; error_message: string | null; idempotency_key: string;
  created_by: string; created_at: string; updated_at: string;
  started_at: string | null; completed_at: string | null;
}
interface TaskLogRow {
  id: number; task_id: string; step: string; level: string;
  message: string; detail_json: string | null; created_at: string;
}

function mapAccountRow(r: AccountRow): AccountRecord {
  return {
    id: r.id,
    name: r.name,
    clientId: r.client_id,
    tenantId: r.tenant_id,
    subscriptionId: r.subscription_id,
    clientSecretCiphertext: r.client_secret_ciphertext,
    email: r.email ?? null,
    expirationDate: r.expiration_date,
    displayOrder: r.display_order ?? 0,
    subscriptionName: r.subscription_name ?? null,
    subscriptionState: r.subscription_state ?? null,
    quotaTier: r.quota_tier ?? null,
    costMtd: r.cost_mtd ?? null,
    costAcc: r.cost_acc ?? null,
    costHistory: r.cost_history ?? null,
    costCurrency: r.cost_currency ?? null,
    costUpdatedAt: r.cost_updated_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toSummary(a: AccountRecord): AccountSummary {
  return {
    id: a.id,
    name: a.name,
    clientId: a.clientId,
    tenantId: a.tenantId,
    subscriptionId: a.subscriptionId,
    email: a.email,
    expirationDate: a.expirationDate,
    displayOrder: a.displayOrder,
    subscriptionName: a.subscriptionName,
    subscriptionState: a.subscriptionState,
    quotaTier: a.quotaTier,
    costMtd: a.costMtd,
    costAcc: a.costAcc,
    costHistory: a.costHistory,
    costCurrency: a.costCurrency,
    costUpdatedAt: a.costUpdatedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
function mapTaskRow(r: TaskRow): TaskRecord {
  return { id: r.id, accountId: r.account_id, type: r.type, status: r.status, lockKey: r.lock_key, message: r.message, resultJson: r.result_json, errorCode: r.error_code, errorMessage: r.error_message, idempotencyKey: r.idempotency_key, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, completedAt: r.completed_at };
}
function mapTaskLogRow(r: TaskLogRow): TaskLogRecord {
  return { id: r.id, taskId: r.task_id, step: r.step, level: r.level, message: r.message, detailJson: r.detail_json, createdAt: r.created_at };
}

const STARTUP_SCRIPT_SETTING_KEY = "global_startup_script";
const GLOBAL_SSH_PUBLIC_KEY_SETTING = "global_ssh_public_key";
const GLOBAL_SSH_USERNAME_SETTING = "global_ssh_username";
const GLOBAL_SSH_PASSWORD_SETTING = "global_ssh_password";
const DEFAULT_STARTUP_SCRIPT = `#!/bin/bash\nset -euxo pipefail\necho "Provisioned by Azure VM Management Panel" > /etc/motd`;

export function initializeDatabase(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
      client_secret_ciphertext TEXT NOT NULL, email TEXT, expiration_date TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      subscription_name TEXT, subscription_state TEXT, quota_tier TEXT,
      cost_mtd TEXT, cost_acc TEXT, cost_history TEXT, cost_currency TEXT, cost_updated_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_subscription_id ON accounts(subscription_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, lock_key TEXT, message TEXT, result_json TEXT,
      error_code TEXT, error_message TEXT, idempotency_key TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      step TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
      detail_json TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id, id);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
    );
  `);

  // Lightweight migration for existing local DBs.
  const accountCols = db.prepare(`PRAGMA table_info(accounts)`).all() as Array<{ name: string }>;
  const accountColumnNames = new Set(accountCols.map((col) => col.name));
  const migrations: Record<string, string> = {
    email: `ALTER TABLE accounts ADD COLUMN email TEXT`,
    display_order: `ALTER TABLE accounts ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0`,
    subscription_name: `ALTER TABLE accounts ADD COLUMN subscription_name TEXT`,
    subscription_state: `ALTER TABLE accounts ADD COLUMN subscription_state TEXT`,
    quota_tier: `ALTER TABLE accounts ADD COLUMN quota_tier TEXT`,
    cost_mtd: `ALTER TABLE accounts ADD COLUMN cost_mtd TEXT`,
    cost_acc: `ALTER TABLE accounts ADD COLUMN cost_acc TEXT`,
    cost_history: `ALTER TABLE accounts ADD COLUMN cost_history TEXT`,
    cost_currency: `ALTER TABLE accounts ADD COLUMN cost_currency TEXT`,
    cost_updated_at: `ALTER TABLE accounts ADD COLUMN cost_updated_at TEXT`,
  };
  for (const [column, statement] of Object.entries(migrations)) {
    if (!accountColumnNames.has(column)) db.exec(statement);
  }
}

const ACCOUNT_SELECT = `SELECT id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext,
  email, expiration_date, display_order, subscription_name, subscription_state, quota_tier,
  cost_mtd, cost_acc, cost_history, cost_currency, cost_updated_at,
  created_at, updated_at FROM accounts`;

export async function listAccounts(env: AppEnv): Promise<AccountSummary[]> {
  const rows = env.DB.prepare(`${ACCOUNT_SELECT} ORDER BY display_order ASC, name ASC`).all() as AccountRow[];
  return rows.map((r) => toSummary(mapAccountRow(r)));
}

export async function getAccountById(env: AppEnv, accountId: string): Promise<AccountRecord | null> {
  const row = env.DB.prepare(`${ACCOUNT_SELECT} WHERE id = ?`).get(accountId) as AccountRow | null;
  return row ? mapAccountRow(row) : null;
}

export async function getDecryptedAccountById(env: AppEnv, accountId: string): Promise<DecryptedAccountRecord | null> {
  const account = await getAccountById(env, accountId);
  if (!account) return null;
  return {
    id: account.id, name: account.name, clientId: account.clientId,
    tenantId: account.tenantId, subscriptionId: account.subscriptionId,
    clientSecret: await decryptString(env.ACCOUNT_ENCRYPTION_KEY, account.clientSecretCiphertext),
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
    createdAt: account.createdAt, updatedAt: account.updatedAt,
  };
}

export async function createAccount(env: AppEnv, input: {
  id: string; name: string; clientId: string; tenantId: string;
  subscriptionId: string; clientSecret: string; email?: string | null; expirationDate: string | null;
}): Promise<AccountSummary> {
  const timestamp = nowIso();
  const email = input.email ?? null;
  const ciphertext = await encryptString(env.ACCOUNT_ENCRYPTION_KEY, input.clientSecret);
  const orderRow = env.DB.prepare(`SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM accounts`).get() as { next_order: number };
  const displayOrder = orderRow?.next_order ?? 0;
  env.DB.prepare(
    `INSERT INTO accounts (id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, email, expiration_date, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.id, input.name, input.clientId, input.tenantId, input.subscriptionId, ciphertext, email, input.expirationDate, displayOrder, timestamp, timestamp);
  return {
    id: input.id,
    name: input.name,
    clientId: input.clientId,
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    email,
    expirationDate: input.expirationDate,
    displayOrder,
    subscriptionName: null,
    subscriptionState: null,
    quotaTier: null,
    costMtd: null,
    costAcc: null,
    costHistory: null,
    costCurrency: null,
    costUpdatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function reorderAccounts(env: AppEnv, accountIds: string[]): Promise<void> {
  const update = env.DB.prepare(`UPDATE accounts SET display_order = ?, updated_at = ? WHERE id = ?`);
  const transaction = env.DB.transaction((ids: string[]) => {
    ids.forEach((id, index) => update.run(index, nowIso(), id));
  });
  transaction(accountIds);
}

export async function updateAccountInsights(env: AppEnv, input: {
  accountId: string;
  subscriptionName?: string | null;
  subscriptionState?: string | null;
  quotaTier?: string | null;
}): Promise<void> {
  const current = await getAccountById(env, input.accountId);
  if (!current) return;
  env.DB.prepare(
    `UPDATE accounts SET subscription_name = ?, subscription_state = ?, quota_tier = ?, updated_at = ? WHERE id = ?`
  ).run(
    input.subscriptionName ?? current.subscriptionName,
    input.subscriptionState ?? current.subscriptionState,
    input.quotaTier ?? current.quotaTier,
    nowIso(),
    input.accountId,
  );
}

export async function updateAccountCost(env: AppEnv, accountId: string, cost: {
  mtd: string;
  acc: string;
  history: string;
  currency: string;
  queriedAt: string;
}): Promise<void> {
  env.DB.prepare(
    `UPDATE accounts SET cost_mtd = ?, cost_acc = ?, cost_history = ?, cost_currency = ?, cost_updated_at = ?, updated_at = ? WHERE id = ?`
  ).run(cost.mtd, cost.acc, cost.history, cost.currency, cost.queriedAt, nowIso(), accountId);
}

export async function updateAccountMetadata(env: AppEnv, input: {
  accountId: string; newName: string; email?: string | null; expirationDate: string | null;
}): Promise<void> {
  if (input.email === undefined) {
    env.DB.prepare(`UPDATE accounts SET name = ?, expiration_date = ?, updated_at = ? WHERE id = ?`)
      .run(input.newName, input.expirationDate, nowIso(), input.accountId);
    return;
  }
  env.DB.prepare(`UPDATE accounts SET name = ?, email = ?, expiration_date = ?, updated_at = ? WHERE id = ?`)
    .run(input.newName, input.email, input.expirationDate, nowIso(), input.accountId);
}

export async function deleteAccount(env: AppEnv, accountId: string): Promise<void> {
  env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
}

export async function accountNameExists(env: AppEnv, name: string, excludeAccountId?: string): Promise<boolean> {
  const row = env.DB.prepare(
    `SELECT id FROM accounts WHERE name = ? AND (? IS NULL OR id != ?) LIMIT 1`
  ).get(name, excludeAccountId ?? null, excludeAccountId ?? null) as { id: string } | null;
  return Boolean(row);
}

export async function getGlobalStartupScript(env: AppEnv): Promise<string> {
  const row = env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(STARTUP_SCRIPT_SETTING_KEY) as { value: string } | null;
  return row?.value ?? DEFAULT_STARTUP_SCRIPT;
}

export async function setGlobalStartupScript(env: AppEnv, input: { userData: string; updatedBy: string }): Promise<void> {
  env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(STARTUP_SCRIPT_SETTING_KEY, input.userData, nowIso(), input.updatedBy);
}

export async function getGlobalSshSettings(env: AppEnv): Promise<GlobalSshSettings> {
  const rows = env.DB.prepare(
    `SELECT key, value, updated_at FROM app_settings WHERE key IN (?, ?, ?)`
  ).all(
    GLOBAL_SSH_PUBLIC_KEY_SETTING,
    GLOBAL_SSH_USERNAME_SETTING,
    GLOBAL_SSH_PASSWORD_SETTING,
  ) as Array<{ key: string; value: string; updated_at: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const encryptedPassword = values.get(GLOBAL_SSH_PASSWORD_SETTING) ?? "";
  let password = "";
  if (encryptedPassword) {
    try {
      password = await decryptString(env.ACCOUNT_ENCRYPTION_KEY, encryptedPassword);
    } catch {
      password = "";
    }
  }
  return {
    publicKey: values.get(GLOBAL_SSH_PUBLIC_KEY_SETTING) ?? "",
    username: values.get(GLOBAL_SSH_USERNAME_SETTING) ?? "",
    password,
    updatedAt: rows.map((row) => row.updated_at).sort().at(-1) ?? null,
  };
}

export async function setGlobalSshSettings(env: AppEnv, input: {
  publicKey: string;
  username: string;
  password: string;
  updatedBy: string;
}): Promise<void> {
  const timestamp = nowIso();
  const upsert = env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  );
  const existingPassword = env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(GLOBAL_SSH_PASSWORD_SETTING) as { value: string } | null;
  const encryptedPassword = input.password
    ? await encryptString(env.ACCOUNT_ENCRYPTION_KEY, input.password)
    : (existingPassword?.value ?? "");
  const transaction = env.DB.transaction(() => {
    upsert.run(GLOBAL_SSH_PUBLIC_KEY_SETTING, input.publicKey, timestamp, input.updatedBy);
    upsert.run(GLOBAL_SSH_USERNAME_SETTING, input.username, timestamp, input.updatedBy);
    upsert.run(GLOBAL_SSH_PASSWORD_SETTING, encryptedPassword, timestamp, input.updatedBy);
  });
  transaction();
}

export async function createTask(env: AppEnv, input: {
  id: string; accountId: string; type: string;
  lockKey: string; createdBy: string; message: string;
}): Promise<void> {
  const timestamp = nowIso();
  env.DB.prepare(
    `INSERT INTO tasks (id, account_id, type, status, lock_key, message,
      result_json, error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at)
     VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`
  ).run(input.id, input.accountId, input.type, input.lockKey, input.message, input.id, input.createdBy, timestamp, timestamp);
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

export async function markTaskFailure(env: AppEnv, taskId: string, input: {
  message: string; errorCode?: string | null; errorMessage?: string | null; result?: JsonRecord | string | null;
}): Promise<void> {
  const ts = nowIso();
  env.DB.prepare(
    `UPDATE tasks SET status = 'failure', message = ?, result_json = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`
  ).run(
    input.message,
    input.result === undefined || input.result === null ? null : JSON.stringify(input.result),
    input.errorCode ?? null, input.errorMessage ?? null, ts, ts, taskId
  );
}

export async function appendTaskLog(env: AppEnv, taskId: string, input: {
  step: string; message: string; level?: string; detail?: JsonRecord | string | null;
}): Promise<void> {
  env.DB.prepare(
    `INSERT INTO task_logs (task_id, step, level, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    taskId, input.step, input.level ?? "info", input.message,
    input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
    nowIso()
  );
}

export async function listTasksForAccount(env: AppEnv, accountId: string, limit = 50): Promise<Array<{
  id: string;
  type: string;
  status: TaskStatus;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>> {
  const rows = env.DB.prepare(
    `SELECT id, account_id, type, status, lock_key, message, result_json,
            error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at
     FROM tasks WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(accountId, limit) as TaskRow[];
  return rows.map((r) => {
    const task = mapTaskRow(r);
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      message: task.message,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    };
  });
}

export async function getTaskResponse(env: AppEnv, taskId: string): Promise<TaskResponse | null> {
  const taskRow = env.DB.prepare(
    `SELECT id, account_id, type, status, lock_key, message, result_json,
            error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at
     FROM tasks WHERE id = ?`
  ).get(taskId) as TaskRow | null;
  if (!taskRow) return null;
  const logs = env.DB.prepare(
    `SELECT id, task_id, step, level, message, detail_json, created_at FROM task_logs WHERE task_id = ? ORDER BY id ASC`
  ).all(taskId) as TaskLogRow[];
  const task = mapTaskRow(taskRow);
  return {
    id: task.id, status: task.status, message: task.message,
    result: parseJsonOrNull<JsonRecord | string>(task.resultJson),
    errorCode: task.errorCode, errorMessage: task.errorMessage,
    logs: logs.map((r) => {
      const l = mapTaskLogRow(r);
      return { id: l.id, step: l.step, level: l.level, message: l.message, detail: parseJsonOrNull(l.detailJson), createdAt: l.createdAt };
    }),
  };
}

export async function getDecryptedAccountOrThrow(env: AppEnv, accountId: string): Promise<DecryptedAccountRecord> {
  const account = await getDecryptedAccountById(env, accountId);
  if (!account) throw new Error("account_not_found");
  return account;
}
