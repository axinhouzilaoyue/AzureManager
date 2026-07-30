import type { AzureVmSummary } from "../../types";
import { AZURE_API_VERSIONS, AZURE_OS_IMAGES, DEFAULT_VM_ADMIN_USERNAME } from "./constants";
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

      const publicIp = await resolveVirtualMachinePublicIp(
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
        publicIp,
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
    osImage: keyof typeof AZURE_OS_IMAGES;
    diskSizeGb: number;
    networkInterfaceId: string;
    adminPassword: string;
    userData: string | null;
  },
): Promise<void> {
  const osImage = AZURE_OS_IMAGES[body.osImage];
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
          // Default path targets Premium SSD (P6 = 64GB).
          managedDisk: {
            storageAccountType: "Premium_LRS",
          },
        },
      },
      osProfile: {
        computerName: vmName,
        adminUsername: DEFAULT_VM_ADMIN_USERNAME,
        adminPassword: body.adminPassword,
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

  if (body.userData) {
    (requestBody.properties as Record<string, unknown>).osProfile = {
      ...((requestBody.properties as Record<string, unknown>).osProfile as Record<string, unknown>),
      customData: encodeUtf8Base64(body.userData),
    };
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
): Promise<string> {
  if (!nicId) {
    return "N/A";
  }

  try {
    const nicName = extractNameFromId(nicId);
    const nic = await getNetworkInterface(client, subscriptionId, resourceGroup, nicName);
    const publicIpId = nic.properties.ipConfigurations?.[0]?.properties?.publicIPAddress?.id;
    if (!publicIpId) {
      return "N/A";
    }

    const publicIpName = extractNameFromId(publicIpId);
    const publicIp = await getPublicIpAddress(client, subscriptionId, resourceGroup, publicIpName);
    return publicIp.properties?.ipAddress ?? "N/A";
  } catch {
    return "查询失败";
  }
}
