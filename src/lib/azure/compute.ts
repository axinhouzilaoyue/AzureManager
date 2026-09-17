import type { AzureDiskType, AzureOsImage, AzureVmSummary } from "../../types";
import { AZURE_API_VERSIONS, resolveAzureOsImage } from "./constants";
import { AzureArmClient } from "./client";
import { getNetworkInterface, getPublicIpAddress } from "./network";

interface AzureVirtualMachineListItem {
  id: string;
  name: string;
  location: string;
  properties?: {
    timeCreated?: string;
    hardwareProfile?: {
      vmSize?: string;
    };
    networkProfile?: {
      networkInterfaces?: Array<{ id: string }>;
    };
    storageProfile?: {
      osDisk?: {
        diskSizeGb?: number;
      };
    };
  };
}

interface AzureVirtualMachine {
  id: string;
  name: string;
  location: string;
  properties: {
    networkProfile?: {
      networkInterfaces?: Array<{ id: string }>;
    };
  };
}

interface AzureInstanceView {
  statuses?: Array<{
    code?: string;
    displayStatus?: string;
    time?: string;
  }>;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;
  const ms = Date.now() - start.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 86_400_000);
}

export async function listVirtualMachines(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<AzureVmSummary[]> {
  const virtualMachines = await client.paginate<AzureVirtualMachineListItem>(
    `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/virtualMachines`,
    AZURE_API_VERSIONS.compute,
  );

  const summaries = await Promise.all(
    virtualMachines.map(async (virtualMachine) => {
      const resourceGroup = extractResourceGroupFromId(virtualMachine.id);
      const instanceView = await getVirtualMachineInstanceView(
        client,
        subscriptionId,
        resourceGroup,
        virtualMachine.name,
      );
      const powerState = instanceView.statuses?.find((status) => status.code?.startsWith("PowerState/"));
      const statusText = powerState?.displayStatus?.replace(/^VM\s+/i, "") ?? "Unknown";
      const isRunning = (powerState?.code || statusText).toLowerCase().includes("running");
      const timeCreated = virtualMachine.properties?.timeCreated ?? null;
      // Prefer power-state change time when running; fall back to VM creation time.
      const uptimeAnchor = isRunning ? (powerState?.time ?? timeCreated) : null;
      const uptimeDays = isRunning ? daysSince(uptimeAnchor) : null;

      const publicAddress = await resolveVirtualMachinePublicIp(
        client,
        subscriptionId,
        resourceGroup,
        virtualMachine.properties?.networkProfile?.networkInterfaces?.[0]?.id ?? null,
      );

      return {
        name: virtualMachine.name,
        location: virtualMachine.location,
        vmSize: virtualMachine.properties?.hardwareProfile?.vmSize ?? "Unknown",
        status: statusText,
        resourceGroup,
        publicIp: publicAddress.ip,
        ipAllocationMethod: publicAddress.allocationMethod,
        diskSizeGb: virtualMachine.properties?.storageProfile?.osDisk?.diskSizeGb ?? null,
        timeCreated,
        uptimeDays,
      } satisfies AzureVmSummary;
    }),
  );

  return summaries.sort((left: AzureVmSummary, right: AzureVmSummary) => left.name.localeCompare(right.name));
}

export interface AzureVmSizeOption {
  name: string;
  numberOfCores: number;
  memoryInMB: number;
  maxDataDiskCount: number;
  /** UI hint only — Azure free tier eligibility still depends on subscription/region. */
  freeTierHint: boolean;
}

const FREE_TIER_SIZE_HINTS = new Set([
  "standard_b1s",
  "standard_b2ats_v2",
  "standard_b2pts_v2",
]);

export async function listVmSizes(
  client: AzureArmClient,
  subscriptionId: string,
  location: string,
): Promise<AzureVmSizeOption[]> {
  const normalizedLocation = location.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalizedLocation) return [];

  const response = await client.request<{ value?: Array<{
    name?: string;
    numberOfCores?: number;
    memoryInMB?: number;
    maxDataDiskCount?: number;
  }> }>(
    "GET",
    `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${encodeURIComponent(normalizedLocation)}/vmSizes`,
    { apiVersion: AZURE_API_VERSIONS.compute },
  );

  const sizes = (response.value ?? [])
    .filter((item) => item.name)
    .map((item) => {
      const name = item.name as string;
      return {
        name,
        numberOfCores: item.numberOfCores ?? 0,
        memoryInMB: item.memoryInMB ?? 0,
        maxDataDiskCount: item.maxDataDiskCount ?? 0,
        freeTierHint: FREE_TIER_SIZE_HINTS.has(name.toLowerCase()),
      } satisfies AzureVmSizeOption;
    });

  // Prefer free-tier candidates, then smaller/cheaper SKUs first.
  return sizes.sort((a, b) => {
    if (a.freeTierHint !== b.freeTierHint) return a.freeTierHint ? -1 : 1;
    if (a.numberOfCores !== b.numberOfCores) return a.numberOfCores - b.numberOfCores;
    if (a.memoryInMB !== b.memoryInMB) return a.memoryInMB - b.memoryInMB;
    return a.name.localeCompare(b.name);
  });
}

