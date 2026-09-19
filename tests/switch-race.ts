// Account-switch regression test.
//
//   bun tests/switch-race.ts
//
// Spins up tests/mock-azure.ts (fake AAD + ARM), seeds two accounts into a
// throwaway SQLite DB, and boots the real src/server.ts against them. It then:
//
//   1. still reproduces the underlying race deterministically — account A's
//      POST /api/session write lands *after* account B's, so the session cookie
//      ends up pointing at A even though the user switched to B. This is the
//      shared mutable state the bug came from, and it still exists;
//   2. proves the data path no longer depends on it: GET /api/accounts/B/vms
//      returns B's machines and echoes accountId even though the cookie says A;
//   3. proves the cookie-scoped VM route is gone (410), so the defect surface
//      cannot be reintroduced by accident;
//   4. covers response cacheability, single-flight de-duplication, AAD token
//      reuse, and warm-vs-cold switch latency;
//   5. statically asserts the client no longer calls the removed route.
//
// Exits non-zero if any check fails.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { toBase64Url } from "../src/lib/utils";
import { createAccount, initializeDatabase } from "../src/lib/db";
import type { AppEnv } from "../src/types";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP_DIR = `${REPO_ROOT}/.tmp/switch-race`;
const MOCK_PORT = 9099;
const APP_PORT = 8099;
const APP_PASSWORD = "test-password";

const ACCOUNT_A_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B_ID = "22222222-2222-4222-8222-222222222222";
const SUB_A = "00000000-0000-4000-8000-00000000000a";
const SUB_B = "00000000-0000-4000-8000-00000000000b";

const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

// ---- tiny assertion harness ----
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

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ---- http helpers ----
interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
  setCookies: string[];
  text: string;
  ms: number;
}

async function api(
  method: string,
  path: string,
  options: { cookie?: string | null; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const started = performance.now();
  const res = await fetch(APP + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const getSetCookie = (res.headers as any).getSetCookie?.bind(res.headers);
  return {
    status: res.status,
    body,
    headers: res.headers,
    setCookies: getSetCookie ? getSetCookie() : [],
    text,
    ms: Math.round(performance.now() - started),
  };
}

function sessionCookieValue(setCookies: string[], fallback: string | null): string | null {
  for (const raw of setCookies) {
    const match = raw.match(/^azure_cf_session=([^;]*)/);
    if (match) return `azure_cf_session=${match[1]}`;
  }
  return fallback;
}

function vmNames(body: any): string[] {
  const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  return items.map((vm: any) => String(vm?.name ?? "")).sort();
}

// Sends POST /api/session but stalls midway through the body, so the server
// cannot dispatch it until we release it. Models "account A's switch write is
// still in flight while the user has already clicked account B".
function deferredSessionPost(
  accountId: string,
  cookie: string,
  holdMs: number,
): Promise<{ cookie: string | null; raw: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ accountId });
    let raw = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ cookie: value, raw });
    };
    // The status line plus Set-Cookie is all we need; the server only answers
    // after it has read the whole body, so receiving it proves the write landed.
    const settleFromRaw = () => {
      if (!/^HTTP\/1\.1 \d{3}/.test(raw) || !/set-cookie:/i.test(raw)) return false;
      const match = raw.match(/set-cookie:\s*azure_cf_session=([^;\r\n]*)/i);
      finish(match ? `azure_cf_session=${match[1]}` : null);
      return true;
    };

    const socket = connect(APP_PORT, "127.0.0.1", () => {
      socket.write(
        `POST /api/session HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${APP_PORT}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Cookie: ${cookie}\r\n` +
          `Connection: close\r\n\r\n`,
      );
      const half = Math.floor(body.length / 2);
      socket.write(body.slice(0, half));
      setTimeout(() => socket.write(body.slice(half)), holdMs);
    });

    socket.on("data", (chunk) => {
      raw += chunk.toString();
      settleFromRaw();
    });
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("error", () => finish(null));
    setTimeout(() => {
      socket.destroy();
      finish(null);
    }, holdMs + 4000);
  });
}

// ---- boot ----
async function waitFor(url: string, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`service never became ready: ${url}`);
}

