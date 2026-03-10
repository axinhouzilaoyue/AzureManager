import type { AppEnv, DecryptedAccountRecord } from "../../types";

export async function getAzureAccessToken(
  env: AppEnv,
  account: DecryptedAccountRecord,
): Promise<string> {
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
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`azure_auth_failed:${response.status}:${errorText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
  };

  if (!payload.access_token) {
    throw new Error("azure_auth_failed:no_access_token");
  }

  return payload.access_token;
}
