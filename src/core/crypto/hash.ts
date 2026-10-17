import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(secret: string, input: string | Buffer): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * insignificant whitespace. This is the canonical form used for all hashes
 * and HMAC signatures (audit chain, ledger entries, document snapshots).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (type === 'bigint') return JSON.stringify((value as bigint).toString());
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${type}`);
}

/**
 * Hash chain step: sha256(prevHash + actorId + action + resourceType + resourceId + canonical(payload) + iso(timestamp))
 * (BSL-008)
 */
export function auditChainHash(input: {
  prevHash: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payload: unknown;
  timestampIso: string;
}): string {
  const material = [
    input.prevHash,
    input.actorId ?? '',
    input.action,
    input.resourceType,
    input.resourceId ?? '',
    canonicalJson(input.payload),
    input.timestampIso,
  ].join('|');
  return sha256Hex(material);
}

export const GENESIS_HASH = '0'.repeat(64);
