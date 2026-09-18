// End-to-end browser test for the account-switch bug.
//
//   bun tests/switch-ui.ts
//
// Reproduces the reported symptom in a real browser: the user clicks account B
// while account A's session write is still in flight. Before the fix the VM
// table kept showing A's machines (and stayed wrong); after it, the table must
// only ever show the selected account's VMs.
//
// Uses the mock AAD/ARM from tests/mock-azure.ts and the locally installed
// Chrome via puppeteer-core, so no Azure credentials and no network are needed.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { toBase64Url } from "../src/lib/utils";
import { createAccount, initializeDatabase } from "../src/lib/db";
import type { AppEnv } from "../src/types";

// puppeteer-core is optional tooling: it is intentionally NOT a package.json
// dependency, because the Docker build runs `bun install --frozen-lockfile` and
// an undeclared entry would break it. When it is unavailable the test skips.
type PuppeteerModule = { launch: (options: Record<string, unknown>) => Promise<any> };
let puppeteer: PuppeteerModule | null = null;
try {
  puppeteer = ((await import("puppeteer-core")) as unknown as { default: PuppeteerModule }).default;
} catch {
  puppeteer = null;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP_DIR = `${REPO_ROOT}/.tmp/switch-ui`;
const MOCK_PORT = 9199;
const APP_PORT = 8199;
const APP_PASSWORD = "test-password";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ACCOUNT_A_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B_ID = "22222222-2222-4222-8222-222222222222";
const SUB_A = "00000000-0000-4000-8000-00000000000a";
const SUB_B = "00000000-0000-4000-8000-00000000000b";

const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

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

async function waitFor(url: string, attempts = 120): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`service never became ready: ${url}`);
}

/** Reads the visible VM rows from the table. */
const readRows = (page: any) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#vm-tbody .vm-name")].map((el: any) => el.textContent.trim()),
  );

const readTableText = (page: any) =>
  page.evaluate(() => document.getElementById("vm-tbody")?.textContent ?? "");

