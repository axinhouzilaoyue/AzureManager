import type { AppEnv, ChangeIpParams, CreateVmParams, VmLifecycleParams } from "../types";
import {
  appendTaskLog,
  getDecryptedAccountOrThrow,
  getGlobalStartupScript,
  markTaskFailure,
  markTaskRunning,
  markTaskSuccess,
} from "./db";
import { acquireSubscriptionLock, releaseSubscriptionLock } from "./locks";
import { AzureArmClient } from "./azure/client";
import { createVirtualMachine, getVirtualMachine, startVmAction } from "./azure/compute";
import {
  buildNetworkInterfacePayload,
  createOrUpdateNetworkInterface,
  createPublicIpAddress,
  createVirtualNetwork,
  deletePublicIpAddress,
  getNetworkInterface,
  getPublicIpAddress,
} from "./azure/network";
import { createOrUpdateResourceGroup, deleteResourceGroup } from "./azure/resource";
import { delay } from "./utils";

function generateAdminPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failTask(env: AppEnv, taskId: string, message: string, error: unknown): Promise<void> {
  const msg = errorMessage(error);
  try {
    await appendTaskLog(env, taskId, { step: "error", message: msg, level: "error" });
    await markTaskFailure(env, taskId, { message: `${message}: ${msg}`, errorMessage: msg });
  } catch (logError) {
    console.error("Failed to mark task failure", taskId, logError);
  }
}

export function startCreateVm(env: AppEnv, params: CreateVmParams): void {
  runCreateVm(env, params).catch((error) => {
    console.error("create-vm background task crashed", params.taskId, error);
  });
}

export function startVmLifecycle(env: AppEnv, params: VmLifecycleParams): void {
  runVmLifecycle(env, params).catch((error) => {
    console.error("vm-lifecycle background task crashed", params.taskId, error);
  });
}

export function startChangeIp(env: AppEnv, params: ChangeIpParams): void {
  runChangeIp(env, params).catch((error) => {
    console.error("change-ip background task crashed", params.taskId, error);
  });
}

async function waitForPublicIp(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  publicIpName: string,
  attempts = 8,
): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const publicIp = await getPublicIpAddress(client, subscriptionId, resourceGroup, publicIpName);
    const address = publicIp.properties?.ipAddress;
    if (address) return address;
    if (i < attempts - 1) await delay(2000);
  }
  return "N/A";
}

