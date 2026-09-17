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

interface PolicyAssignment {
  properties?: {
    parameters?: Record<string, { value?: unknown }>;
  };
}

const REQUIRED_PROVIDERS = [
  "Microsoft.Compute",
  "Microsoft.Network",
  "Microsoft.CostManagement",
  "Microsoft.CognitiveServices",
] as const;

export async function registerRequiredProviders(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<string[]> {
  const warnings: string[] = [];
  await Promise.all(REQUIRED_PROVIDERS.map(async (namespace) => {
    try {
      await client.request(
        "POST",
        `/subscriptions/${subscriptionId}/providers/${namespace}/register`,
        { apiVersion: AZURE_API_VERSIONS.providers },
      );
    } catch (error) {
      warnings.push(`${namespace}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  return warnings;
}

export async function listSubscriptionLocations(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<AzureLocation[]> {
  const [response, allowedLocations] = await Promise.all([
    client.request<{
      value?: Array<{
        name: string;
        displayName: string;
        metadata?: { regionType?: string };
      }>;
    }>(
      "GET",
      `/subscriptions/${subscriptionId}/locations`,
      { apiVersion: AZURE_API_VERSIONS.subscriptions },
    ),
    listPolicyAllowedLocations(client, subscriptionId),
  ]);

  return (response.value ?? [])
    .filter((location) => !location.metadata?.regionType || location.metadata.regionType === "Physical")
    .filter((location) => !allowedLocations || allowedLocations.has(location.name.toLowerCase()))
    .map((location) => ({
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
    { apiVersion: AZURE_API_VERSIONS.subscriptions },
  );

  return {
    displayName: response.displayName ?? subscriptionId,
    state: response.state ?? "Unknown",
  };
}

async function listPolicyAllowedLocations(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<Set<string> | null> {
  try {
    const assignments = await client.paginate<PolicyAssignment>(
      `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyAssignments`,
      AZURE_API_VERSIONS.authorization,
    );
    const sets: Set<string>[] = [];
    for (const assignment of assignments) {
      const parameters = assignment.properties?.parameters ?? {};
      const list = parameters.listOfAllowedLocations?.value ?? parameters.allowedLocations?.value;
      if (!Array.isArray(list)) continue;
      const values = list
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim().toLowerCase());
      if (values.length) sets.push(new Set(values));
    }
    if (!sets.length) return null;
    return sets.reduce((intersection, current) => {
      return new Set([...intersection].filter((value) => current.has(value)));
    });
  } catch {
    return null;
  }
}
