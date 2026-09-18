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
    displayName?: string;
    enforcementMode?: string;
    parameters?: Record<string, unknown>;
  };
}

interface LocationResponseItem {
  name?: string;
  displayName?: string;
  metadata?: {
    regionType?: string;
    regionCategory?: string;
  };
}

/**
 * Result of resolving "which regions can this subscription actually deploy into".
 * The counters exist so the create-VM dialog can explain *why* a region is
 * missing instead of silently showing the wrong list.
 */
export interface AzureLocationListing {
  locations: AzureLocation[];
  /** Locations ARM reported for the subscription before any filtering. */
  rawCount: number;
  /** Dropped because they are geo-groups/"logical" names, not real regions. */
  excludedNonPhysical: string[];
  /** Dropped because Microsoft.Compute is not available there for this subscription. */
  excludedNotDeployable: string[];
  /** Dropped because an enforced Azure Policy does not allow them. */
  excludedByPolicy: string[];
  /** Enforced "allowed locations" assignments that produced a restriction. */
  policyAssignments: number;
  /** True when policy assignments could not be read (not a 401/403 permission miss). */
  policyReadFailed: boolean;
  /** Non-blocking diagnostics (provider/policy read failures, empty results). */
  warning: string | null;
}

const REQUIRED_PROVIDERS = [
  "Microsoft.Compute",
  "Microsoft.Network",
  "Microsoft.CostManagement",
  "Microsoft.CognitiveServices",
] as const;

/**
 * Geo-groups / aggregate names that ARM's `/locations` endpoint returns next to
 * real regions. They are not deployable targets, and some tenants report them
 * without the `metadata.regionType` marker the API documents, so they are also
 * excluded by name. Every entry here is a well-known aggregate whose physical
 * counterparts are suffixed (e.g. `japan` vs `japaneast`).
 */
const AGGREGATE_LOCATION_NAMES = new Set([
  "global",
  "unitedstates",
  "unitedstateseuap",
  "unitedstatesgov",
  "europe",
  "asia",
  "asiapacific",
  "australia",
  "brazil",
  "canada",
  "china",
  "france",
  "germany",
  "india",
  "japan",
  "korea",
  "uk",
  "usgov",
  "government",
]);

/**
 * Policy effects that do not block a deployment. An "Allowed locations" policy
 * assigned with one of these restrictions is informational only, so treating it
 * as a restriction would hide regions that work.
 */
const NON_BLOCKING_POLICY_EFFECTS = new Set([
  "audit",
  "auditifnotexists",
  "disabled",
  "manual",
  "denyaction",
]);

/** `East US` / `eastus` / `East-US` all collapse to `eastus`. */
function normalizeLocationKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

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

/**
 * Regions where `Microsoft.Compute` is available for this subscription, keyed by
 * normalized name. This is the authoritative "can I create a VM here" signal:
 * unlike `/subscriptions/{id}/locations` it never contains geo-groups, and it
 * already accounts for regional provider restrictions on the subscription.
 *
 * The provider response reports display names (`East US`), so both the region
 * name and its display name are indexed.
 */
