import type { AppEnv, DecryptedAccountRecord } from "../../types";

export interface AzureAccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

const TOKEN_REQUEST_TIMEOUT_MS = Number(process.env.AZURE_TOKEN_TIMEOUT_MS ?? 10_000);

/**
 * Raw AAD client-credentials call. Callers should go through
 * `getCachedAzureAccessToken` (token-cache.ts) so the token is reused across
 * requests instead of being fetched once per HTTP request.
 */
export async function requestAzureAccessToken(
  env: AppEnv,
  account: DecryptedAccountRecord,
): Promise<AzureAccessToken> {
  const tokenEndpoint = `${env.AZURE_AUTH_BASE_URL}/${account.tenantId}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: account.clientId,
    client_secret: account.clientSecret,
    scope: "https://management.azure.com/.default",
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`azure_auth_failed:${response.status}:${errorText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number | string;
  };

  if (!payload.access_token) {
    throw new Error("azure_auth_failed:no_access_token");
  }

  const expiresInSeconds = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds
      : 3600,
  };
}