async function runCreateVm(env: AppEnv, params: CreateVmParams): Promise<void> {
  let subscriptionLockKey: string | null = null;
  let resourceGroup: string | null = null;
  let resourceGroupCreated = false;
  let client: AzureArmClient | null = null;
  let subscriptionId: string | null = null;

  try {
    const account = await getDecryptedAccountOrThrow(env, params.accountId);
    client = new AzureArmClient(env, account);
    subscriptionId = account.subscriptionId;
    subscriptionLockKey = account.subscriptionId;
    const adminPassword = generateAdminPassword();
    const timestamp = Date.now();
    const slugRegion = params.region.replace(/\s+/g, "").toLowerCase();
    const vmName = `vm-${slugRegion}-${timestamp}`;
    resourceGroup = `vm-${slugRegion}-${timestamp}`;
    const ttl = env.LOCK_TIMEOUT_SECONDS;
    const userData = params.userData?.trim()
      ? params.userData
      : await getGlobalStartupScript(env);

    await acquireSubscriptionLock({
      lockKey: subscriptionLockKey,
      owner: params.taskId,
      timeoutSeconds: ttl,
      ttlSeconds: ttl,
    });
    await markTaskRunning(env, params.taskId, `正在为账户 ${account.name} 创建虚拟机...`);
    await appendTaskLog(env, params.taskId, { step: "lock", message: `已获取订阅锁 ${subscriptionLockKey}` });

    await createOrUpdateResourceGroup(client, account.subscriptionId, resourceGroup, params.region);
    resourceGroupCreated = true;
    await appendTaskLog(env, params.taskId, { step: "resource-group", message: `资源组 ${resourceGroup} 已创建` });

    const vnet = await createVirtualNetwork(client, account.subscriptionId, resourceGroup, `vnet-${vmName}`, params.region);
    await appendTaskLog(env, params.taskId, { step: "network", message: `虚拟网络 ${vnet.name} 已创建` });

    const subnetId = vnet.properties.subnets[0]?.id;
    if (!subnetId) throw new Error("subnet_not_created");

    const publicIp = await createPublicIpAddress(
      client,
      account.subscriptionId,
      resourceGroup,
      `pip-${vmName}`,
      params.region,
      params.ipType as "Static" | "Dynamic",
    );
    await appendTaskLog(env, params.taskId, { step: "public-ip", message: `公网 IP 资源 pip-${vmName} 已创建` });

    const nicName = `nic-${vmName}`;
    await createOrUpdateNetworkInterface(client, account.subscriptionId, resourceGroup, nicName, {
      location: params.region,
      properties: {
        ipConfigurations: [{
          name: "ipconfig1",
          properties: { subnet: { id: subnetId }, publicIPAddress: { id: publicIp.id } },
        }],
      },
    });
    await appendTaskLog(env, params.taskId, { step: "network", message: `网卡 ${nicName} 已创建` });

    const nicId = `/subscriptions/${account.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}`;
    await createVirtualMachine(client, account.subscriptionId, resourceGroup, vmName, {
      location: params.region,
      vmSize: params.vmSize,
      osImage: params.osImage as "debian12" | "debian11" | "ubuntu22" | "ubuntu20",
      diskSizeGb: params.diskSize,
      networkInterfaceId: nicId,
      adminPassword,
      userData,
    });
    await appendTaskLog(env, params.taskId, {
      step: "vm",
      message: `虚拟机 ${vmName} 已创建${params.userData?.trim() ? "" : "（已应用全局开机脚本）"}`,
    });

    const finalIp = await waitForPublicIp(client, account.subscriptionId, resourceGroup, `pip-${vmName}`);
    await markTaskSuccess(env, params.taskId, `虚拟机 ${vmName} 创建成功`, {
      vmName,
      resourceGroup,
      publicIp: finalIp,
      username: "azureuser",
      password: adminPassword,
    });
  } catch (error) {
    await failTask(env, params.taskId, "虚拟机创建失败", error);
    if (client && subscriptionId && resourceGroup && resourceGroupCreated) {
      try {
        await deleteResourceGroup(client, subscriptionId, resourceGroup);
        await appendTaskLog(env, params.taskId, {
          step: "cleanup",
          message: `已清理资源组 ${resourceGroup}`,
        });
      } catch (cleanupError) {
        await appendTaskLog(env, params.taskId, {
          step: "cleanup",
          message: errorMessage(cleanupError),
          level: "error",
        });
      }
    }
  } finally {
    if (subscriptionLockKey) {
      releaseSubscriptionLock({ lockKey: subscriptionLockKey, owner: params.taskId });
    }
  }
}

async function runVmLifecycle(env: AppEnv, params: VmLifecycleParams): Promise<void> {
  let subscriptionLockKey: string | null = null;

  try {
    const account = await getDecryptedAccountOrThrow(env, params.accountId);
    const client = new AzureArmClient(env, account);
    subscriptionLockKey = account.subscriptionId;
    const ttl = env.LOCK_TIMEOUT_SECONDS;

    await acquireSubscriptionLock({
      lockKey: subscriptionLockKey,
      owner: params.taskId,
      timeoutSeconds: ttl,
      ttlSeconds: ttl,
    });
    await markTaskRunning(env, params.taskId, `正在执行 ${params.action} 操作...`);
    await appendTaskLog(env, params.taskId, { step: "lock", message: `已获取订阅锁 ${subscriptionLockKey}` });

    if (params.action === "delete") {
      await deleteResourceGroup(client, account.subscriptionId, params.resourceGroup);
      await appendTaskLog(env, params.taskId, {
        step: "resource-group",
        message: `资源组 ${params.resourceGroup} 已删除`,
      });
    } else {
      await startVmAction(client, account.subscriptionId, params.resourceGroup, params.vmName, params.action);
      await appendTaskLog(env, params.taskId, {
        step: "vm-action",
        message: `${params.vmName} ${params.action} 操作已完成`,
      });
    }

    await markTaskSuccess(env, params.taskId, `${params.vmName} ${params.action} 操作成功`, {
      action: params.action,
      resourceGroup: params.resourceGroup,
      vmName: params.vmName,
    });
  } catch (error) {
    await failTask(env, params.taskId, "虚拟机操作失败", error);
  } finally {
    if (subscriptionLockKey) {
      releaseSubscriptionLock({ lockKey: subscriptionLockKey, owner: params.taskId });
    }
  }
}

