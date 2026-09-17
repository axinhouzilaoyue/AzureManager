import type { JsonRecord } from "../types";

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  // Every /api/** route sits behind cookie auth, and responses are scoped to the
  // requested account. Without these headers a browser or proxy may replay one
  // account's payload for another account's request to the same account-free URL.
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  if (!headers.has("vary")) {
    headers.set("vary", "Cookie");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

/**
 * Envelope for account-scoped responses: `accountId` is echoed from the request
 * path (never from the session cookie), so a client can verify that a payload
 * really belongs to the account it asked for. `extra` carries freshness metadata
 * (cached/stale/warning) in the body, because clients that only parse JSON would
 * otherwise miss it.
 */
export function accountJson(
  accountId: string,
  items: unknown,
  init: ResponseInit = {},
  extra: JsonRecord = {},
): Response {
  return jsonResponse(
    { accountId, fetchedAt: new Date().toISOString(), items, ...extra },
    init,
  );
}

export function errorResponse(status: number, error: string, extra: JsonRecord = {}): Response {
  return jsonResponse(
    {
      error,
      ...extra,
    },
    { status },
  );
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName === name) {
      return rest.join("=");
    }
  }

  return null;
}

export function createCookie(name: string, value: string, options: {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
} = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/"}`);

  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly ?? true) {
    parts.push("HttpOnly");
  }

  if (options.secure ?? false) {
    parts.push("Secure");
  }

  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function clearCookie(name: string, options: {
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
} = {}): string {
  // Keep attributes aligned with createCookie so logout clears the session on HTTP too.
  return createCookie(name, "", {
    maxAge: 0,
    httpOnly: true,
    secure: options.secure ?? false,
    sameSite: options.sameSite ?? "Lax",
    path: options.path ?? "/",
  });
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function parseJsonOrNull<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as T;
}

export async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