export async function getVirtualMachine(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
): Promise<AzureVirtualMachine> {
  return client.request(
    "GET",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}`,
    {
      apiVersion: AZURE_API_VERSIONS.compute,
    },
  );
}

export async function getVirtualMachineInstanceView(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
): Promise<AzureInstanceView> {
  return client.request(
    "GET",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/instanceView`,
    {
      apiVersion: AZURE_API_VERSIONS.compute,
    },
  );
}

export async function startVmAction(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
  action: "start" | "stop" | "restart",
): Promise<void> {
  const operationPath = {
    start: "start",
    stop: "deallocate",
    restart: "restart",
  }[action];

  await client.executeLongRunningOperation(
    "POST",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/${operationPath}`,
    {
      apiVersion: AZURE_API_VERSIONS.compute,
    },
  );
}

export async function createVirtualMachine(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
  body: {
    location: string;
    vmSize: string;
    osImage: AzureOsImage;
    diskSizeGb: number;
    diskType: AzureDiskType;
    networkInterfaceId: string;
    adminUsername: string;
    adminPassword: string;
    sshPublicKey?: string | null;
    userData: string | null;
  },
): Promise<void> {
  const osImage = resolveAzureOsImage(body.osImage, body.vmSize);
  const requestBody: Record<string, unknown> = {
    location: body.location,
    properties: {
      hardwareProfile: {
        vmSize: body.vmSize,
      },
      storageProfile: {
        imageReference: osImage,
        osDisk: {
          createOption: "FromImage",
          diskSizeGB: body.diskSizeGb,
          managedDisk: {
            storageAccountType: body.diskType,
          },
        },
      },
      osProfile: {
        computerName: vmName,
        adminUsername: body.adminUsername,
        adminPassword: body.adminPassword,
        linuxConfiguration: {
          disablePasswordAuthentication: false,
        },
      },
      networkProfile: {
        networkInterfaces: [
          {
            id: body.networkInterfaceId,
            properties: {
              primary: true,
            },
          },
        ],
      },
    },
  };

  const osProfile = (requestBody.properties as Record<string, unknown>).osProfile as Record<string, unknown>;
  if (body.sshPublicKey) {
    osProfile.linuxConfiguration = {
      disablePasswordAuthentication: false,
      ssh: {
        publicKeys: [{
          path: `/home/${body.adminUsername}/.ssh/authorized_keys`,
          keyData: body.sshPublicKey,
        }],
      },
    };
  }

  if (body.userData) {
    osProfile.customData = encodeUtf8Base64(body.userData);
  }

  await client.executeLongRunningOperation(
    "PUT",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}`,
    {
      apiVersion: AZURE_API_VERSIONS.compute,
      body: requestBody,
    },
  );
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function extractResourceGroupFromId(resourceId: string): string {
  const parts = resourceId.split("/");
  const index = parts.findIndex((segment) => segment.toLowerCase() === "resourcegroups");
  if (index === -1 || !parts[index + 1]) {
    throw new Error(`invalid_resource_id:${resourceId}`);
  }
  return parts[index + 1];
}

function extractNameFromId(resourceId: string): string {
  const parts = resourceId.split("/");
  const name = parts.at(-1);
  if (!name) {
    throw new Error(`invalid_resource_id:${resourceId}`);
  }
  return name;
}

async function resolveVirtualMachinePublicIp(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  nicId: string | null,
): Promise<{ ip: string; allocationMethod: string | null }> {
  if (!nicId) {
    return { ip: "N/A", allocationMethod: null };
  }

  try {
    const nicName = extractNameFromId(nicId);
    const nic = await getNetworkInterface(client, subscriptionId, resourceGroup, nicName);
    const publicIpId = nic.properties.ipConfigurations?.[0]?.properties?.publicIPAddress?.id;
    if (!publicIpId) {
      return { ip: "N/A", allocationMethod: null };
    }

    const publicIpName = extractNameFromId(publicIpId);
    const publicIp = await getPublicIpAddress(client, subscriptionId, resourceGroup, publicIpName);
    return {
      ip: publicIp.properties?.ipAddress ?? "N/A",
      allocationMethod: publicIp.properties?.publicIPAllocationMethod ?? null,
    };
  } catch {
    return { ip: "查询失败", allocationMethod: null };
  }
}