async function runChangeIp(env: AppEnv, params: ChangeIpParams): Promise<void> {
  let subscriptionLockKey: string | null = null;

  try {
    const account = await getDecryptedAccountOrThrow(env, params.accountId);
    const client = new AzureArmClient(env, account);
    subscriptionLockKey = account.subscriptionId;
    const ttl = env.LOCK_TIMEOUT_SECONDS;

    await acquireSubscriptionLock({
      lockKey: subscriptionLockKey,
      owner: params.taskId,
      timeoutSeconds: ttl,
      ttlSeconds: ttl,
    });
    await markTaskRunning(env, params.taskId, `正在为 ${params.vmName} 更换公网 IP...`);
    await appendTaskLog(env, params.taskId, { step: "lock", message: `已获取订阅锁 ${subscriptionLockKey}` });

    const vm = await getVirtualMachine(client, account.subscriptionId, params.resourceGroup, params.vmName);
    const nicId = vm.properties.networkProfile?.networkInterfaces?.[0]?.id;
    if (!nicId) throw new Error("vm_network_interface_not_found");
    const nicName = nicId.split("/").at(-1)!;

    const nic = await getNetworkInterface(client, account.subscriptionId, params.resourceGroup, nicName);
    const oldIpId = nic.properties.ipConfigurations?.[0]?.properties?.publicIPAddress?.id ?? null;

    if (oldIpId) {
      await createOrUpdateNetworkInterface(
        client,
        account.subscriptionId,
        params.resourceGroup,
        nicName,
        buildNetworkInterfacePayload(nic, null),
      );
      await appendTaskLog(env, params.taskId, {
        step: "network",
        message: `已从网卡 ${nicName} 卸载旧公网 IP`,
      });
      const oldIpName = oldIpId.split("/").at(-1)!;
      await deletePublicIpAddress(client, account.subscriptionId, params.resourceGroup, oldIpName);
      await appendTaskLog(env, params.taskId, {
        step: "public-ip",
        message: `旧公网 IP ${oldIpName} 已删除`,
      });
    }

    const newIpName = `pip-${params.vmName}-${Date.now()}`;
    await createPublicIpAddress(
      client,
      account.subscriptionId,
      params.resourceGroup,
      newIpName,
      vm.location,
      "Static",
    );
    await appendTaskLog(env, params.taskId, {
      step: "public-ip",
      message: `新公网 IP 资源 ${newIpName} 已创建`,
    });

    const refreshedNic = await getNetworkInterface(client, account.subscriptionId, params.resourceGroup, nicName);
    const newIp = await getPublicIpAddress(client, account.subscriptionId, params.resourceGroup, newIpName);
    await createOrUpdateNetworkInterface(
      client,
      account.subscriptionId,
      params.resourceGroup,
      nicName,
      buildNetworkInterfacePayload(refreshedNic, newIp.id),
    );
    await appendTaskLog(env, params.taskId, {
      step: "network",
      message: `已为 ${params.vmName} 绑定新的公网 IP`,
    });

    const publicIp = await waitForPublicIp(client, account.subscriptionId, params.resourceGroup, newIpName);
    await markTaskSuccess(env, params.taskId, `${params.vmName} 更换公网 IP 成功`, {
      vmName: params.vmName,
      resourceGroup: params.resourceGroup,
      publicIp,
    });
  } catch (error) {
    await failTask(env, params.taskId, "更换公网 IP 失败", error);
  } finally {
    if (subscriptionLockKey) {
      releaseSubscriptionLock({ lockKey: subscriptionLockKey, owner: params.taskId });
    }
  }
}