async function listDeployableRegionKeys(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<Set<string> | null> {
  const response = await client.request<{
    resourceTypes?: Array<{ resourceType?: string; locations?: string[] }>;
  }>(
    "GET",
    `/subscriptions/${subscriptionId}/providers/Microsoft.Compute`,
    { apiVersion: AZURE_API_VERSIONS.providers },
  );

  const keys = new Set<string>();
  for (const resourceType of response.resourceTypes ?? []) {
    // Only virtualMachines — disks/snapshots/etc. can list regions where a VM
    // cannot actually be created.
    if ((resourceType.resourceType ?? "").toLowerCase() !== "virtualmachines") continue;
    for (const location of resourceType.locations ?? []) {
      if (typeof location === "string" && location.trim()) {
        keys.add(normalizeLocationKey(location));
      }
    }
  }

  // An unregistered provider returns an empty/short list; treating that as
  // "nothing is deployable" would empty the dropdown, so ignore it instead.
  return keys.size >= 5 ? keys : null;
}

/**
 * Reads the enforced "allowed locations" restrictions for a subscription.
 *
 * Only assignments that actually block a deployment (effect not audit/disabled,
 * `enforcementMode` not `DoNotEnforce`) are considered, and multiple blocking
 * assignments are intersected — with several deny policies in force, a region
 * must satisfy all of them.
 *
 * Returns `null` for the key set when no blocking restriction was found, which
 * means "do not filter".
 */
async function collectPolicyAllowedLocations(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<{ allowed: Set<string> | null; assignments: number; failed: boolean }> {
  let assignments: PolicyAssignment[];
  try {
    assignments = await client.paginate<PolicyAssignment>(
      `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyAssignments`,
      AZURE_API_VERSIONS.policyAssignments,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // VM-operator principals often lack Policy Reader. CloudManager treats this
    // as "no restriction" and still offers the Compute-filtered region list.
    if (/azure_arm_request_failed:(401|403)\b/.test(message)) {
      return { allowed: null, assignments: 0, failed: false };
    }
    return { allowed: null, assignments: 0, failed: true };
  }

  const sets: Set<string>[] = [];

  for (const assignment of assignments) {
    const properties = assignment.properties;
    if (!properties) continue;
    if (String(properties.enforcementMode ?? "").toLowerCase() === "donotenforce") continue;

    const parameters = properties.parameters ?? {};
    const effect = readEffect(parameters);
    if (effect && NON_BLOCKING_POLICY_EFFECTS.has(effect)) continue;

    const values = readAllowedLocationValues(parameters);
    if (!values) {
      // Not an allowed-locations assignment at all (most assignments are not).
      continue;
    }

    sets.push(new Set(values.map(normalizeLocationKey).filter(Boolean)));
  }

  if (!sets.length) return { allowed: null, assignments: 0, failed: false };

  const allowed = sets.reduce((intersection, current) => {
    return new Set([...intersection].filter((value) => current.has(value)));
  });

  return { allowed, assignments: sets.length, failed: false };
}

/** Resolves the policy effect, which may be a bare string or `{ value: ... }`. */
function readEffect(parameters: Record<string, unknown>): string | null {
  for (const [key, raw] of Object.entries(parameters)) {
    if (!/effect/i.test(key)) continue;
    const value = unwrapPolicyValue(raw);
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

/**
 * Finds the "allowed locations" list inside an assignment's parameters.
 *
 * The built-in policy/initiative uses `listOfAllowedLocations`; custom policies
 * often use `allowedLocations`. Deny-lists are ignored so they cannot invert
 * the restriction.
 */
function readAllowedLocationValues(parameters: Record<string, unknown>): string[] | null {
  const entries = Object.entries(parameters);
  // Built-in policy uses listOfAllowedLocations; custom policies often use
  // allowedLocations. Do not match deny-lists (listOfDeniedLocations) — that
  // would invert the restriction.
  const named = entries.filter(([key]) =>
    /^(listof)?allowed(locations?|regions?)$/i.test(key.replace(/[^a-zA-Z]/g, "")),
  );

  for (const [, raw] of named) {
    const value = unwrapPolicyValue(raw);
    if (Array.isArray(value)) {
      const list = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      if (list.length || value.length === 0) return list;
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }

  return null;
}

/** Assignment parameters are `{ value: ... }` wrappers, but tolerate bare values. */
function unwrapPolicyValue(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).value;
  }
  return raw;
}

function isPhysicalRegion(location: LocationResponseItem): boolean {
  const name = (location.name ?? "").trim().toLowerCase();
  if (!name) return false;
  if (AGGREGATE_LOCATION_NAMES.has(name)) return false;

  const regionType = location.metadata?.regionType;
  if (regionType) return regionType.toLowerCase() === "physical";

  // No metadata (older api-versions / sovereign clouds): fall back to the
  // aggregate denylist above plus the deployable-region intersection.
  return true;
}

/**
 * Regions that can actually be used to create a VM with this subscription:
 * real (non-aggregate) regions, restricted to where Microsoft.Compute is
 * available, minus everything an enforced Azure Policy forbids.
 */
export async function listDeployableLocations(
  client: AzureArmClient,
  subscriptionId: string,
): Promise<AzureLocationListing> {
  const [response, deployableKeys, policy] = await Promise.all([
    client.request<{ value?: LocationResponseItem[] }>(
      "GET",
      `/subscriptions/${subscriptionId}/locations`,
      { apiVersion: AZURE_API_VERSIONS.subscriptions },
    ),
    listDeployableRegionKeys(client, subscriptionId).catch(() => null),
    collectPolicyAllowedLocations(client, subscriptionId).catch(() => ({
      allowed: null,
      assignments: 0,
      failed: true,
    })),
  ]);

  const raw = response.value ?? [];
  const physical = raw.filter(isPhysicalRegion).map((location) => ({
    name: (location.name ?? "").trim(),
    displayName: (location.displayName ?? location.name ?? "").trim(),
  }));

  const excludedNonPhysical = raw
    .map((location) => (location.name ?? "").trim())
    .filter((name) => name && !physical.some((item) => item.name.toLowerCase() === name.toLowerCase()));

  const excludedNotDeployable: string[] = [];
  const deployable = deployableKeys
    ? physical.filter((location) => {
        const hit = deployableKeys.has(normalizeLocationKey(location.name))
          || deployableKeys.has(normalizeLocationKey(location.displayName));
        if (!hit) excludedNotDeployable.push(location.name);
        return hit;
      })
    : physical;

  const allowed = policy?.allowed ?? null;
  const excludedByPolicy: string[] = [];
  const locations = allowed
    ? deployable.filter((location) => {
        const hit = allowed.has(normalizeLocationKey(location.name))
          || allowed.has(normalizeLocationKey(location.displayName));
        if (!hit) excludedByPolicy.push(location.name);
        return hit;
      })
    : deployable;

  const warnings: string[] = [];
  if (policy.failed) {
    warnings.push("策略读取失败，未能校验区域限制");
  } else if (allowed && !locations.length && raw.length) {
    warnings.push("当前订阅的策略不允许任何区域");
  }

  return {
    locations: locations.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    rawCount: raw.length,
    excludedNonPhysical,
    excludedNotDeployable,
    excludedByPolicy,
    policyAssignments: policy.assignments,
    policyReadFailed: policy.failed,
    warning: warnings.length ? warnings.join("；") : null,
  };
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
