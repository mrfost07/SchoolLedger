import { randomBytes } from 'node:crypto';
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../../core/crypto/hash';

/** Serial format: SP-<year>-<16 hex chars> (upper-case). */
export function generateSerialNo(now: Date, entropy: Buffer = randomBytes(8)): string {
  return `SP-${now.getUTCFullYear()}-${entropy.toString('hex').toUpperCase()}`;
}

/** Deterministic hash of the frozen snapshot payload (excludes the verification block). */
export function snapshotHashOf(core: unknown): string {
  return sha256Hex(canonicalJson(core));
}

/** HMAC-SHA256 over the snapshot hash — the document's authenticity seal. */
export function signSnapshot(secret: string, snapshotHash: string): string {
  return hmacSha256Hex(secret, snapshotHash);
}

/**
 * Public lookup token. The raw serial number is never exposed for lookup;
 * the verify endpoint accepts only this hash (enumeration-resistant).
 */
export function serialHashOf(serialNo: string, signature: string): string {
  return sha256Hex(`${serialNo}|${signature}`);
}

export function verifyUrlFor(publicBaseUrl: string, serialHash: string): string {
  return `${publicBaseUrl}/api/v1/public/verify/${serialHash}`;
}
