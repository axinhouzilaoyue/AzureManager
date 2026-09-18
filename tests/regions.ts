// Unit test for the deployable-region resolver.
//
//   bun tests/regions.ts
//
// The create-VM dialog used to offer ARM's raw `/subscriptions/{id}/locations`
// answer, so geo-groups ("United States", "Europe"), regions where
// Microsoft.Compute is unavailable, and regions forbidden by an enforced
// "Allowed locations" Azure Policy all showed up as valid targets. This test
// pins the filtering rules against a fake ARM endpoint.

import { listDeployableLocations } from "../src/lib/azure/subscription";
import { AzureArmClient } from "../src/lib/azure/client";
import { resetAzureTokenCache } from "../src/lib/azure/token-cache";
import type { AppEnv, DecryptedAccountRecord } from "../src/types";

const PORT = Number(process.env.REGION_TEST_PORT ?? 9297);
const BASE = `http://127.0.0.1:${PORT}`;
const SUB = "00000000-0000-4000-8000-0000000000ff";

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Every region ARM reports for the subscription, mixes of each kind. */
const LOCATIONS = {
  value: [
    { name: "eastus", displayName: "East US", metadata: { regionType: "Physical", regionCategory: "Recommended" } },
    { name: "eastasia", displayName: "East Asia", metadata: { regionType: "Physical", regionCategory: "Recommended" } },
    { name: "japaneast", displayName: "Japan East", metadata: { regionType: "Physical", regionCategory: "Recommended" } },
    { name: "brazilsouth", displayName: "Brazil South", metadata: { regionType: "Physical", regionCategory: "Recommended" } },
    // Regions with no Compute availability for this subscription.
    { name: "southafricawest", displayName: "South Africa West", metadata: { regionType: "Physical" } },
    // Geo-groups / aggregates: reported by ARM, never deployable.
    { name: "unitedstates", displayName: "United States", metadata: { regionType: "Logical", regionCategory: "Other" } },
    { name: "europe", displayName: "Europe", metadata: { regionType: "Logical", regionCategory: "Other" } },
    // Sovereign clouds sometimes omit `metadata` entirely; the aggregate name
    // must still be rejected.
    { name: "asia", displayName: "Asia" },
    { name: "japan", displayName: "Japan" },
    // A real region that a policy will forbid.
    { name: "westus2", displayName: "West US 2", metadata: { regionType: "Physical" } },
    { name: "francecentral", displayName: "France Central", metadata: { regionType: "Physical" } },
  ],
};

/** `resourceTypes[].locations` are display names in the ARM provider response. */
const COMPUTE_PROVIDER = {
  namespace: "Microsoft.Compute",
  registrationState: "Registered",
  resourceTypes: [
    { resourceType: "virtualMachines", locations: ["East US", "East Asia", "Japan East", "Brazil South", "West US 2", "France Central"] },
    { resourceType: "disks", locations: ["East US", "East Asia", "Japan East"] },
  ],
};

/** Mirrors the real ARM shape: assignments carry their payload under `properties`. */
type PolicyFixture = {
  properties?: {
    displayName?: string;
    enforcementMode?: string;
    parameters?: Record<string, unknown>;
  };
};

let policyAssignments: PolicyFixture[] = [];

function policyAssignmentList(): { value: PolicyFixture[] } {
  return { value: policyAssignments };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    if (req.method === "POST" && path.endsWith("/oauth2/v2.0/token")) {
      return json({ token_type: "Bearer", expires_in: 3600, access_token: "fake-token" });
    }
    if (path === `/subscriptions/${SUB}/locations`) return json(LOCATIONS);
    if (path === `/subscriptions/${SUB}/providers/Microsoft.Compute`) return json(COMPUTE_PROVIDER);
    if (path === `/subscriptions/${SUB}/providers/Microsoft.Authorization/policyAssignments`) {
      return json(policyAssignmentList());
    }
    return json({ value: [] });
  },
});

function buildEnv(): AppEnv {
  return {
    APP_NAME: "test",
    APP_PASSWORD: "test",
    SESSION_SECRET: "test",
    ACCOUNT_ENCRYPTION_KEY: "test",
    SESSION_TTL_SECONDS: 60,
    LOCK_TIMEOUT_SECONDS: 60,
    AZURE_ARM_BASE_URL: BASE,
    AZURE_AUTH_BASE_URL: BASE,
    DB: null as unknown as AppEnv["DB"],
  };
}

const ACCOUNT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test",
  clientId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
  subscriptionId: SUB,
  clientSecret: "secret",
} as unknown as DecryptedAccountRecord;

async function resolve() {
  const env = buildEnv();
  const client = new AzureArmClient(env, ACCOUNT);
  return listDeployableLocations(client, SUB);
}

function names(list: Array<{ name: string }>): string[] {
  return list.map((item) => item.name).sort();
}

