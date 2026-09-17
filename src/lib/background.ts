import type { AppEnv, ChangeIpParams, CreateVmParams, VmLifecycleParams } from "../types";
import {
  appendTaskLog,
  getDecryptedAccountOrThrow,
  getGlobalSshSettings,
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
  createNetworkSecurityGroup,
  createOrUpdateNetworkInterface,
  createPublicIpAddress,
  createVirtualNetwork,
  deletePublicIpAddress,
  getNetworkInterface,
  getPublicIpAddress,
  type AzurePublicIpSku,
} from "./azure/network";
import { createOrUpdateResourceGroup, deleteResourceGroup } from "./azure/resource";
import { invalidateVmList } from "./azure/vm-cache";
import { delay } from "./utils";

function generateAdminPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}A1a!`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "image_arm64_not_supported:centos8") {
    return "CentOS 8 当前没有可用的 ARM64 镜像，请改用 Ubuntu、Debian 或选择 x86_64 规格";
  }
  return message;
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

function buildProvisioningScript(
  input: string,
  options: {
    enableRoot: boolean;
    adminUsername: string;
    adminPassword: string;
    sshPublicKey: string | null;
  },
): string {
  let script = input.trim();
  if (!script) script = "#!/bin/bash";
  if (!script.startsWith("#!")) script = `#!/bin/bash\n${script}`;

  if (options.enableRoot) {
    script += `\n\n# Enable root SSH login\n`;
    script += `mkdir -p /root/.ssh\n`;
    if (options.sshPublicKey) {
      script += `printf '%s\n' '${escapeShellSingleQuotes(options.sshPublicKey)}' > /root/.ssh/authorized_keys\n`;
    } else {
      script += `if [ -f /home/${options.adminUsername}/.ssh/authorized_keys ]; then cp /home/${options.adminUsername}/.ssh/authorized_keys /root/.ssh/authorized_keys; fi\n`;
    }
    script += `chmod 700 /root/.ssh\n`;
    script += `chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true\n`;
    script += `echo 'root:${escapeShellSingleQuotes(options.adminPassword)}' | chpasswd\n`;
    script += `sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/g' /etc/ssh/sshd_config\n`;
    script += `sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/g' /etc/ssh/sshd_config\n`;
    script += `systemctl restart sshd || systemctl restart ssh || true\n`;
  }

  return script;
}

function escapeShellSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
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
    const timestamp = Date.now();
    const slugRegion = params.region.replace(/\s+/g, "").toLowerCase();
    const vmName = params.vmName?.trim() || `vm-${slugRegion}-${timestamp}`;
    resourceGroup = `rg-${vmName}-${timestamp}`;
    const ttl = env.LOCK_TIMEOUT_SECONDS;
    const globalSsh = params.useGlobalSsh ? await getGlobalSshSettings(env) : null;
    const requestedUsername = params.adminUsername?.trim() || globalSsh?.username?.trim() || "azureuser";
    const targetUsername = requestedUsername.toLowerCase() === "root" ? "root" : requestedUsername;
    const adminUsername = targetUsername === "root" ? "azureuser" : targetUsername;
    const adminPassword = params.adminPassword?.trim() || globalSsh?.password || generateAdminPassword();
    const sshPublicKey = params.useGlobalSsh ? globalSsh?.publicKey?.trim() || null : null;
    const rawUserData = params.userData?.trim() ? params.userData : await getGlobalStartupScript(env);
    const userData = buildProvisioningScript(rawUserData, {
      enableRoot: params.enableRoot || targetUsername === "root",
      adminUsername,
      adminPassword,
      sshPublicKey,
    });

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

    let networkSecurityGroupId: string | undefined;
    if (params.nsgEnabled) {
      const nsgName = `nsg-${vmName}`;
      networkSecurityGroupId = await createNetworkSecurityGroup(
        client,
        account.subscriptionId,
        resourceGroup,
        nsgName,
        params.region,
        {
          ports: params.nsgPorts,
          openAllInbound: params.nsgOpenAllInbound,
          openAllOutbound: params.nsgOpenAllOutbound,
        },
      );
      await appendTaskLog(env, params.taskId, {
        step: "network-security",
        message: `网络安全组 ${nsgName} 已创建`,
      });
      if (params.nsgOpenAllInbound || params.nsgOpenAllOutbound) {
        await appendTaskLog(env, params.taskId, {
          step: "network-security",
          message: "已按用户选择开放全部入站或出站流量，请确认安全策略。",
          level: "warn",
        });
      }
    }

    const nicName = `nic-${vmName}`;
    await createOrUpdateNetworkInterface(client, account.subscriptionId, resourceGroup, nicName, {
      location: params.region,
      properties: {
        ipConfigurations: [{
          name: "ipconfig1",
          properties: { subnet: { id: subnetId }, publicIPAddress: { id: publicIp.id } },
        }],
        ...(networkSecurityGroupId
          ? { networkSecurityGroup: { id: networkSecurityGroupId } }
          : {}),
      },
    });
    await appendTaskLog(env, params.taskId, { step: "network", message: `网卡 ${nicName} 已创建` });

    const nicId = `/subscriptions/${account.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}`;
    await createVirtualMachine(client, account.subscriptionId, resourceGroup, vmName, {
      location: params.region,
      vmSize: params.vmSize,
      osImage: params.osImage,
      diskSizeGb: params.diskSize,
      diskType: params.diskType,
      networkInterfaceId: nicId,
      adminUsername,
      adminPassword,
      sshPublicKey,
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
      username: targetUsername,
      password: adminPassword,
    });
    invalidateVmList(params.accountId, "vm.create.success");
  } catch (error) {
    await failTask(env, params.taskId, "虚拟机创建失败", error);
    // A failed create can still leave resources behind, so the cached list is stale either way.
    invalidateVmList(params.accountId, "vm.create.failure");
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
    invalidateVmList(params.accountId, `vm.${params.action}.success`);
  } catch (error) {
    await failTask(env, params.taskId, "虚拟机操作失败", error);
    // delete can partially succeed; the other actions may have applied too.
    invalidateVmList(params.accountId, `vm.${params.action}.failure`);
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
    let oldIpType: "Static" | "Dynamic" = "Static";
    let oldIpSku: AzurePublicIpSku = "Standard";

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
      try {
        const oldIp = await getPublicIpAddress(client, account.subscriptionId, params.resourceGroup, oldIpName);
        oldIpType = oldIp.properties?.publicIPAllocationMethod === "Dynamic" ? "Dynamic" : "Static";
        oldIpSku = oldIp.sku?.name === "Basic" ? "Basic" : "Standard";
      } catch {
        // Keep safe Standard/Static defaults when the old resource cannot be read.
      }
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
      oldIpType,
      oldIpSku,
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
    invalidateVmList(params.accountId, "vm.change-ip.success");
  } catch (error) {
    await failTask(env, params.taskId, "更换公网 IP 失败", error);
    // The public IP may already have changed even though the task failed.
    invalidateVmList(params.accountId, "vm.change-ip.failure");
  } finally {
    if (subscriptionLockKey) {
      releaseSubscriptionLock({ lockKey: subscriptionLockKey, owner: params.taskId });
    }
  }
}
