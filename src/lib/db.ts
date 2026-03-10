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

interface AccountRow {
  id: string;
  name: string;
  client_id: string;
  tenant_id: string;
  subscription_id: string;
  client_secret_ciphertext: string;
  expiration_date: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  account_id: string;
  type: string;
  status: TaskStatus;
  workflow_name: WorkflowName;
  workflow_instance_id: string | null;
  lock_key: string | null;
  message: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface TaskLogRow {
  id: number;
  task_id: string;
  step: string;
  level: string;
  message: string;
  detail_json: string | null;
  created_at: string;
}

interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

const STARTUP_SCRIPT_SETTING_KEY = "global_startup_script";

export const DEFAULT_STARTUP_SCRIPT = `#!/bin/bash
set -euxo pipefail
echo "Provisioned by Azure VM Management Panel" > /etc/motd`;

function mapAccountRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    clientId: row.client_id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    clientSecretCiphertext: row.client_secret_ciphertext,
    expirationDate: row.expiration_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(account: AccountRecord): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    clientId: account.clientId,
    tenantId: account.tenantId,
    subscriptionId: account.subscriptionId,
    expirationDate: account.expirationDate,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    status: row.status,
    workflowName: row.workflow_name,
    workflowInstanceId: row.workflow_instance_id,
    lockKey: row.lock_key,
    message: row.message,
    resultJson: row.result_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapTaskLogRow(row: TaskLogRow): TaskLogRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    step: row.step,
    level: row.level,
    message: row.message,
    detailJson: row.detail_json,
    createdAt: row.created_at,
  };
}

export async function listAccounts(env: AppEnv): Promise<AccountSummary[]> {
  const result = await env.DB.prepare(
    `SELECT id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, expiration_date, created_at, updated_at
       FROM accounts
      ORDER BY name ASC`,
  ).all<AccountRow>();

  return (result.results ?? []).map((row) => toSummary(mapAccountRow(row)));
}

export async function getAccountById(env: AppEnv, accountId: string): Promise<AccountRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, expiration_date, created_at, updated_at
       FROM accounts
      WHERE id = ?1`,
  )
    .bind(accountId)
    .first<AccountRow>();

  return row ? mapAccountRow(row) : null;
}

export async function getDecryptedAccountById(env: AppEnv, accountId: string): Promise<DecryptedAccountRecord | null> {
  const account = await getAccountById(env, accountId);
  if (!account) {
    return null;
  }

  return {
    id: account.id,
    name: account.name,
    clientId: account.clientId,
    tenantId: account.tenantId,
    subscriptionId: account.subscriptionId,
    clientSecret: await decryptString(env.ACCOUNT_ENCRYPTION_KEY, account.clientSecretCiphertext),
    expirationDate: account.expirationDate,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function createAccount(
  env: AppEnv,
  input: {
    id: string;
    name: string;
    clientId: string;
    tenantId: string;
    subscriptionId: string;
    clientSecret: string;
    expirationDate: string | null;
  },
): Promise<AccountSummary> {
  const timestamp = nowIso();
  const ciphertext = await encryptString(env.ACCOUNT_ENCRYPTION_KEY, input.clientSecret);

  await env.DB.prepare(
    `INSERT INTO accounts (
      id, name, client_id, tenant_id, subscription_id, client_secret_ciphertext, expiration_date, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      input.id,
      input.name,
      input.clientId,
      input.tenantId,
      input.subscriptionId,
      ciphertext,
      input.expirationDate,
      timestamp,
      timestamp,
    )
    .run();

  return {
    id: input.id,
    name: input.name,
    clientId: input.clientId,
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    expirationDate: input.expirationDate,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function updateAccountMetadata(
  env: AppEnv,
  input: {
    accountId: string;
    newName: string;
    expirationDate: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts
        SET name = ?2,
            expiration_date = ?3,
            updated_at = ?4
      WHERE id = ?1`,
  )
    .bind(input.accountId, input.newName, input.expirationDate, nowIso())
    .run();
}

export async function deleteAccount(env: AppEnv, accountId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(accountId).run();
}

export async function accountNameExists(env: AppEnv, name: string, excludeAccountId?: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id
       FROM accounts
      WHERE name = ?1
        AND (?2 IS NULL OR id != ?2)
      LIMIT 1`,
  )
    .bind(name, excludeAccountId ?? null)
    .first<{ id: string }>();

  return Boolean(row);
}

export async function getGlobalStartupScript(env: AppEnv): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT key, value, updated_at, updated_by
       FROM app_settings
      WHERE key = ?1`,
  )
    .bind(STARTUP_SCRIPT_SETTING_KEY)
    .first<AppSettingRow>();

  return row?.value ?? DEFAULT_STARTUP_SCRIPT;
}

export async function setGlobalStartupScript(
  env: AppEnv,
  input: {
    userData: string;
    updatedBy: string;
  },
): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(STARTUP_SCRIPT_SETTING_KEY, input.userData, timestamp, input.updatedBy)
    .run();
}

export async function createTask(
  env: AppEnv,
  input: {
    id: string;
    accountId: string;
    type: string;
    workflowName: WorkflowName;
    lockKey: string;
    idempotencyKey: string;
    createdBy: string;
    message: string;
  },
): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO tasks (
      id, account_id, type, status, workflow_name, workflow_instance_id, lock_key, message, result_json,
      error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at
    ) VALUES (?1, ?2, ?3, 'queued', ?4, NULL, ?5, ?6, NULL, NULL, NULL, ?7, ?8, ?9, ?9, NULL, NULL)`,
  )
    .bind(
      input.id,
      input.accountId,
      input.type,
      input.workflowName,
      input.lockKey,
      input.message,
      input.idempotencyKey,
      input.createdBy,
      timestamp,
    )
    .run();
}

