import type { AppEnv } from "../types";
import { createLogoutCookie, createLoginCookie, getAuthContext } from "../lib/auth";
import { loginSchema } from "../lib/validation";
import { errorResponse, jsonResponse } from "../lib/utils";
import { parseBody } from "../lib/http-helpers";

export async function handleAuth(env: AppEnv, req: Request, url: URL): Promise<Response> {
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await parseBody(req, loginSchema);
    if (body instanceof Response) return body;
    if (body.password !== env.APP_PASSWORD) return errorResponse(401, "密码错误");
    const existing = await getAuthContext(env, req);
    const cookie = await createLoginCookie(env, existing.session);
    return jsonResponse({ success: true }, { headers: { "Set-Cookie": cookie } });
  }
  if (req.method === "POST" && url.pathname === "/auth/logout") {
    return jsonResponse({ success: true }, { headers: { "Set-Cookie": createLogoutCookie() } });
  }
  return errorResponse(404, "接口不存在");
}
