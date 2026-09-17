// Mock Azure ARM + AAD endpoint used by tests/switch-race.ts.
//
// The app talks to Azure through AZURE_ARM_BASE_URL / AZURE_AUTH_BASE_URL, both of
// which are env-configurable, so a fake upstream lets us exercise the real server
// routes (including the account-switch data path) without any Azure credentials.
//
// Usage: MOCK_AZURE_PORT=9099 MOCK_VM_DELAY_MS=400 bun tests/mock-azure.ts

const PORT = Number(process.env.MOCK_AZURE_PORT ?? 9099);
const VM_DELAY_MS = Number(process.env.MOCK_VM_DELAY_MS ?? 0);

interface Stats {
  token: number;
  vmList: Record<string, number>;
  nicList: Record<string, number>;
  publicIpList: Record<string, number>;
  other: number;
}

const stats: Stats = { token: 0, vmList: {}, nicList: {}, publicIpList: {}, other: 0 };

function tagForSubscription(subscriptionId: string): string {
  // Test subscriptions are named so the account letter is the last character.
  return subscriptionId.slice(-1).toUpperCase();
}

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function virtualMachines(subscriptionId: string) {
  const tag = tagForSubscription(subscriptionId);
  return [
    {
      id: `/subscriptions/${subscriptionId}/resourceGroups/rg-${tag}/providers/Microsoft.Compute/virtualMachines/vm-${tag}-1`,
      name: `vm-${tag}-1`,
      location: "eastus",
      properties: {
        timeCreated: "2026-01-01T00:00:00.000Z",
        instanceView: {
          statuses: [
            { code: "PowerState/running", displayStatus: "VM running", time: "2026-01-02T00:00:00.000Z" },
          ],
        },
        hardwareProfile: { vmSize: "Standard_B1s" },
        networkProfile: {
          networkInterfaces: [
            {
              id: `/subscriptions/${subscriptionId}/resourceGroups/rg-${tag}/providers/Microsoft.Network/networkInterfaces/nic-${tag}-1`,
            },
          ],
        },
        storageProfile: { osDisk: { diskSizeGb: 64 } },
      },
    },
    {
      id: `/subscriptions/${subscriptionId}/resourceGroups/rg-${tag}/providers/Microsoft.Compute/virtualMachines/vm-${tag}-2`,
      name: `vm-${tag}-2`,
      location: "eastus",
      properties: {
        timeCreated: "2026-01-03T00:00:00.000Z",
        instanceView: {
          statuses: [{ code: "PowerState/deallocated", displayStatus: "VM deallocated" }],
        },
        hardwareProfile: { vmSize: "Standard_B1s" },
        networkProfile: { networkInterfaces: [] },
        storageProfile: { osDisk: { diskSizeGb: 32 } },
      },
    },
  ];
}

function networkInterfaces(subscriptionId: string) {
  const tag = tagForSubscription(subscriptionId);
  return [
    {
      id: `/subscriptions/${subscriptionId}/resourceGroups/rg-${tag}/providers/Microsoft.Network/networkInterfaces/nic-${tag}-1`,
      name: `nic-${tag}-1`,
      properties: {
        ipConfigurations: [
          {
            properties: {
              primary: true,
              publicIPAddress: {
                id: `/subscriptions/${subscriptionId}/resourceGroups/rg-${tag}/providers/Microsoft.Network/publicIPAddresses/pip-${tag}-1`,
              },
            },
          },
        ],
      },
    },
  ];
}

function publicIpAddresses(subscriptionId: string) {
  const tag = tagForSubscription(subscriptionId);
  return [
    {
      id: `/subscriptions/${subscriptionId}/resourceGroups/rg-${tag}/providers/Microsoft.Network/publicIPAddresses/pip-${tag}-1`,
      name: `pip-${tag}-1`,
      properties: { ipAddress: `10.0.0.${tag.charCodeAt(0)}`, publicIPAllocationMethod: "Static" },
    },
  ];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    if (path === "/__stats") return json(stats);
    if (path === "/__reset") {
      stats.token = 0;
      stats.vmList = {};
      stats.nicList = {};
      stats.publicIpList = {};
      stats.other = 0;
      return json({ ok: true });
    }

    // AAD client-credentials token endpoint: /{tenantId}/oauth2/v2.0/token
    if (req.method === "POST" && path.endsWith("/oauth2/v2.0/token")) {
      stats.token += 1;
      const form = new URLSearchParams(await req.text());
      return json({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: `fake-token-${form.get("client_id") ?? "unknown"}`,
      });
    }

    const subMatch = path.match(/^\/subscriptions\/([^/]+)(\/.*)?$/);
    if (!subMatch) {
      stats.other += 1;
      return json({ value: [] });
    }
    const subscriptionId = subMatch[1];
    const rest = subMatch[2] ?? "";

    if (rest === "" || rest === "/") {
      stats.other += 1;
      return json({
        subscriptionId,
        displayName: `Mock Subscription ${tagForSubscription(subscriptionId)}`,
        state: "Enabled",
      });
    }
    if (rest === "/providers/Microsoft.Compute/virtualMachines") {
      bump(stats.vmList, subscriptionId);
      if (VM_DELAY_MS > 0) await delay(VM_DELAY_MS);
      return json({ value: virtualMachines(subscriptionId) });
    }
    if (rest === "/providers/Microsoft.Network/networkInterfaces") {
      bump(stats.nicList, subscriptionId);
      return json({ value: networkInterfaces(subscriptionId) });
    }
    if (rest === "/providers/Microsoft.Network/publicIPAddresses") {
      bump(stats.publicIpList, subscriptionId);
      return json({ value: publicIpAddresses(subscriptionId) });
    }

    stats.other += 1;
    return json({ value: [] });
  },
});

console.log(`[mock-azure] listening on http://127.0.0.1:${server.port} (vm delay ${VM_DELAY_MS}ms)`);
