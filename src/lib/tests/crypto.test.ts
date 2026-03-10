import { describe, expect, test } from "vitest";
import { decryptString, encryptString, signValue, verifySignedValue } from "../crypto";

describe("crypto helpers", () => {
  test("encrypts and decrypts account secrets", async () => {
    const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
    const ciphertext = await encryptString(secret, "super-secret");
    const plaintext = await decryptString(secret, ciphertext);
    expect(plaintext).toBe("super-secret");
  });

  test("signs and verifies session payloads", async () => {
    const signature = await signValue("session-secret", "payload");
    await expect(verifySignedValue("session-secret", "payload", signature)).resolves.toBe(true);
    await expect(verifySignedValue("session-secret", "tampered", signature)).resolves.toBe(false);
  });
});
