import { AZURE_API_VERSIONS } from "./constants";
import { AzureArmClient } from "./client";

export interface AzureLocation {
  name: string;
  displayName: string;
}

export interface AzureSubscriptionDetails {
  displayName: string;
  state: string;
}

interface AzureSubscriptionResponse {
  displayName?: string;
  state?: string;
}

export async function listSubscriptionLocations(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<AzureLocation[]> {
  const response = await client.request<{
    value?: Array<{
      name: string;
      displayName: string;
    }>;
  }>(
    "GET",
    `/subscriptions/${subscriptionId}/locations`,
    {
      apiVersion: AZURE_API_VERSIONS.subscriptions,
    },
  );

  return (response.value ?? []).map((location) => ({
    name: location.name,
    displayName: location.displayName,
  }));
}

export async function getSubscriptionDetails(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<AzureSubscriptionDetails> {
  const response = await client.request<AzureSubscriptionResponse>(
    "GET",
    `/subscriptions/${subscriptionId}`,
    {
      apiVersion: AZURE_API_VERSIONS.subscriptions,
    },
  );

  return {
    displayName: response.displayName ?? subscriptionId,
    state: response.state ?? "Unknown",
  };
}
