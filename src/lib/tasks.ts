import type { AppEnv, JsonRecord, TaskStatus, WorkflowName } from "../types";
import {
  appendTaskLog,
  createTask,
  getTaskResponse,
  markTaskFailure,
  markTaskRunning,
  markTaskSuccess,
  setTaskWorkflowInstance,
  writeAuditEvent,
} from "./db";

export async function enqueueTask(
  env: AppEnv,
  input: {
    id: string;
    accountId: string;
    type: string;
    workflowName: WorkflowName;
    lockKey: string;
    createdBy: string;
    message: string;
  },
): Promise<void> {
  await createTask(env, {
    ...input,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function registerWorkflowInstance(
  env: AppEnv,
  taskId: string,
  workflowInstanceId: string,
): Promise<void> {
  await setTaskWorkflowInstance(env, taskId, workflowInstanceId);
}

export async function taskLog(
  env: AppEnv,
  taskId: string,
  step: string,
  message: string,
  detail?: JsonRecord | string | null,
  level = "info",
): Promise<void> {
  await appendTaskLog(env, taskId, {
    step,
    level,
    message,
    detail,
  });
}

export async function taskRunning(env: AppEnv, taskId: string, message: string): Promise<void> {
  await markTaskRunning(env, taskId, message);
}

export async function taskSucceeded(
  env: AppEnv,
  taskId: string,
  message: string,
  result: JsonRecord | string | null,
): Promise<void> {
  await markTaskSuccess(env, taskId, message, result);
}

export async function taskFailed(
  env: AppEnv,
  taskId: string,
  input: {
    message: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    result?: JsonRecord | string | null;
  },
): Promise<void> {
  await markTaskFailure(env, taskId, input);
}

export async function audit(
  env: AppEnv,
  input: {
    actor: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: JsonRecord | null;
  },
): Promise<void> {
  await writeAuditEvent(env, input);
}

export { getTaskResponse };
