import { AZURE_API_VERSIONS } from "./constants";
import { AzureArmClient } from "./client";

export interface AzureNetworkInterface {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  properties: {
    enableIPForwarding?: boolean;
    enableAcceleratedNetworking?: boolean;
    networkSecurityGroup?: { id: string };
    nicType?: string;
    ipConfigurations: Array<{
      name: string;
      properties: {
        primary?: boolean;
        privateIPAllocationMethod?: string;
        privateIPAddressVersion?: string;
        subnet?: { id: string };
        publicIPAddress?: { id: string } | null;
      };
    }>;
  };
}

export interface AzurePublicIpAddress {
  id: string;
  name: string;
  location: string;
  properties?: {
    ipAddress?: string;
    publicIPAllocationMethod?: string;
  };
}

export interface AzureVirtualNetwork {
  id: string;
  name: string;
  location: string;
  properties: {
    subnets: Array<{
      id: string;
      name: string;
    }>;
  };
}

export async function getNetworkInterface(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  nicName: string,
): Promise<AzureNetworkInterface> {
  return client.request(
    "GET",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
    },
  );
}

export async function createOrUpdateNetworkInterface(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  nicName: string,
  body: Record<string, unknown>,
): Promise<void> {
  await client.executeLongRunningOperation(
    "PUT",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkInterfaces/${nicName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
      body,
    },
  );
}

export async function createVirtualNetwork(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  networkName: string,
  location: string,
): Promise<AzureVirtualNetwork> {
  await client.executeLongRunningOperation(
    "PUT",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/virtualNetworks/${networkName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
      body: {
        location,
        properties: {
          addressSpace: {
            addressPrefixes: ["10.0.0.0/16"],
          },
          subnets: [
            {
              name: "default",
              properties: {
                addressPrefix: "10.0.0.0/24",
              },
            },
          ],
        },
      },
    },
  );

  return client.request(
    "GET",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/virtualNetworks/${networkName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
    },
  );
}

export async function getPublicIpAddress(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  publicIpName: string,
): Promise<AzurePublicIpAddress> {
  return client.request(
    "GET",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/publicIPAddresses/${publicIpName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
    },
  );
}

export async function createPublicIpAddress(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  publicIpName: string,
  location: string,
  ipType: "Static" | "Dynamic",
): Promise<AzurePublicIpAddress> {
  await client.executeLongRunningOperation(
    "PUT",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/publicIPAddresses/${publicIpName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
      body: {
        location,
        sku: {
          name: ipType === "Dynamic" ? "Basic" : "Standard",
        },
        properties: {
          publicIPAllocationMethod: ipType,
        },
      },
    },
  );

  return getPublicIpAddress(client, subscriptionId, resourceGroup, publicIpName);
}

export async function deletePublicIpAddress(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  publicIpName: string,
): Promise<void> {
  await client.executeLongRunningOperation(
    "DELETE",
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/publicIPAddresses/${publicIpName}`,
    {
      apiVersion: AZURE_API_VERSIONS.network,
    },
  );
}

export function buildNetworkInterfacePayload(
  nic: AzureNetworkInterface,
  replacementPublicIpId: string | null,
): Record<string, unknown> {
  const ipConfigurations = nic.properties.ipConfigurations.map((configuration, index) => ({
    name: configuration.name || `ipconfig${index + 1}`,
    properties: {
      primary: configuration.properties.primary,
      privateIPAllocationMethod: configuration.properties.privateIPAllocationMethod,
      privateIPAddressVersion: configuration.properties.privateIPAddressVersion,
      subnet: configuration.properties.subnet,
      publicIPAddress:
        index === 0
          ? replacementPublicIpId
            ? { id: replacementPublicIpId }
            : null
          : configuration.properties.publicIPAddress ?? null,
    },
  }));

  return {
    location: nic.location,
    tags: nic.tags,
    properties: {
      enableIPForwarding: nic.properties.enableIPForwarding,
      enableAcceleratedNetworking: nic.properties.enableAcceleratedNetworking,
      networkSecurityGroup: nic.properties.networkSecurityGroup,
      nicType: nic.properties.nicType,
      ipConfigurations,
    },
  };
}
