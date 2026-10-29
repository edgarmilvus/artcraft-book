// src/policy/vault.ts
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

/** AES-256-GCM parameters we use for every vault in the studio. */
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;         // 96-bit IV is the GCM standard
const TAG_LEN = 16;
const SCRYPT_N = 1 << 15;  // 32768 — high cost, ~250 ms on a modern laptop
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// scrypt needs 128 * N * r bytes of working memory — 32 MiB at these
// parameters — and Node's default cap is exactly 32 MiB, so the cap has
// to be raised explicitly or the derivation refuses to run.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export interface VaultEnvelope {
  ciphertext: string; // base64
  salt: string;       // base64
  iv: string;         // base64
  tag: string;        // base64
}

/**
 * Encrypt a record of secrets and return the tamper-evident envelope that is
 * stored inside the policy.
 */
export function sealVault(secrets: Record<string, string>, passphrase: string): VaultEnvelope {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pt = Buffer.from(JSON.stringify(secrets), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Best-effort scrub of the derived key material.
  key.fill(0);
  return {
    ciphertext: ct.toString("base64"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt a vault envelope. Throws if the passphrase is wrong or if the
 * ciphertext has been tampered with (GCM auth failure).
 */
export function openVault(env: VaultEnvelope, passphrase: string): Record<string, string> {
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (tag.length !== TAG_LEN) throw new Error("vault: malformed GCM tag");
  const key = scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, "base64")),
    decipher.final(),
  ]);
  key.fill(0);
  return JSON.parse(pt.toString("utf8")) as Record<string, string>;
}

/** Constant-time comparison helper for token checks. */
export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a, "utf8");
  const B = Buffer.from(b, "utf8");
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}
