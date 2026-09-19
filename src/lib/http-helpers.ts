import type { ZodType } from "zod";
import { errorResponse, readJson } from "./utils";

export const OVERVIEW_ACCOUNT_CONCURRENCY = parseInt(process.env.OVERVIEW_ACCOUNT_CONCURRENCY ?? "3");
export const BULK_REFRESH_CONCURRENCY = parseInt(process.env.BULK_REFRESH_CONCURRENCY ?? "3");

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T | Response> {
  const payload = await readJson<unknown>(req);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return errorResponse(400, parsed.error.issues[0]?.message ?? "请求参数无效");
  return parsed.data;
}

export function serveFile(path: string, contentType: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "content-type": contentType,
      // Avoid sticky cached UI/JS after deploys.
      "cache-control": "no-store, max-age=0",
    },
  });
}

export function formatAzureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("azure_auth_failed:")) return "Azure 认证失败，请检查客户端 ID、客户端密码和租户 ID 是否正确。";
  if (message.includes("SubscriptionNotFound")) return "订阅不存在，或当前服务主体无权访问该订阅。";
  if (message.includes("AuthorizationFailed")) return "凭据有效，但当前服务主体没有足够的订阅权限。";
  if (message.includes("account_not_found")) return "账户不存在。";
  return "Azure 检查失败，请确认订阅 ID、租户、服务主体权限以及当前目录是否正确。";
}

/** `AbortSignal.timeout` surfaces as a DOMException named TimeoutError. */
export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Small bounded-concurrency map so cross-account fan-out cannot saturate the egress. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
