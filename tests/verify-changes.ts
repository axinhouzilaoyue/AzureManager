/**
 * Post-change verification: boots mock Azure + server, checks new contracts.
 *   bun tests/verify-changes.ts
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { toBase64Url } from "../src/lib/utils";
import { createAccount, createTask, initializeDatabase } from "../src/lib/db";
import type { AppEnv } from "../src/types";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.tmp/verify-changes`;
const MOCK_PORT = 9101;
const APP_PORT = 8101;
const APP_PASSWORD = "verify-pass";
const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let passed = 0;
const fails: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    fails.push(label);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function api(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const setCookies = (res.headers as any).getSetCookie?.() ?? [];
  return { status: res.status, body, setCookies, headers: res.headers };
}

function cookieFrom(setCookies: string[], prev?: string): string {
  const raw = setCookies.find((c: string) => c.startsWith("azure_cf_session=")) || "";
  const m = raw.match(/^azure_cf_session=([^;]+)/);
  if (m) return `azure_cf_session=${m[1]}`;
  return prev || "";
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(`${TMP}/data`, { recursive: true });
// Server serves public/* relative to cwd; mirror the repo assets into the temp root.
symlinkSync(`${ROOT}/public`, `${TMP}/public`);
symlinkSync(`${ROOT}/src`, `${TMP}/src`);

const secrets = {
  sessionSecret: toBase64Url(crypto.getRandomValues(new Uint8Array(48))),
  encryptionKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
};
writeFileSync(`${TMP}/data/.secret`, JSON.stringify(secrets));

const db = new Database(`${TMP}/data/azure-manager.db`);
db.exec("PRAGMA foreign_keys = ON;");
initializeDatabase(db);
const env = {
  APP_NAME: "verify",
  APP_PASSWORD,
  SESSION_SECRET: secrets.sessionSecret,
  ACCOUNT_ENCRYPTION_KEY: secrets.encryptionKey,
  SESSION_TTL_SECONDS: 3600,
  LOCK_TIMEOUT_SECONDS: 60,
  AZURE_ARM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  AZURE_AUTH_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  DB: db,
} as AppEnv;

await createAccount(env, {
  id: ACC,
  name: "verify-acc",
  clientId: "client",
  clientSecret: "secret",
  tenantId: "tenant",
  subscriptionId: SUB,
  email: "a@b.c",
  expirationDate: "2099-01-01",
});
await createTask(env, {
  id: "dead-task-0000-0000-0000-000000000001",
  accountId: ACC,
  type: "vm.create",
  lockKey: SUB,
  createdBy: "test",
  message: "should be reaped",
});
db.prepare(`UPDATE tasks SET status='running' WHERE id=?`).run("dead-task-0000-0000-0000-000000000001");
db.close();

const mock = Bun.spawn(["bun", `${ROOT}/tests/mock-azure.ts`], {
  cwd: ROOT,
  env: { ...process.env, MOCK_AZURE_PORT: String(MOCK_PORT), MOCK_VM_DELAY_MS: "0" },
  stdout: "ignore",
  stderr: "ignore",
});

for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`);
    if (r.ok) break;
  } catch {
    // retry
  }
  await Bun.sleep(100);
}

const server = Bun.spawn(["bun", `${ROOT}/src/server.ts`], {
  cwd: TMP,
  env: {
    ...process.env,
    APP_PASSWORD,
    PORT: String(APP_PORT),
    AZURE_ARM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    AZURE_AUTH_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
      if (r.ok) break;
    } catch {
      // retry
    }
    await Bun.sleep(100);
  }

  console.log("\n1. Static assets");
  const css = await api("GET", "/app.css");
  check(
    "serves /app.css",
    css.status === 200 && String(css.headers.get("content-type") || "").includes("text/css"),
    `status=${css.status} ct=${css.headers.get("content-type")}`,
  );
  const coreJs = await api("GET", "/js/core.js");
  check("serves /js/core.js", coreJs.status === 200, `status=${coreJs.status}`);
  const htmlRes = await fetch(`http://127.0.0.1:${APP_PORT}/`);
  const htmlText = await htmlRes.text();
  check("index links app.css", htmlRes.status === 200 && htmlText.includes("/app.css") && !htmlText.includes("<style>"));
  check("index loads js modules", htmlText.includes("/js/core.js"));

  console.log("\n2. Auth + reaper");
  const login = await api("POST", "/auth/login", { body: { password: APP_PASSWORD } });
  check("login ok", login.status === 200);
  const cookie = cookieFrom(login.setCookies);
  check("got session cookie", cookie.includes("session="));

  const db2 = new Database(`${TMP}/data/azure-manager.db`);
  const taskRow = db2.prepare(`SELECT status, error_code FROM tasks WHERE id=?`).get(
    "dead-task-0000-0000-0000-000000000001",
  ) as { status: string; error_code: string | null } | null;
  check(
    "running task reaped on boot",
    taskRow?.status === "failure" && taskRow?.error_code === "interrupted_by_restart",
    JSON.stringify(taskRow),
  );
  db2.close();

  console.log("\n3. Account-scoped metadata routes");
  const regions = await api("GET", `/api/accounts/${ACC}/regions`, { cookie });
  check("regions 200", regions.status === 200, `status=${regions.status} body=${JSON.stringify(regions.body).slice(0, 200)}`);
  check("regions envelope accountId", regions.body?.accountId === ACC);
  check("regions items array", Array.isArray(regions.body?.items));

  const sizes = await api("GET", `/api/accounts/${ACC}/vm-sizes?location=eastus`, { cookie });
  check("vm-sizes 200", sizes.status === 200, `status=${sizes.status}`);
  check("vm-sizes envelope", sizes.body?.accountId === ACC && Array.isArray(sizes.body?.items));

  const ip = await api("GET", `/api/accounts/${ACC}/ip-permission?location=eastus`, { cookie });
  check("ip-permission 200", ip.status === 200, `status=${ip.status} body=${JSON.stringify(ip.body).slice(0, 200)}`);
  check("ip-permission accountId", ip.body?.accountId === ACC);
  const perm = ip.body?.items?.permission || ip.body?.permission;
  check("ip-permission has permission", typeof perm === "string" && perm.length > 0, String(perm));

  const tasks = await api("GET", `/api/accounts/${ACC}/tasks`, { cookie });
  check("tasks 200", tasks.status === 200);
  check("tasks envelope", tasks.body?.accountId === ACC && Array.isArray(tasks.body?.items));
  check(
    "reaped task visible in list",
    Array.isArray(tasks.body?.items)
      && tasks.body.items.some((t: any) => t.id === "dead-task-0000-0000-0000-000000000001" && t.status === "failure"),
  );

  const summary = await api("GET", `/api/accounts/${ACC}/summary`, { cookie });
  check("summary 200", summary.status === 200, `status=${summary.status} body=${JSON.stringify(summary.body).slice(0, 300)}`);
  check("summary accountId", summary.body?.accountId === ACC);
  check(
    "summary has quota/vmCount",
    Boolean(summary.body?.items && ("quotaTier" in summary.body.items) && ("vmCount" in summary.body.items)),
  );

  console.log("\n4. Legacy routes stay 410");
  for (const p of ["/api/regions", "/api/vm-sizes", "/api/ip-permission", "/api/tasks", "/api/vms"]) {
    const r = await api("GET", p, { cookie });
    check(`${p} -> 410`, r.status === 410 && r.body?.code === "route_gone");
  }

  console.log("\n5. Overview refresh flag accepted");
  const ov = await api("GET", "/api/overview/vms", { cookie });
  check("overview 200", ov.status === 200 && Array.isArray(ov.body?.items));
  const ov2 = await api("GET", "/api/overview/vms?refresh=1", { cookie });
  check("overview force 200", ov2.status === 200);

  console.log("\n6. Client/repo static contracts");
  const appJs = (
    await Promise.all([
      "public/app.js",
      "public/js/core.js",
      "public/js/overview.js",
      "public/js/accounts.js",
      "public/js/vms.js",
      "public/js/forms.js",
      "public/js/settings-auth.js",
    ].map(async (rel) => {
      try { return await Bun.file(`${ROOT}/${rel}`).text(); } catch { return ""; }
    }))
  ).join("\n");
  check("client uses account regions", appJs.includes("/regions"));
  check("client uses account vm-sizes", appJs.includes("/vm-sizes?"));
  check("client uses account ip-permission", appJs.includes("/ip-permission?"));
  check("client uses account tasks", appJs.includes("/tasks"));
  check("client uses summary", appJs.includes("/summary"));
  check("client has create prefs", appJs.includes("CREATE_VM_PREFS_KEY"));
  check("client has task strip", appJs.includes("renderTaskStrip"));
  check("no legacy bare /api/regions", !/['"`]\/api\/regions['"`]/.test(appJs));
  check("js core module exists", existsSync(`${ROOT}/public/js/core.js`));
  check("package-lock removed", !existsSync(`${ROOT}/package-lock.json`));
  check("preview moved", existsSync(`${ROOT}/docs/preview-accounts.html`));
  check("app.css exists", existsSync(`${ROOT}/public/app.css`));
} finally {
  server.kill();
  mock.kill();
}

console.log(`\n${passed} passed, ${fails.length} failed`);
if (fails.length) {
  for (const item of fails) console.log(`  - ${item}`);
  process.exit(1);
}
