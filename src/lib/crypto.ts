import { fromBase64Url, toBase64Url } from "./utils";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asArrayBuffer(fromBase64Url(secret)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asArrayBuffer(textEncoder.encode(secret)),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
}

export async function encryptString(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    asArrayBuffer(textEncoder.encode(plaintext)),
  );

  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptString(secret: string, value: string): Promise<string> {
  const [version, ivB64, cipherB64] = value.split(".");
  if (version !== "v1" || !ivB64 || !cipherB64) {
    throw new Error("invalid_encrypted_value");
  }

  const key = await importAesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(fromBase64Url(ivB64)),
    },
    key,
    asArrayBuffer(fromBase64Url(cipherB64)),
  );

  return textDecoder.decode(plaintext);
}

export async function signValue(secret: string, payload: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, asArrayBuffer(textEncoder.encode(payload)));
  return toBase64Url(new Uint8Array(signature));
}

export async function verifySignedValue(secret: string, payload: string, signature: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    asArrayBuffer(fromBase64Url(signature)),
    asArrayBuffer(textEncoder.encode(payload)),
  );
}