async function main(): Promise<void> {
  try {
    console.log("\n\x1b[1m1. No policy: aggregates and non-deployable regions are dropped\x1b[0m");
    policyAssignments = [];
    let result = await resolve();
    check(
      "only deployable physical regions remain",
      names(result.locations).join(",") === "brazilsouth,eastasia,eastus,francecentral,japaneast,westus2",
      JSON.stringify(names(result.locations)),
    );
    check(
      "geo-groups are reported as excluded",
      result.excludedNonPhysical.includes("unitedstates")
        && result.excludedNonPhysical.includes("europe")
        && result.excludedNonPhysical.includes("asia")
        && result.excludedNonPhysical.includes("japan"),
      JSON.stringify(result.excludedNonPhysical),
    );
    check(
      "regions without Microsoft.Compute are excluded",
      result.excludedNotDeployable.join(",") === "southafricawest",
      JSON.stringify(result.excludedNotDeployable),
    );
    check("no policy restriction is claimed", result.policyAssignments === 0, String(result.policyAssignments));
    check("no warning for a clean read", result.warning === null, String(result.warning));

    console.log("\n\x1b[1m2. An enforced Deny policy narrows the list\x1b[0m");
    policyAssignments = [
      {
        properties: {
          parameters: {
            listOfAllowedLocations: { value: ["eastus", "eastasia", "japaneast"] },
            effect: { value: "Deny" },
          },
        },
      },
    ];
    result = await resolve();
    check(
      "only policy-allowed regions survive",
      names(result.locations).join(",") === "eastasia,eastus,japaneast",
      JSON.stringify(names(result.locations)),
    );
    check(
      "policy-excluded regions are reported",
      result.excludedByPolicy.sort().join(",") === "brazilsouth,francecentral,westus2",
      JSON.stringify(result.excludedByPolicy),
    );
    check("the assignment is counted", result.policyAssignments === 1, String(result.policyAssignments));

    console.log("\n\x1b[1m3. Audit / DoNotEnforce assignments must not hide regions\x1b[0m");
    policyAssignments = [
      {
        properties: {
          parameters: {
            listOfAllowedLocations: { value: ["eastus"] },
            effect: { value: "Audit" },
          },
        },
      },
    ];
    result = await resolve();
    check(
      "an Audit-only assignment does not restrict the list",
      names(result.locations).join(",") === "brazilsouth,eastasia,eastus,francecentral,japaneast,westus2",
      JSON.stringify(names(result.locations)),
    );
    check("it is not counted as enforced", result.policyAssignments === 0, String(result.policyAssignments));

    policyAssignments = [
      {
        properties: {
          enforcementMode: "DoNotEnforce",
          parameters: {
            listOfAllowedLocations: { value: ["eastus"] },
            effect: { value: "Deny" },
          },
        },
      },
    ];
    result = await resolve();
    check(
      "DoNotEnforce does not restrict the list",
      names(result.locations).join(",") === "brazilsouth,eastasia,eastus,francecentral,japaneast,westus2",
      JSON.stringify(names(result.locations)),
    );

    console.log("\n\x1b[1m4. Multiple Deny policies intersect; display names are understood\x1b[0m");
    policyAssignments = [
      // Portal-authored policies often store display names, not region ids.
      {
        properties: {
          parameters: { listOfAllowedLocations: { value: ["East US", "Japan East"] }, effect: { value: "Deny" } },
        },
      },
      {
        properties: {
          parameters: { allowedLocations: { value: ["japaneast", "eastus", "westus2"] }, effect: { value: "deny" } },
        },
      },
    ];
    result = await resolve();
    check(
      "the intersection of both policies is applied",
      names(result.locations).join(",") === "eastus,japaneast",
      JSON.stringify(names(result.locations)),
    );
    check("both assignments are counted", result.policyAssignments === 2, String(result.policyAssignments));

    console.log("\n\x1b[1m5. A policy that allows nothing yields no regions, plus a warning\x1b[0m");
    policyAssignments = [
      { properties: { parameters: { listOfAllowedLocations: { value: [] }, effect: { value: "Deny" } } } },
    ];
    result = await resolve();
    check("the list is empty", result.locations.length === 0, JSON.stringify(names(result.locations)));
    check("the empty result is explained", Boolean(result.warning), String(result.warning));

    console.log("\n\x1b[1m6. Unrelated assignments are ignored\x1b[0m");
    policyAssignments = [
      { properties: { parameters: { listOfAllowedResourceTypes: { value: ["Microsoft.Compute/virtualMachines"] } } } },
      { properties: { parameters: { requiredTag: { value: "owner" } } } },
    ];
    result = await resolve();
    check(
      "no restriction is inferred from unrelated parameters",
      names(result.locations).join(",") === "brazilsouth,eastasia,eastus,francecentral,japaneast,westus2",
      JSON.stringify(names(result.locations)),
    );
    check("nothing is counted", result.policyAssignments === 0, String(result.policyAssignments));
  } finally {
    server.stop(true);
    resetAzureTokenCache();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed checks:");
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
}

await main();
