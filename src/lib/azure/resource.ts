import { AZURE_API_VERSIONS } from "./constants";
import { AzureArmClient } from "./client";

export async function createOrUpdateResourceGroup(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
  location: string,
): Promise<void> {
  await client.request(
    "PUT",
    `/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}`,
    {
      apiVersion: AZURE_API_VERSIONS.resources,
      body: {
        location,
      },
    },
  );
}

export async function deleteResourceGroup(
  client: AzureArmClient,
  subscriptionId: string,
  resourceGroup: string,
): Promise<void> {
  await client.executeLongRunningOperation(
    "DELETE",
    `/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}`,
    {
      apiVersion: AZURE_API_VERSIONS.resources,
    },
  );
}
