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
  }>;
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
        status: powerState?.displayStatus?.replace(/^VM\s+/i, "") ?? "Unknown",
        resourceGroup,
        publicIp,
        timeCreated: virtualMachine.properties?.timeCreated ?? null,
      } satisfies AzureVmSummary;
    }),
  );

  return summaries.sort((left, right) => left.name.localeCompare(right.name));
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