async function main(): Promise<void> {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(`${TMP_DIR}/data`, { recursive: true });

  const secrets = {
    sessionSecret: toBase64Url(crypto.getRandomValues(new Uint8Array(48))),
    encryptionKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
  writeFileSync(`${TMP_DIR}/data/.secret`, JSON.stringify(secrets));

  const db = new Database(`${TMP_DIR}/data/azure-manager.db`);
  db.exec("PRAGMA journal_mode = WAL;");
  initializeDatabase(db);
  const seedEnv = {
    ACCOUNT_ENCRYPTION_KEY: secrets.encryptionKey,
    DB: db,
  } as unknown as AppEnv;
  for (const account of [
    { id: ACCOUNT_A_ID, name: "Account A", subscriptionId: SUB_A, clientId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" },
    { id: ACCOUNT_B_ID, name: "Account B", subscriptionId: SUB_B, clientId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
  ]) {
    await createAccount(seedEnv, {
      id: account.id,
      name: account.name,
      clientId: account.clientId,
      tenantId: "33333333-3333-4333-8333-333333333333",
      subscriptionId: account.subscriptionId,
      clientSecret: "test-secret",
      email: null,
      expirationDate: null,
    });
  }
  db.close();

  const mock = Bun.spawn(["bun", `${REPO_ROOT}/tests/mock-azure.ts`], {
    env: { ...process.env, MOCK_AZURE_PORT: String(MOCK_PORT), MOCK_VM_DELAY_MS: "250" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const server = Bun.spawn(["bun", `${REPO_ROOT}/src/server.ts`], {
    cwd: TMP_DIR,
    env: {
      ...process.env,
      APP_PASSWORD,
      PORT: String(APP_PORT),
      AZURE_ARM_BASE_URL: MOCK,
      AZURE_AUTH_BASE_URL: MOCK,
      DEBUG_CACHE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const resetUpstream = () => fetch(`${MOCK}/__reset`);
  const readStats = async () => (await (await fetch(`${MOCK}/__stats`)).json()) as any;

  try {
    await waitFor(`${MOCK}/__stats`);
    await waitFor(`${APP}/health`);

    const login = await api("POST", "/auth/login", { body: { password: APP_PASSWORD } });
    let cookie = sessionCookieValue(login.setCookies, null);
    if (!cookie) throw new Error("login did not return a session cookie");

    // Resets both the upstream counters and the server's in-process caches.
    const resetAll = async () => {
      await resetUpstream();
      const res = await api("POST", "/api/_debug/cache/reset", { cookie });
      if (res.status !== 200) throw new Error(`cache reset failed: ${res.status}`);
    };

    // ---------------------------------------------------------------
    section("1. The cookie race is real (and is why data must not depend on it)");

    const selectB = await api("POST", "/api/session", { cookie, body: { accountId: ACCOUNT_B_ID } });
    cookie = sessionCookieValue(selectB.setCookies, cookie);
    check("POST /api/session (B) returns 200", selectB.status === 200, `status=${selectB.status}`);

    const late = await deferredSessionPost(ACCOUNT_A_ID, cookie!, 700);
    check(
      "late-landing POST /api/session (A) observed",
      Boolean(late.cookie),
      `raw response = ${JSON.stringify(late.raw.slice(0, 300))}`,
    );
    const racedCookie = late.cookie ?? cookie;

    const sessionAfterRace = await api("GET", "/api/session", { cookie: racedCookie });
    check(
      "server session now points at A (the race really happened)",
      sessionAfterRace.body?.selectedAccountId === ACCOUNT_A_ID,
      `selectedAccountId=${sessionAfterRace.body?.selectedAccountId}`,
    );

    // ---------------------------------------------------------------
    section("2. The data path carries account identity in-band");

    const bVms = await api("GET", `/api/accounts/${ACCOUNT_B_ID}/vms`, { cookie: racedCookie });
    check("GET /api/accounts/:id/vms returns 200", bVms.status === 200, `status=${bVms.status}`);
    check(
      "returns B's VMs even though the cookie points at A",
      vmNames(bVms.body).join(",") === "vm-B-1,vm-B-2",
      `got ${JSON.stringify(vmNames(bVms.body))}`,
    );
    check(
      "echoes accountId in the body",
      bVms.body?.accountId === ACCOUNT_B_ID,
      `accountId=${bVms.body?.accountId}`,
    );
    check(
      "sets x-account-id from the same source as the body",
      bVms.headers.get("x-account-id") === ACCOUNT_B_ID,
      `x-account-id=${bVms.headers.get("x-account-id")}`,
    );

    const aVms = await api("GET", `/api/accounts/${ACCOUNT_A_ID}/vms`, { cookie: racedCookie });
    check(
      "returns A's VMs for A",
      vmNames(aVms.body).join(",") === "vm-A-1,vm-A-2",
      `got ${JSON.stringify(vmNames(aVms.body))}`,
    );

    const missing = await api("GET", `/api/accounts/${"99999999-9999-4999-8999-999999999999"}/vms`, {
      cookie: racedCookie,
    });
    check("unknown account returns 404 from the account route", missing.status === 404, `status=${missing.status}`);

    // ---------------------------------------------------------------
    section("3. The cookie-scoped VM route is gone (defect surface removed)");

    const legacyVms = await api("GET", "/api/vms", { cookie: racedCookie });
    check("GET /api/vms returns 410 Gone", legacyVms.status === 410, `status=${legacyVms.status}`);
    check(
      "410 body names the replacement contract",
      String(legacyVms.body?.code ?? "") === "route_gone",
      `body=${JSON.stringify(legacyVms.body)}`,
    );
    for (const legacy of ["/api/vm-action", "/api/vm-change-ip", "/api/create-vm"]) {
      const res = await api("POST", legacy, { cookie: racedCookie, body: {} });
      check(`POST ${legacy} returns 410 Gone`, res.status === 410, `status=${res.status}`);
    }
    for (const legacy of ["/api/regions", "/api/vm-sizes", "/api/ip-permission", "/api/tasks"]) {
      const res = await api("GET", legacy, { cookie: racedCookie });
      check(`GET ${legacy} returns 410 Gone`, res.status === 410, `status=${res.status}`);
    }

    const appSource = [
      "public/app.js",
      "public/js/core.js",
      "public/js/overview.js",
      "public/js/accounts.js",
      "public/js/vms.js",
      "public/js/forms.js",
      "public/js/settings-auth.js",
    ].map((rel) => {
      try { return readFileSync(`${REPO_ROOT}/${rel}`, "utf8"); } catch { return ""; }
    }).join("\n");
    check(
      "client no longer calls the removed cookie-scoped routes",
      !/['"`]\/api\/vms['"`]/.test(appSource)
        && !/['"`]\/api\/vm-action['"`]/.test(appSource)
        && !/['"`]\/api\/vm-change-ip['"`]/.test(appSource)
        && !/['"`]\/api\/create-vm['"`]/.test(appSource)
        && !/['"`]\/api\/regions['"`]/.test(appSource)
        && !/['"`]\/api\/vm-sizes['"`]/.test(appSource)
        && !/['"`]\/api\/ip-permission['"`]/.test(appSource)
        && !/['"`]\/api\/tasks['"`]/.test(appSource),
      "found a reference to a removed route in public frontend sources",
    );

    // ---------------------------------------------------------------
    section("4. Responses must not be cacheable per-URL across accounts");

    for (const path of ["/api/accounts", `/api/accounts/${ACCOUNT_B_ID}/vms`, "/api/session"]) {
      const res = await api("GET", path, { cookie: racedCookie });
      const cc = String(res.headers.get("cache-control") ?? "").toLowerCase();
      const vary = String(res.headers.get("vary") ?? "").toLowerCase();
      check(`${path} sets Cache-Control: no-store`, cc.includes("no-store"), `cache-control="${cc}"`);
      check(`${path} sets Vary: Cookie`, vary.includes("cookie"), `vary="${vary}"`);
    }

    // ---------------------------------------------------------------
    section("5. Concurrent duplicate fetches are coalesced (single-flight)");

    await resetAll();
    const burst = await Promise.all([
      api("GET", `/api/accounts/${ACCOUNT_B_ID}/vms`, { cookie: racedCookie }),
      api("GET", `/api/accounts/${ACCOUNT_B_ID}/vms`, { cookie: racedCookie }),
      api("GET", `/api/accounts/${ACCOUNT_B_ID}/vms`, { cookie: racedCookie }),
    ]);
    check(
      "all 3 concurrent requests succeeded",
      burst.every((r) => r.status === 200),
      `statuses=${burst.map((r) => r.status).join(",")}`,
    );
    check(
      "all 3 returned B's VMs",
      burst.every((r) => vmNames(r.body).join(",") === "vm-B-1,vm-B-2"),
      `got ${JSON.stringify(burst.map((r) => vmNames(r.body)))}`,
    );
    const statsAfter = await readStats();
    check(
      "3 concurrent requests trigger exactly 1 upstream VM list call",
      statsAfter.vmList?.[SUB_B] === 1,
      `upstream vm list calls for B = ${statsAfter.vmList?.[SUB_B] ?? 0}`,
    );

    // ---------------------------------------------------------------
    section("6. AAD tokens are reused across requests");

    await resetAll();
    const ov1 = await api("GET", `/api/accounts/${ACCOUNT_A_ID}/overview`, { cookie: racedCookie });
    const ov2 = await api("GET", `/api/accounts/${ACCOUNT_A_ID}/overview`, { cookie: racedCookie });
    check(
      "overview requests succeeded",
      ov1.status === 200 && ov2.status === 200,
      `statuses=${ov1.status},${ov2.status}`,
    );
    const tokenStats = await readStats();
    check(
      "2 requests for the same account reuse one AAD token",
      tokenStats.token === 1,
      `token requests = ${tokenStats.token}`,
    );

    // ---------------------------------------------------------------
    section("7. Switch latency (upstream capped at 250ms per VM list)");

    await resetAll();
    const cold = await api("GET", `/api/accounts/${ACCOUNT_B_ID}/vms`, { cookie: racedCookie });
    const coldStats = await readStats();
    const warm = await api("GET", `/api/accounts/${ACCOUNT_B_ID}/vms`, { cookie: racedCookie });
    const warmStats = await readStats();
    check(
      "cold and warm switch both succeeded",
      cold.status === 200 && warm.status === 200,
      `statuses=${cold.status},${warm.status}`,
    );
    console.log(`  cold=${cold.ms}ms warm=${warm.ms}ms`);
    check("cold read hit upstream", (coldStats.vmList?.[SUB_B] ?? 0) === 1, `calls=${coldStats.vmList?.[SUB_B] ?? 0}`);
    check(
      "warm read is served from cache without touching upstream",
      (warmStats.vmList?.[SUB_B] ?? 0) === 1,
      `upstream calls after warm read = ${warmStats.vmList?.[SUB_B] ?? 0}`,
    );
    check("warm read is faster than cold", warm.ms < cold.ms, `cold=${cold.ms}ms warm=${warm.ms}ms`);
    check("cold read is not instantaneous (upstream really was called)", cold.ms >= 200, `cold=${cold.ms}ms`);

    // ---------------------------------------------------------------
    section("8. Write routes land on the account named in the path");

    await resetAll();
    // Point the session at B, then submit an action against A's path.
    const selectBAgain = await api("POST", "/api/session", { cookie: racedCookie, body: { accountId: ACCOUNT_B_ID } });
    const cookieB = sessionCookieValue(selectBAgain.setCookies, racedCookie)!;

    const actionA = await api("POST", `/api/accounts/${ACCOUNT_A_ID}/vm-action`, {
      cookie: cookieB,
      body: { action: "restart", resourceGroup: "rg-A", vmName: "vm-A-1" },
    });
    check("account-scoped vm-action returns 200", actionA.status === 200, `status=${actionA.status}`);
    check(
      "vm-action echoes the path account",
      actionA.body?.accountId === ACCOUNT_A_ID,
      `accountId=${actionA.body?.accountId}`,
    );
    const taskId = actionA.body?.taskId;
    check("vm-action returns a taskId", typeof taskId === "string" && taskId.length > 0);

    const tasksUnderB = await api("GET", `/api/accounts/${ACCOUNT_B_ID}/tasks`, { cookie: cookieB });
    const tasksB = Array.isArray(tasksUnderB.body?.items) ? tasksUnderB.body.items : [];
    check(
      "the task did NOT land on account B's task list",
      !tasksB.some((task: any) => task.id === taskId),
      `account=B tasks=${JSON.stringify(tasksB.map((t: any) => t.id))}`,
    );

    const selectAAgain = await api("POST", "/api/session", { cookie: cookieB, body: { accountId: ACCOUNT_A_ID } });
    const cookieA = sessionCookieValue(selectAAgain.setCookies, cookieB)!;
    const tasksUnderA = await api("GET", `/api/accounts/${ACCOUNT_A_ID}/tasks`, { cookie: cookieA });
    const tasksA = Array.isArray(tasksUnderA.body?.items) ? tasksUnderA.body.items : [];
    check(
      "the task DID land on the path account (A)",
      tasksA.some((task: any) => task.id === taskId),
      `account=A tasks=${JSON.stringify(tasksA.map((t: any) => t.id))}`,
    );
    check(
      "account-scoped tasks echo accountId",
      tasksUnderA.body?.accountId === ACCOUNT_A_ID,
      `accountId=${tasksUnderA.body?.accountId}`,
    );

    const badAction = await api("POST", `/api/accounts/${"99999999-9999-4999-8999-999999999999"}/vm-action`, {
      cookie: cookieA,
      body: { action: "delete", resourceGroup: "rg-x", vmName: "vm-x" },
    });
    check("vm-action for an unknown account returns 404", badAction.status === 404, `status=${badAction.status}`);
  } finally {
    mock.kill();
    server.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed checks:");
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
}

if (!existsSync(`${REPO_ROOT}/src/server.ts`)) {
  console.error(`cannot locate repo root (looked in ${REPO_ROOT})`);
  process.exit(1);
}

await main();
