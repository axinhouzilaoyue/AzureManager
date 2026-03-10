import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AppEnv, ChangeIpParams } from "../types";
import { AzureArmClient } from "../lib/azure/client";
import { getVirtualMachine } from "../lib/azure/compute";
import { acquireSubscriptionLock, releaseSubscriptionLock } from "../lib/locks";
import {
  buildNetworkInterfacePayload,
  createOrUpdateNetworkInterface,
  createPublicIpAddress,
  deletePublicIpAddress,
  getNetworkInterface,
} from "../lib/azure/network";
import { getDecryptedAccountOrThrow, getLockTimeoutSeconds } from "../lib/workflow-support";
import { taskFailed, taskLog, taskRunning, taskSucceeded } from "../lib/tasks";

function extractResourceName(resourceId: string): string {
  const parts = resourceId.split("/");
  const name = parts.at(-1);
  if (!name) {
    throw new Error(`invalid_resource_id:${resourceId}`);
  }
  return name;
}

export class ChangeIpWorkflow extends WorkflowEntrypoint {
  override async run(event: Readonly<WorkflowEvent<ChangeIpParams>>, step: WorkflowStep): Promise<void> {
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
        await taskRunning(env, payload.taskId, `正在为 ${payload.vmName} 更换公网 IP...`);
        await taskLog(env, payload.taskId, "lock", `已获取订阅锁 ${lockKey}`);
      });

      const vmContext = await step.do("load vm network context", async () => {
        const virtualMachine = await getVirtualMachine(
          client,
          account.subscriptionId,
          payload.resourceGroup,
          payload.vmName,
        );
        const nicId = virtualMachine.properties.networkProfile?.networkInterfaces?.[0]?.id;
        if (!nicId) {
          throw new Error("vm_network_interface_not_found");
        }
        return {
          vmLocation: virtualMachine.location,
          nicName: extractResourceName(nicId),
        };
      });

      const initialNic = await step.do("load current network interface", async () => {
        return getNetworkInterface(client, account.subscriptionId, payload.resourceGroup, vmContext.nicName);
      });

      const oldPublicIpId = initialNic.properties.ipConfigurations?.[0]?.properties?.publicIPAddress?.id ?? null;
      if (oldPublicIpId) {
        await step.do("detach old public ip", async () => {
          await createOrUpdateNetworkInterface(
            client,
            account.subscriptionId,
            payload.resourceGroup,
            vmContext.nicName,
            buildNetworkInterfacePayload(initialNic, null),
          );
          await taskLog(env, payload.taskId, "network", `已从网卡 ${vmContext.nicName} 卸载旧公网 IP`);
        });

        await step.do("delete old public ip", async () => {
          const oldPublicIpName = extractResourceName(oldPublicIpId);
          await deletePublicIpAddress(client, account.subscriptionId, payload.resourceGroup, oldPublicIpName);
          await taskLog(env, payload.taskId, "public-ip", `旧公网 IP ${oldPublicIpName} 已删除`);
        });
      }

      const newPublicIpName = `pip-${payload.vmName}-${Date.now()}`;
      const newPublicIp = await step.do("create new public ip", async () => {
        const created = await createPublicIpAddress(
          client,
          account.subscriptionId,
          payload.resourceGroup,
          newPublicIpName,
          vmContext.vmLocation,
          "Static",
        );
        await taskLog(env, payload.taskId, "public-ip", `新公网 IP 资源 ${newPublicIpName} 已创建`);
        return created;
      });

      await step.do("attach new public ip", async () => {
        const refreshedNic = await getNetworkInterface(
          client,
          account.subscriptionId,
          payload.resourceGroup,
          vmContext.nicName,
        );
        await createOrUpdateNetworkInterface(
          client,
          account.subscriptionId,
          payload.resourceGroup,
          vmContext.nicName,
          buildNetworkInterfacePayload(refreshedNic, newPublicIp.id),
        );
        await taskLog(env, payload.taskId, "network", `已为 ${payload.vmName} 绑定新的公网 IP`);
      });

      await step.do("mark task success", async () => {
        await taskSucceeded(env, payload.taskId, `${payload.vmName} 更换公网 IP 成功`, {
          vmName: payload.vmName,
          resourceGroup: payload.resourceGroup,
          publicIp: newPublicIp.properties?.ipAddress ?? "N/A",
        });
      });
    } catch (error) {
      await step.do("record failure", async () => {
        await taskLog(env, payload.taskId, "error", error instanceof Error ? error.message : String(error), null, "error");
        await taskFailed(env, payload.taskId, {
          message: `更换公网 IP 失败: ${error instanceof Error ? error.message : String(error)}`,
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
