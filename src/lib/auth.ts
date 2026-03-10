import type { AppEnv, AuthContext, SessionState } from "../types";
import { signValue, verifySignedValue } from "./crypto";
import { clearCookie, createCookie, errorResponse, getCookie } from "./utils";

const SESSION_COOKIE = "azure_cf_session";

function getSessionTtlSeconds(env: AppEnv): number {
  return Number(env.SESSION_TTL_SECONDS || 604800);
}

function getAccessEmail(request: Request): string | null {
  return request.headers.get("CF-Access-Authenticated-User-Email");
}

function defaultSession(): SessionState {
  return {
    v: 1,
    selectedAccountId: null,
    localAuthExp: null,
  };
}

async function decodeSession(env: AppEnv, request: Request): Promise<SessionState> {
  const cookieValue = getCookie(request, SESSION_COOKIE);
  if (!cookieValue) {
    return defaultSession();
  }

  const [payload, signature] = cookieValue.split(".");
  if (!payload || !signature) {
    return defaultSession();
  }

  const verified = await verifySignedValue(env.SESSION_SECRET, payload, signature);
  if (!verified) {
    return defaultSession();
  }

  try {
    const parsed = JSON.parse(atob(payload)) as SessionState;
    if (parsed.v !== 1) {
      return defaultSession();
    }
    return {
      v: 1,
      selectedAccountId: parsed.selectedAccountId ?? null,
      localAuthExp: parsed.localAuthExp ?? null,
    };
  } catch {
    return defaultSession();
  }
}

async function encodeSession(env: AppEnv, state: SessionState): Promise<string> {
  const payload = btoa(JSON.stringify(state));
  const signature = await signValue(env.SESSION_SECRET, payload);
  return `${payload}.${signature}`;
}

export async function getAuthContext(env: AppEnv, request: Request): Promise<AuthContext> {
  const accessEmail = getAccessEmail(request);
  const session = await decodeSession(env, request);
  const localAuthenticated = session.localAuthExp !== null && session.localAuthExp > Date.now();

  if (accessEmail) {
    return {
      authenticated: true,
      actor: accessEmail,
      authMode: "access",
      session,
    };
  }

  if (localAuthenticated) {
    return {
      authenticated: true,
      actor: "local-admin",
      authMode: "local",
      session,
    };
  }

  return {
    authenticated: false,
    actor: "anonymous",
    authMode: "local",
    session,
  };
}

export async function requireAuth(env: AppEnv, request: Request): Promise<AuthContext | Response> {
  const auth = await getAuthContext(env, request);
  if (!auth.authenticated) {
    return errorResponse(401, "用户未登录");
  }
  return auth;
}

export async function createLoginCookie(env: AppEnv, existing: SessionState): Promise<string> {
  const nextState: SessionState = {
    ...existing,
    v: 1,
    localAuthExp: Date.now() + getSessionTtlSeconds(env) * 1000,
  };
  const encoded = await encodeSession(env, nextState);
  return createCookie(SESSION_COOKIE, encoded, {
    maxAge: getSessionTtlSeconds(env),
  });
}

export async function createSelectionCookie(
  env: AppEnv,
  request: Request,
  selectedAccountId: string | null,
): Promise<string> {
  const existing = await decodeSession(env, request);
  const nextState: SessionState = {
    ...existing,
    v: 1,
    selectedAccountId,
  };
  const encoded = await encodeSession(env, nextState);
  return createCookie(SESSION_COOKIE, encoded, {
    maxAge: existing.localAuthExp && existing.localAuthExp > Date.now() ? getSessionTtlSeconds(env) : getSessionTtlSeconds(env),
  });
}

export function createLogoutCookie(): string {
  return clearCookie(SESSION_COOKIE);
}