async function main(): Promise<void> {
  if (!puppeteer) {
    console.log("\x1b[33mSKIP\x1b[0m puppeteer-core is not installed; cannot run the browser test.");
    console.log("     Install it locally with: bun add -d puppeteer-core");
    return;
  }
  if (!existsSync(CHROME)) {
    console.log(`\x1b[33mSKIP\x1b[0m Chrome not found at ${CHROME}; cannot run the browser test.`);
    return;
  }

  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(`${TMP_DIR}/data`, { recursive: true });
  // The server serves public/ relative to its cwd, so expose the real assets.
  symlinkSync(`${REPO_ROOT}/public`, `${TMP_DIR}/public`, "dir");

  const secrets = {
    sessionSecret: toBase64Url(crypto.getRandomValues(new Uint8Array(48))),
    encryptionKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
  writeFileSync(`${TMP_DIR}/data/.secret`, JSON.stringify(secrets));

  const db = new Database(`${TMP_DIR}/data/azure-manager.db`);
  db.exec("PRAGMA journal_mode = WAL;");
  initializeDatabase(db);
  const seedEnv = { ACCOUNT_ENCRYPTION_KEY: secrets.encryptionKey, DB: db } as unknown as AppEnv;
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
  // Seed a persisted cost warning on account A. It used to render as a banner on
  // every page load; it must now be treated as a transient event, not a property
  // of the account.
  db.prepare(`UPDATE accounts SET cost_warning = ? WHERE id = ?`).run(
    "累计消费：Cost Management 请求参数不受当前订阅支持；累计消费刷新失败，已沿用上一次成功结果",
    ACCOUNT_A_ID,
  );
  db.close();

  const mock = Bun.spawn(["bun", `${REPO_ROOT}/tests/mock-azure.ts`], {
    env: { ...process.env, MOCK_AZURE_PORT: String(MOCK_PORT), MOCK_VM_DELAY_MS: "600" },
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

  let browser: any = null;
  try {
    await waitFor(`${MOCK}/__stats`);
    await waitFor(`${APP}/health`);
    const rootRes = await fetch(APP);
    if (!rootRes.ok) throw new Error(`GET / returned ${rootRes.status}; static assets are not being served`);

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const seenUrls: string[] = [];
    page.on("pageerror", (err: Error) => consoleErrors.push(String(err)));
    page.on("request", (req: any) => seenUrls.push(String(req.url())));
    page.on("console", (msg: any) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#login-btn", { timeout: 15000 });

    section("0. Login and account list");

    await page.evaluate((password: string) => {
      const input = document.getElementById("login-pw") as HTMLInputElement | null;
      if (input) input.value = password;
    }, APP_PASSWORD);
    await page.click("#login-btn");
    // The accounts workspace is a separate page; navigate to it like a user would.
    await page.waitForSelector("#ni-accounts", { timeout: 15000 });
    await page.click("#ni-accounts");
    await page.waitForSelector(".acc-card", { timeout: 15000 });
    const cardCount = await page.$$eval(".acc-card", (els: any[]) => els.length);
    check("both accounts are listed", cardCount === 2, `cardCount=${cardCount}`);

    // The row is deliberately minimal: account email plus remaining days only.
    // The VM count ("VPS:n 台") used to sit here and must not come back.
    const rowText = await page.evaluate(() => {
      const card = document.querySelector(".acc-card");
      return {
        name: card?.querySelector(".acc-name")?.textContent?.trim() ?? "",
        meta: card?.querySelector(".acc-meta")?.textContent?.trim() ?? "",
      };
    });
    check("an account row keeps its identity line", rowText.name.length > 0, JSON.stringify(rowText));
    check(
      "an account row no longer shows a VM count",
      !/VPS/i.test(rowText.meta) && !/台/.test(rowText.meta),
      JSON.stringify(rowText),
    );

    const clickAccount = async (accountId: string) => {
      await page.evaluate((id: string) => {
        const card = document.querySelector(`.acc-card[data-account-id="${id}"]`) as HTMLElement | null;
        card?.click();
      }, accountId);
    };

    section("1. Selecting an account shows that account's VMs");

    await clickAccount(ACCOUNT_A_ID);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-A-1")),
      { timeout: 20000 },
    );
    check("account A shows A's VMs", (await readRows(page)).join(",") === "vm-A-1,vm-A-2",
      `rows=${JSON.stringify(await readRows(page))}`);

    await clickAccount(ACCOUNT_B_ID);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-B-1")),
      { timeout: 20000 },
    );
    check("account B shows B's VMs", (await readRows(page)).join(",") === "vm-B-1,vm-B-2",
      `rows=${JSON.stringify(await readRows(page))}`);
    check("no A rows remain after switching to B", !(await readTableText(page)).includes("vm-A-"),
      `table=${(await readTableText(page)).slice(0, 200)}`);

    section("2. The reported symptom: A's session write lands after B's");

    // Reproduce the production race in the browser: account A's POST /api/session
    // is delayed so it lands AFTER B's, poisoning the session cookie while the
    // user is looking at B.
    await page.evaluate(() => {
      (window as any).__origFetch = window.fetch;
      window.fetch = async (input: any, init: any = {}) => {
        const url = typeof input === "string" ? input : input?.url ?? "";
        const method = String(init?.method || "GET").toUpperCase();
        if (url === "/api/session" && method === "POST") {
          let wanted: string | null = null;
          try { wanted = JSON.parse(init.body)?.accountId ?? null; } catch { /* ignore */ }
          // Delay ONLY account A's selection write.
          if (wanted === "11111111-1111-4111-8111-111111111111") {
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        return (window as any).__origFetch(input, init);
      };
    });

    // Going back to A warms A's UI, then the click sequence A -> B races.
    await clickAccount(ACCOUNT_B_ID);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-B-1")),
      { timeout: 20000 },
    );

    await clickAccount(ACCOUNT_A_ID); // its session write will land late
    await Bun.sleep(120);
    await clickAccount(ACCOUNT_B_ID); // the user is now looking at B

    // Wait out the delayed write and any in-flight fetches.
    await Bun.sleep(2500);
    const waitForB = async (): Promise<string[]> => {
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-B-1")),
          { timeout: 20000 },
        );
      } catch {
        /* fall through and report what was actually on screen */
      }
      return readRows(page);
    };

    const rowsAfterRace = await waitForB();
    check(
      "after the race, the table still shows B's VMs (the reported bug)",
      rowsAfterRace.join(",") === "vm-B-1,vm-B-2",
      `rows on screen = ${JSON.stringify(rowsAfterRace)}`,
    );
    check(
      "no A rows leaked in after the race",
      !(await readTableText(page)).includes("vm-A-"),
      `table=${(await readTableText(page)).slice(0, 200)}`,
    );

    // The server session really was clobbered back to A — proving we exercised
    // the race rather than a lucky ordering.
    const sessionAfterRace = await page.evaluate(async () => {
      const res = await (window as any).__origFetch("/api/session");
      return res.json();
    });
    check(
      "the session cookie was in fact clobbered back to A",
      sessionAfterRace?.selectedAccountId === ACCOUNT_A_ID,
      `selectedAccountId=${sessionAfterRace?.selectedAccountId}`,
    );

    // And yet a data request for B still returns B.
    const bPayload = await page.evaluate(async (id: string) => {
      const res = await (window as any).__origFetch(`/api/accounts/${id}/vms`);
      return res.json();
    }, ACCOUNT_B_ID);
    check(
      "a B request still returns B's VMs despite the clobbered cookie",
      bPayload?.accountId === ACCOUNT_B_ID
        && (bPayload?.items ?? []).every((vm: any) => String(vm.name).startsWith("vm-B-")),
      `payload account=${bPayload?.accountId} names=${JSON.stringify((bPayload?.items ?? []).map((v: any) => v.name))}`,
    );

    section("3. Switching back is served from cache");

    await page.evaluate(() => { window.fetch = (window as any).__origFetch; });
    const started = Date.now();
    await clickAccount(ACCOUNT_A_ID);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-A-1")),
      { timeout: 20000 },
    );
    const switchMs = Date.now() - started;
    console.log(`  switch back to A: ${switchMs}ms`);
    check("switching back to a cached account is fast (<600ms)", switchMs < 600, `took ${switchMs}ms`);
    check("no B rows leaked while switching back to A", !(await readTableText(page)).includes("vm-B-"),
      `table=${(await readTableText(page)).slice(0, 200)}`);

    section("4. No client-side exceptions");

    check("no page errors or console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join("\n       "));

    section("5. Persisted cost warnings must not stick");

    await clickAccount(ACCOUNT_A_ID);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-A-1")),
      { timeout: 20000 },
    );
    // Give the cost load time to resolve and (incorrectly) paint a banner.
    await Bun.sleep(1500);
    const bannerText = await page.evaluate(
      () => document.querySelector("#account-insights .insight-warning")?.textContent?.trim() ?? "",
    );
    check(
      "the persisted costWarning is NOT rendered as a permanent banner",
      bannerText === "",
      `banner=${JSON.stringify(bannerText)}`,
    );

    // The transient notice mechanism itself must still work, then auto-expire.
    // The selected account id comes from the DOM rather than app internals.
    const selectedViaDom = await page.evaluate(
      () => document.querySelector(".acc-card.selected")?.getAttribute("data-account-id") ?? null,
    );
    check("an account is marked selected in the pane", Boolean(selectedViaDom));
    await page.evaluate((id: string | null) => {
      (window as any).showInsightNotice?.(id, "临时提示：消费刷新失败", 700);
    }, selectedViaDom);
    const noticeShown = await page.evaluate(
      () => document.querySelector("#account-insights .insight-warning")?.textContent?.trim() ?? "",
    );
    check("a fresh notice is displayed", noticeShown.includes("临时提示"), `notice=${JSON.stringify(noticeShown)}`);
    await Bun.sleep(1400);
    const noticeGone = await page.evaluate(
      () => document.querySelector("#account-insights .insight-warning")?.textContent?.trim() ?? "",
    );
    check("the notice auto-dismisses", noticeGone === "", `notice=${JSON.stringify(noticeGone)}`);

    section("6. Insight-bar refresh and full account editing");

    const quotaBtn = await page.evaluate(() => {
      const bar = document.querySelector("#account-insights .insight-bar");
      if (!bar) return null;
      const button = bar.querySelector("#btn-refresh-summary");
      if (!button) return null;
      const children = [...bar.children];
      return {
        isLast: children[children.length - 1] === button,
        hasText: (button.textContent ?? "").trim().length > 0,
        hasSvg: Boolean(button.querySelector("svg")),
        title: button.getAttribute("title") ?? "",
        ariaLabel: button.getAttribute("aria-label") ?? "",
      };
    });
    check("insight refresh button exists in the bar", quotaBtn !== null);
    check("it is the last element of the bar", quotaBtn?.isLast === true, JSON.stringify(quotaBtn));
    check("it is icon-only (no text)", quotaBtn?.hasText === false, JSON.stringify(quotaBtn));
    check("it renders an icon", quotaBtn?.hasSvg === true, JSON.stringify(quotaBtn));
    check("it is labelled for accessibility", (quotaBtn?.title ?? "").length > 0 && (quotaBtn?.ariaLabel ?? "").length > 0,
      JSON.stringify(quotaBtn));
    check(
      "its label says it refreshes quota and cost",
      /配额/.test(quotaBtn?.ariaLabel ?? "") && /消费/.test(quotaBtn?.ariaLabel ?? ""),
      `aria-label=${quotaBtn?.ariaLabel}`,
    );

    // The button must refresh BOTH the quota tier and the cost figures.
    seenUrls.length = 0;
    await page.click("#btn-refresh-summary");
    await Bun.sleep(1500);
    const hitCost = seenUrls.some((url) => /\/api\/accounts\/[^/]+\/cost/.test(url));
    const hitQuota = seenUrls.some((url) => /\/api\/accounts\/[^/]+\/quota/.test(url));
    check("clicking it requests the cost endpoint", hitCost, seenUrls.join("\n       "));
    check("clicking it requests the quota endpoint", hitQuota, seenUrls.join("\n       "));

    const costCell = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("#account-insights .ib")];
      const pick = (label: string) =>
        cells.find((c) => c.querySelector("i")?.textContent === label)?.querySelector("b")?.textContent ?? "";
      return {
        labels: cells.map((c) => c.querySelector("i")?.textContent ?? ""),
        mtd: pick("本月"),
        acc: pick("累计"),
        history: pick("历史"),
        updated: pick("消费更新"),
      };
    });
    console.log(`  cost cells after refresh: ${JSON.stringify(costCell)}`);
    check("month-to-date has a value after refresh", costCell.mtd.length > 0 && costCell.mtd !== "查询中…",
      JSON.stringify(costCell));
    check("accumulated spend has a value after refresh",
      costCell.acc !== "查询中…" && costCell.acc !== "未获取",
      JSON.stringify(costCell));
    check(
      "the redundant 历史 cell is gone (quota + month + accumulated + timestamp only)",
      costCell.labels.join(",") === "AI 配额,本月,累计,消费更新",
      JSON.stringify(costCell.labels),
    );
    check("the cost timestamp is a real timestamp (not a loading placeholder)",
      /\d/.test(costCell.updated) && costCell.updated !== "查询中…" && costCell.updated !== "尚未查询",
      JSON.stringify(costCell));

    // The edit dialog must expose every field that creation collects.
    await page.evaluate((id: string | null) => (window as any).openEditAccount(id), selectedViaDom);
    await page.waitForSelector("#mo-edit-acc:not(.hidden)", { timeout: 10000 });
    const editFields = await page.evaluate(() => ({
      email: (document.getElementById("edit-acc-email") as HTMLInputElement)?.value ?? "",
      exp: (document.getElementById("edit-acc-exp") as HTMLInputElement)?.value ?? "",
      cid: (document.getElementById("edit-acc-cid") as HTMLInputElement)?.value ?? "",
      tid: (document.getElementById("edit-acc-tid") as HTMLInputElement)?.value ?? "",
      sid: (document.getElementById("edit-acc-sid") as HTMLInputElement)?.value ?? "",
      hasSecret: Boolean(document.getElementById("edit-acc-sec")),
      secretValue: (document.getElementById("edit-acc-sec") as HTMLInputElement)?.value ?? "",
    }));
    console.log(`  edit fields: ${JSON.stringify(editFields)}`);
    check("edit dialog exposes clientId", editFields.cid.length > 0, JSON.stringify(editFields));
    check("edit dialog exposes tenantId", editFields.tid.length > 0, JSON.stringify(editFields));
    check("edit dialog exposes subscriptionId", editFields.sid.length > 0, JSON.stringify(editFields));
    check("edit dialog exposes a client secret field", editFields.hasSecret);
    check("the stored secret is never pre-filled into the browser", editFields.secretValue === "");

    // Saving a new subscription id must persist and clear the cached Azure data.
    // (The seeded account has no email/expiry, so supply them: both are required.)
    await page.evaluate(() => {
      (document.getElementById("edit-acc-email") as HTMLInputElement).value = "a@example.com";
      (document.getElementById("edit-acc-exp") as HTMLInputElement).value = "2027-01-31";
      (document.getElementById("edit-acc-sid") as HTMLInputElement).value = "00000000-0000-4000-8000-00000000000c";
    });
    await page.click("#btn-save-edit-acc");
    await page.waitForSelector("#mo-edit-acc.hidden", { timeout: 10000 });
    const savedSid = await page.evaluate(async (id: string) => {
      const res = await fetch(`/api/accounts/${id}/detail`);
      return (await res.json())?.subscriptionId ?? "";
    }, ACCOUNT_A_ID);
    check(
      "editing the subscription id persists",
      savedSid === "00000000-0000-4000-8000-00000000000c",
      `subscriptionId=${savedSid}`,
    );

    section("7. Refresh-everything-for-all-accounts");

    const allBtn = await page.evaluate(() => {
      const button = document.getElementById("btn-refresh-all-accounts");
      if (!button) return null;
      return {
        inPaneHead: Boolean(button.closest(".account-pane-head")),
        hasSvg: Boolean(button.querySelector("svg")),
        hasText: (button.textContent ?? "").trim().length > 0,
        label: button.getAttribute("aria-label") ?? "",
        title: button.getAttribute("title") ?? "",
      };
    });
    check("a refresh-all-accounts button exists", allBtn !== null);
    check("it sits in the account pane header", allBtn?.inPaneHead === true, JSON.stringify(allBtn));
    check("it is icon-only and labelled", allBtn?.hasSvg === true && allBtn?.hasText === false
      && (allBtn?.label ?? "").length > 0, JSON.stringify(allBtn));

    seenUrls.length = 0;
    await page.click("#btn-refresh-all-accounts");
    // Two accounts, bounded concurrency, mocked upstream: a few seconds at most.
    await page.waitForFunction(
      () => !(document.getElementById("btn-refresh-all-accounts") as HTMLButtonElement | null)?.disabled,
      { timeout: 60000 },
    );
    check(
      "clicking it calls the bulk refresh endpoint",
      seenUrls.some((url) => url.includes("/api/accounts/refresh-all")),
      seenUrls.join("\n       "),
    );
    const bulkToast = await page.evaluate(() =>
      [...document.querySelectorAll("#tc .toast")].map((el) => el.textContent ?? "").join(" | "),
    );
    console.log(`  bulk refresh toasts: ${bulkToast}`);
    check(
      "the result is reported back to the user",
      /账户/.test(bulkToast) || /刷新/.test(bulkToast),
      `toasts=${bulkToast}`,
    );
    const cardsAfterBulk = await page.$$eval(".acc-card", (els: any[]) => els.length);
    check("the account list still renders after a bulk refresh", cardsAfterBulk === 2, `cards=${cardsAfterBulk}`);

    section("8. The create-VM region picker reports what it resolved");

    // The mock ARM has no locations, so this exercises the failure path: the
    // dialog used to sit on "加载中..." forever and silently submit an empty
    // region. It must now say so instead.
    await clickAccount(ACCOUNT_B_ID);
    await page.click("#btn-create-vm");
    await page.waitForSelector("#mo-create-vm:not(.hidden)", { timeout: 10000 });
    await page.waitForFunction(
      () => !/正在读取/.test(document.getElementById("create-region-hint")?.textContent ?? ""),
      { timeout: 20000 },
    );
    const regionState = await page.evaluate(() => {
      const select = document.getElementById("create-region") as HTMLSelectElement | null;
      return {
        hint: document.getElementById("create-region-hint")?.textContent ?? "",
        options: [...(select?.options ?? [])].map((option) => option.textContent ?? ""),
      };
    });
    console.log(`  create-vm region state: ${JSON.stringify(regionState)}`);
    check(
      "the region picker does not stay stuck on a loading placeholder",
      !regionState.options.some((text) => text.includes("加载中")),
      JSON.stringify(regionState.options),
    );
    check(
      "an unusable region list is explained to the user",
      /没有可用的区域|无可创建|加载失败|未获取到可用区域/.test(`${regionState.hint} ${regionState.options.join(" ")}`),
      JSON.stringify(regionState),
    );
    check(
      "the explanation names the subscription/Policy limits it honours",
      /Policy|策略|订阅/.test(regionState.hint),
      JSON.stringify(regionState.hint),
    );
    // Toasts stack over the top-right corner where the modal's close button sits,
    // so wait for the previous section's toasts to expire before clicking it.
    await page.waitForFunction(
      () => document.querySelectorAll("#tc .toast").length === 0,
      { timeout: 10000 },
    );
    await page.click("#mo-create-vm .md-x");
    await page.waitForSelector("#mo-create-vm.hidden", { timeout: 10000 });

    section("9. Layout screenshots for manual review");

    await clickAccount(ACCOUNT_B_ID);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#vm-tbody .vm-name")].some((el: any) => el.textContent.includes("vm-B-1")),
      { timeout: 20000 },
    );
    for (const [label, width, height] of [["desktop", 1440, 900], ["narrow", 800, 700]] as const) {
      await page.setViewport({ width, height });
      await Bun.sleep(400);
      const shotPath = `${REPO_ROOT}/.tmp/accounts-layout-${label}.png`;
      await page.screenshot({ path: shotPath, fullPage: true });
      console.log(`  screenshot (${label} ${width}px): ${shotPath}`);
    }
  } finally {
    if (browser) await browser.close();
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

await main();
