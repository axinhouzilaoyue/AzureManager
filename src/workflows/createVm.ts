import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AppEnv, CreateVmParams } from "../types";
import { createVirtualMachine } from "../lib/azure/compute";
import { AzureArmClient } from "../lib/azure/client";
import {
  buildNetworkInterfacePayload,
  createOrUpdateNetworkInterface,
  createPublicIpAddress,
  createVirtualNetwork,
  getPublicIpAddress,
} from "../lib/azure/network";
import { createOrUpdateResourceGroup, deleteResourceGroup } from "../lib/azure/resource";
import { getDecryptedAccountOrThrow, generateAdminPassword, getLockTimeoutSeconds } from "../lib/workflow-support";
import { acquireSubscriptionLock, releaseSubscriptionLock } from "../lib/locks";
import { taskFailed, taskLog, taskRunning, taskSucceeded } from "../lib/tasks";

export class CreateVmWorkflow extends WorkflowEntrypoint {
  override async run(event: Readonly<WorkflowEvent<CreateVmParams>>, step: WorkflowStep): Promise<void> {
    const env = this.env as AppEnv;
    const payload = event.payload;
    const account = await getDecryptedAccountOrThrow(env, payload.accountId);
    const client = new AzureArmClient(env, account);
    const adminPassword = generateAdminPassword();
    const timestamp = Date.now();
    const slugRegion = payload.region.replace(/\s+/g, "").toLowerCase();
    const vmName = `vm-${slugRegion}-${timestamp}`;
    const resourceGroup = `vm-${slugRegion}-${timestamp}`;
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
        await taskRunning(env, payload.taskId, `正在为账户 ${account.name} 创建虚拟机...`);
        await taskLog(env, payload.taskId, "lock", `已获取订阅锁 ${lockKey}`);
      });

      await step.do("create resource group", async () => {
        await createOrUpdateResourceGroup(client, account.subscriptionId, resourceGroup, payload.region);
        await taskLog(env, payload.taskId, "resource-group", `资源组 ${resourceGroup} 已创建`);
      });

      const virtualNetwork = await step.do("create virtual network", async () => {
        const created = await createVirtualNetwork(
          client,
          account.subscriptionId,
          resourceGroup,
          `vnet-${vmName}`,
          payload.region,
        );
        await taskLog(env, payload.taskId, "network", `虚拟网络 ${created.name} 已创建`);
        return created;
      });

      const subnetId = virtualNetwork.properties.subnets[0]?.id;
      if (!subnetId) {
        throw new Error("subnet_not_created");
      }

      const publicIp = await step.do("create public ip", async () => {
        const created = await createPublicIpAddress(
          client,
          account.subscriptionId,
          resourceGroup,
          `pip-${vmName}`,
          payload.region,
          payload.ipType,
        );
        await taskLog(env, payload.taskId, "public-ip", `公网 IP 资源 ${created.name} 已创建`);
        return created;
      });

      await step.do("create network interface", async () => {
        const networkInterfaceName = `nic-${vmName}`;
        await createOrUpdateNetworkInterface(
          client,
          account.subscriptionId,
          resourceGroup,
          networkInterfaceName,
          {
            location: payload.region,
            properties: {
              ipConfigurations: [
                {
                  name: "ipconfig1",
                  properties: {
                    subnet: { id: subnetId },
                    publicIPAddress: { id: publicIp.id },
                  },
                },
              ],
            },
          },
        );
        await taskLog(env, payload.taskId, "network", `网卡 ${networkInterfaceName} 已创建`);
      });

      await step.do("create virtual machine", async () => {
        const networkInterfaceId = `/subscriptions/${account.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/nic-${vmName}`;
        await createVirtualMachine(client, account.subscriptionId, resourceGroup, vmName, {
          location: payload.region,
          vmSize: payload.vmSize,
          osImage: payload.osImage,
          diskSizeGb: payload.diskSize,
          networkInterfaceId,
          adminPassword,
          userData: payload.userData,
        });
        await taskLog(env, payload.taskId, "vm", `虚拟机 ${vmName} 已创建`);
      });

      const finalPublicIp = await step.do("read final public ip", async () => {
        return getPublicIpAddress(
          client,
          account.subscriptionId,
          resourceGroup,
          `pip-${vmName}`,
        );
      });

      await step.do("mark task success", async () => {
        await taskSucceeded(
          env,
          payload.taskId,
          `虚拟机 ${vmName} 创建成功`,
          {
            vmName,
            resourceGroup,
            publicIp: finalPublicIp.properties?.ipAddress ?? "N/A",
            username: "azureuser",
            password: adminPassword,
          },
        );
      });
    } catch (error) {
      await step.do("record failure", async () => {
        await taskLog(env, payload.taskId, "error", error instanceof Error ? error.message : String(error), null, "error");
        await taskFailed(env, payload.taskId, {
          message: `虚拟机创建失败: ${error instanceof Error ? error.message : String(error)}`,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

      try {
        await step.do("cleanup failed resource group", async () => {
          await deleteResourceGroup(client, account.subscriptionId, resourceGroup);
          await taskLog(env, payload.taskId, "cleanup", `已回收资源组 ${resourceGroup}`);
        });
      } catch (cleanupError) {
        await step.do("record cleanup failure", async () => {
          await taskLog(
            env,
            payload.taskId,
            "cleanup",
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            null,
            "error",
          );
        });
      }

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
