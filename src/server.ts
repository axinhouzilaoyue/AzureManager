import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AppEnv } from "./types";
import { toBase64Url, errorResponse, jsonResponse } from "./lib/utils";
import { initializeDatabase, reapInterruptedTasks } from "./lib/db";
import { serveFile } from "./lib/http-helpers";
import { handleAuth } from "./routes/auth";
import { handleApi } from "./routes/api";

// ---- secrets ----
interface Secrets {
  sessionSecret: string;
  encryptionKey: string;
}

function loadOrCreateSecrets(): Secrets {
  const path = "data/.secret";
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as Secrets;
  }
  const secrets: Secrets = {
    sessionSecret: toBase64Url(crypto.getRandomValues(new Uint8Array(48))),
    encryptionKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
  writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  console.log("First run: generated secrets saved to data/.secret");
  return secrets;
}

// ---- env bootstrap ----
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) throw new Error("Missing required env var: APP_PASSWORD");

mkdirSync("data", { recursive: true });
const secrets = loadOrCreateSecrets();
const db = new Database("data/azure-manager.db");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
initializeDatabase(db);

const ENV: AppEnv = {
  APP_NAME: process.env.APP_NAME ?? "Azure VM Management Panel",
  APP_PASSWORD,
  SESSION_SECRET: secrets.sessionSecret,
  ACCOUNT_ENCRYPTION_KEY: secrets.encryptionKey,
  SESSION_TTL_SECONDS: parseInt(process.env.SESSION_TTL_SECONDS ?? "604800"),
  LOCK_TIMEOUT_SECONDS: parseInt(process.env.LOCK_TIMEOUT_SECONDS ?? "900"),
  AZURE_ARM_BASE_URL: process.env.AZURE_ARM_BASE_URL ?? "https://management.azure.com",
  AZURE_AUTH_BASE_URL: process.env.AZURE_AUTH_BASE_URL ?? "https://login.microsoftonline.com",
  DB: db,
};

{
  const reaped = reapInterruptedTasks(ENV);
  if (reaped > 0) {
    console.log(`Marked ${reaped} interrupted background task(s) as failed after restart`);
  }
}

function isSafePublicPath(pathname: string): boolean {
  if (pathname.includes("\\") || pathname.includes("\0")) return false;
  if (pathname.split("/").includes("..")) return false;
  return true;
}

// ---- server ----
const server = Bun.serve({
  port: parseInt(process.env.PORT ?? "8080"),

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // static files
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile("public/index.html", "text/html; charset=utf-8");
    }
    if (url.pathname === "/app.js") {
      return serveFile("public/app.js", "application/javascript");
    }
    if (url.pathname === "/app.css") {
      return serveFile("public/app.css", "text/css; charset=utf-8");
    }
    if (url.pathname.startsWith("/js/") && isSafePublicPath(url.pathname)) {
      const filePath = `public${url.pathname}`;
      if (existsSync(filePath) && (filePath.endsWith(".js") || filePath.endsWith(".css"))) {
        const type = filePath.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript";
        return serveFile(filePath, type);
      }
    }
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    try {
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, service: ENV.APP_NAME, timestamp: new Date().toISOString() });
      }
      if (url.pathname.startsWith("/auth/")) return handleAuth(ENV, req, url);
      if (url.pathname.startsWith("/api/")) return handleApi(ENV, req, url);
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Unhandled error", error);
      return errorResponse(500, "服务器内部错误", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

console.log(`Azure Manager running on http://localhost:${server.port}`);
