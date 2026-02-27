/**
 * Encryption utilities for persistent config storage.
 *
 * Uses HKDF to derive purpose-specific keys from SESSION_SECRET,
 * then AES-256-GCM for authenticated encryption.
 */

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

// HKDF info strings for key separation
const CONFIG_INFO = "cf-reporting-config";
const SMTP_INFO = "cf-reporting-smtp";

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret === "build-placeholder-00000000000000000000") {
    throw new Error(
      "SESSION_SECRET must be explicitly set (32+ characters) for persistent configuration. " +
      "Auto-generated secrets change on restart, making stored data unrecoverable."
    );
  }
  return secret;
}

function deriveKey(salt: Buffer, info: string): Buffer {
  const secret = getSessionSecret();
  return Buffer.from(hkdfSync("sha256", secret, salt, info, KEY_LENGTH));
}

// --- File-level encryption (for entire config JSON) ---

interface EncryptedBlob {
  salt: string; // base64
  iv: string; // base64
  data: string; // base64
  tag: string; // base64
}

export function encryptConfig(plaintext: string): EncryptedBlob {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt, CONFIG_INFO);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptConfig(blob: EncryptedBlob): string {
  const salt = Buffer.from(blob.salt, "base64");
  const key = deriveKey(salt, CONFIG_INFO);
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const data = Buffer.from(blob.data, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

// --- SMTP password encryption (independent layer within config) ---

interface EncryptedPassword {
  encryptedPass: string; // base64
  passIv: string; // base64
  passTag: string; // base64
}

export function encryptSmtpPassword(password: string): EncryptedPassword {
  // Use a fixed salt derived from the session secret for SMTP passwords.
  // This way the same SESSION_SECRET always derives the same SMTP key,
  // allowing password re-encryption when config is updated.
  const salt = Buffer.from(
    hkdfSync("sha256", getSessionSecret(), "smtp-salt", "salt-derivation", SALT_LENGTH)
  );
  const key = deriveKey(salt, SMTP_INFO);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encryptedPass: encrypted.toString("base64"),
    passIv: iv.toString("base64"),
    passTag: tag.toString("base64"),
  };
}

export function decryptSmtpPassword(encrypted: EncryptedPassword): string {
  const salt = Buffer.from(
    hkdfSync("sha256", getSessionSecret(), "smtp-salt", "salt-derivation", SALT_LENGTH)
  );
  const key = deriveKey(salt, SMTP_INFO);
  const iv = Buffer.from(encrypted.passIv, "base64");
  const tag = Buffer.from(encrypted.passTag, "base64");
  const data = Buffer.from(encrypted.encryptedPass, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

/**
 * Check whether SESSION_SECRET is explicitly set (not auto-generated).
 * Persistent mode requires this.
 */
export function isSecretExplicit(): boolean {
  const secret = process.env.SESSION_SECRET;
  return !!secret && secret.length >= 32 && secret !== "build-placeholder-00000000000000000000";
}
