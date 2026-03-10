import type { AppEnv, DecryptedAccountRecord } from "../../types";
import { delay } from "../utils";
import { getAzureAccessToken } from "./auth";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface LongRunningOperation {
  completed: boolean;
  monitorUrl: string | null;
  monitorMode: "azure-async" | "location" | null;
  retryAfterMs: number;
  initialStatusCode: number;
}

export class AzureArmClient {
  private readonly env: AppEnv;
  private readonly account: DecryptedAccountRecord;
  private tokenPromise: Promise<string> | null = null;

  constructor(env: AppEnv, account: DecryptedAccountRecord) {
    this.env = env;
    this.account = account;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = getAzureAccessToken(this.env, this.account);
    }

    return this.tokenPromise;
  }

  private async authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return fetch(input, {
      ...init,
      headers,
    });
  }

  private createUrl(pathOrUrl: string, apiVersion?: string): string {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl, this.env.AZURE_ARM_BASE_URL);

    if (apiVersion && !url.searchParams.has("api-version")) {
      url.searchParams.set("api-version", apiVersion);
    }

    return url.toString();
  }

  async request<T>(
    method: HttpMethod,
    pathOrUrl: string,
    options: {
      apiVersion?: string;
      body?: unknown;
      expectedStatus?: number | number[];
    } = {},
  ): Promise<T> {
    const response = await this.authorizedFetch(this.createUrl(pathOrUrl, options.apiVersion), {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    this.assertExpectedStatus(response, options.expectedStatus);

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }

    return (await response.text()) as T;
  }

  async requestRaw(
    method: HttpMethod,
    pathOrUrl: string,
    options: {
      apiVersion?: string;
      body?: unknown;
    } = {},
  ): Promise<Response> {
    const response = await this.authorizedFetch(this.createUrl(pathOrUrl, options.apiVersion), {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.ok || [200, 201, 202, 204].includes(response.status)) {
      return response;
    }

    const errorText = await response.text();
    throw new Error(`azure_arm_request_failed:${response.status}:${errorText}`);
  }

  async paginate<T>(path: string, apiVersion: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = this.createUrl(path, apiVersion);

    while (nextUrl) {
      const page: { value?: T[]; nextLink?: string } = await this.request("GET", nextUrl);
      results.push(...(page.value ?? []));
      nextUrl = page.nextLink ?? null;
    }

    return results;
  }

  async startLongRunningOperation(
    method: HttpMethod,
    pathOrUrl: string,
    options: {
      apiVersion?: string;
      body?: unknown;
    } = {},
  ): Promise<LongRunningOperation> {
    const response = await this.requestRaw(method, pathOrUrl, options);
    return this.toLongRunningOperation(response);
  }

  async pollLongRunningOperation(operation: LongRunningOperation): Promise<void> {
    if (operation.completed || !operation.monitorUrl || !operation.monitorMode) {
      return;
    }

    let retryDelay = operation.retryAfterMs;
    let iteration = 0;

    while (true) {
      iteration += 1;
      if (iteration > 240) {
        throw new Error("azure_operation_timeout");
      }

      await delay(retryDelay);
      const response = await this.authorizedFetch(operation.monitorUrl, {
        method: "GET",
      });

      if (operation.monitorMode === "azure-async") {
        const payload = (await response.json()) as {
          status?: string;
          error?: {
            code?: string;
            message?: string;
          };
        };

        const normalized = payload.status?.toLowerCase();
        if (normalized === "succeeded") {
          return;
        }

        if (normalized === "failed" || normalized === "canceled") {
          throw new Error(
            `azure_operation_failed:${payload.error?.code ?? normalized}:${payload.error?.message ?? "unknown"}`,
          );
        }
      } else {
        if (response.status !== 202) {
          if (!response.ok && response.status !== 204) {
            const errorText = await response.text();
            throw new Error(`azure_operation_failed:${response.status}:${errorText}`);
          }
          return;
        }
      }

      retryDelay = parseRetryAfterMs(response.headers.get("Retry-After")) ?? retryDelay;
    }
  }

  async executeLongRunningOperation(
    method: HttpMethod,
    pathOrUrl: string,
    options: {
      apiVersion?: string;
      body?: unknown;
    } = {},
  ): Promise<void> {
    const operation = await this.startLongRunningOperation(method, pathOrUrl, options);
    await this.pollLongRunningOperation(operation);
  }

  private assertExpectedStatus(response: Response, expectedStatus?: number | number[]): void {
    if (!expectedStatus) {
      if (response.ok) {
        return;
      }
      throw new Error(`azure_arm_request_failed:${response.status}`);
    }

    const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!expected.includes(response.status)) {
      throw new Error(`unexpected_status:${response.status}`);
    }
  }

  private toLongRunningOperation(response: Response): LongRunningOperation {
    const asyncUrl = response.headers.get("Azure-AsyncOperation");
    const locationUrl = response.headers.get("Location");
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After")) ?? 5000;

    if (asyncUrl) {
      return {
        completed: false,
        monitorUrl: asyncUrl,
        monitorMode: "azure-async",
        retryAfterMs,
        initialStatusCode: response.status,
      };
    }

    if (locationUrl && response.status === 202) {
      return {
        completed: false,
        monitorUrl: locationUrl,
        monitorMode: "location",
        retryAfterMs,
        initialStatusCode: response.status,
      };
    }

    return {
      completed: true,
      monitorUrl: null,
      monitorMode: null,
      retryAfterMs,
      initialStatusCode: response.status,
    };
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return seconds * 1000;
}