export async function setTaskWorkflowInstance(
  env: AppEnv,
  taskId: string,
  workflowInstanceId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks
        SET workflow_instance_id = ?2,
            updated_at = ?3
      WHERE id = ?1`,
  )
    .bind(taskId, workflowInstanceId, nowIso())
    .run();
}

export async function markTaskRunning(env: AppEnv, taskId: string, message: string): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(
    `UPDATE tasks
        SET status = 'running',
            message = ?2,
            updated_at = ?3,
            started_at = COALESCE(started_at, ?3)
      WHERE id = ?1`,
  )
    .bind(taskId, message, timestamp)
    .run();
}

export async function markTaskSuccess(
  env: AppEnv,
  taskId: string,
  message: string,
  result: JsonRecord | string | null,
): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(
    `UPDATE tasks
        SET status = 'success',
            message = ?2,
            result_json = ?3,
            error_code = NULL,
            error_message = NULL,
            updated_at = ?4,
            completed_at = ?4
      WHERE id = ?1`,
  )
    .bind(taskId, message, result === null ? null : JSON.stringify(result), timestamp)
    .run();
}

export async function markTaskFailure(
  env: AppEnv,
  taskId: string,
  input: {
    message: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    result?: JsonRecord | string | null;
  },
): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(
    `UPDATE tasks
        SET status = 'failure',
            message = ?2,
            result_json = ?3,
            error_code = ?4,
            error_message = ?5,
            updated_at = ?6,
            completed_at = ?6
      WHERE id = ?1`,
  )
    .bind(
      taskId,
      input.message,
      input.result === undefined || input.result === null ? null : JSON.stringify(input.result),
      input.errorCode ?? null,
      input.errorMessage ?? null,
      timestamp,
    )
    .run();
}

export async function appendTaskLog(
  env: AppEnv,
  taskId: string,
  input: {
    step: string;
    level: string;
    message: string;
    detail?: JsonRecord | string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO task_logs (task_id, step, level, message, detail_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      taskId,
      input.step,
      input.level,
      input.message,
      input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
      nowIso(),
    )
    .run();
}

export async function writeAuditEvent(
  env: AppEnv,
  input: {
    actor: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: JsonRecord | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (actor, action, target_type, target_id, metadata_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      input.actor,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowIso(),
    )
    .run();
}

export async function getTaskResponse(env: AppEnv, taskId: string): Promise<TaskResponse | null> {
  const taskRow = await env.DB.prepare(
    `SELECT id, account_id, type, status, workflow_name, workflow_instance_id, lock_key, message, result_json,
            error_code, error_message, idempotency_key, created_by, created_at, updated_at, started_at, completed_at
       FROM tasks
      WHERE id = ?1`,
  )
    .bind(taskId)
    .first<TaskRow>();

  if (!taskRow) {
    return null;
  }

  const logs = await env.DB.prepare(
    `SELECT id, task_id, step, level, message, detail_json, created_at
       FROM task_logs
      WHERE task_id = ?1
      ORDER BY id ASC`,
  )
    .bind(taskId)
    .all<TaskLogRow>();

  const task = mapTaskRow(taskRow);

  return {
    id: task.id,
    status: task.status,
    message: task.message,
    result: parseJsonOrNull<JsonRecord | string>(task.resultJson),
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    workflowName: task.workflowName,
    workflowInstanceId: task.workflowInstanceId,
    logs: (logs.results ?? []).map((row) => {
      const mapped = mapTaskLogRow(row);
      return {
        id: mapped.id,
        step: mapped.step,
        level: mapped.level,
        message: mapped.message,
        detail: parseJsonOrNull(mapped.detailJson),
        createdAt: mapped.createdAt,
      };
    }),
  };
}
