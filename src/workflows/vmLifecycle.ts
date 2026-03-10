import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AppEnv, VmLifecycleParams } from "../types";
import { startVmAction } from "../lib/azure/compute";
import { AzureArmClient } from "../lib/azure/client";
import { acquireSubscriptionLock, releaseSubscriptionLock } from "../lib/locks";
import { deleteResourceGroup } from "../lib/azure/resource";
import { getDecryptedAccountOrThrow, getLockTimeoutSeconds } from "../lib/workflow-support";
import { taskFailed, taskLog, taskRunning, taskSucceeded } from "../lib/tasks";

export class VmLifecycleWorkflow extends WorkflowEntrypoint {
  override async run(event: Readonly<WorkflowEvent<VmLifecycleParams>>, step: WorkflowStep): Promise<void> {
    const env = this.env as AppEnv;
    const payload = event.payload;
    const account = await getDecryptedAccountOrThrow(env, payload.accountId);
    const client = new AzureArmClient(env, account);
    const lockKey = account.subscriptionId;

    try {
      await step.do("acquire subscription lock", async () => {
        await acquireSubscriptionLock(env, {
          lockKey,
          owner: payload.taskId,
          timeoutSeconds: getLockTimeoutSeconds(env),
          ttlSeconds: getLockTimeoutSeconds(env),
        });
      });

      await step.do("mark task running", async () => {
        await taskRunning(env, payload.taskId, `正在执行 ${payload.action} 操作...`);
        await taskLog(env, payload.taskId, "lock", `已获取订阅锁 ${lockKey}`);
      });

      if (payload.action === "delete") {
        await step.do("delete resource group", async () => {
          await deleteResourceGroup(client, account.subscriptionId, payload.resourceGroup);
          await taskLog(env, payload.taskId, "resource-group", `资源组 ${payload.resourceGroup} 已删除`);
        });
      } else {
        const action = payload.action;
        await step.do("execute vm action", async () => {
          await startVmAction(
            client,
            account.subscriptionId,
            payload.resourceGroup,
            payload.vmName,
            action,
          );
          await taskLog(env, payload.taskId, "vm-action", `${payload.vmName} ${action} 操作已完成`);
        });
      }

      await step.do("mark task success", async () => {
        await taskSucceeded(env, payload.taskId, `${payload.vmName} ${payload.action} 操作成功`, {
          action: payload.action,
          resourceGroup: payload.resourceGroup,
          vmName: payload.vmName,
        });
      });
    } catch (error) {
      await step.do("record failure", async () => {
        await taskLog(env, payload.taskId, "error", error instanceof Error ? error.message : String(error), null, "error");
        await taskFailed(env, payload.taskId, {
          message: `虚拟机操作失败: ${error instanceof Error ? error.message : String(error)}`,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
      throw error;
    } finally {
      await step.do("release subscription lock", async () => {
        await releaseSubscriptionLock(env, {
          lockKey,
          owner: payload.taskId,
        });
      });
    }
  }
}
