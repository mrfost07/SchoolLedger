import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, auditChainHash, canonicalJson, hmacSha256Hex, sha256Hex, timingSafeEqualHex } from '../../src/core/crypto/hash';
import { signJwt, verifyJwt } from '../../src/core/crypto/jwt';
import { FsPresign } from '../../src/infra/storage';
import { AppError, ErrorCodes } from '../../src/core/errors/taxonomy';
import { randomToken } from '../../src/core/crypto/tokens';

describe('canonical JSON', () => {
  it('is key-order independent and recursive', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(canonicalJson({ a: { c: 'x', d: [2, 1] }, b: 1 }));
  });

  it('produces stable hashes regardless of property order', () => {
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
  });
});

describe('audit hash chain', () => {
  it('starts from GENESIS and links entries', () => {
    const first = auditChainHash({
      actorId: 'u1',
      action: 'test.action',
      resourceType: 'thing',
      resourceId: 'r1',
      payload: { a: 1 },
      timestampIso: '2026-01-05T08:00:00.000Z',
      prevHash: GENESIS_HASH,
    });
    const second = auditChainHash({
      actorId: 'u1',
      action: 'test.action2',
      resourceType: 'thing',
      resourceId: 'r1',
      payload: { a: 2 },
      timestampIso: '2026-01-05T08:00:01.000Z',
      prevHash: first,
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(second).toBe(
      auditChainHash({
        actorId: 'u1',
        action: 'test.action2',
        resourceType: 'thing',
        resourceId: 'r1',
        payload: { a: 2 },
        timestampIso: '2026-01-05T08:00:01.000Z',
        prevHash: first,
      }),
    );
  });
});

describe('HS256 JWT', () => {
  const secret = 'unit-test-secret';
  const now = new Date('2026-01-05T08:00:00.000Z');

  it('round-trips payloads', () => {
    const token = signJwt({ sub: 'user-1', typ: 'access', roles: ['STUDENT'], mfa: true, mfaAt: 100 }, secret, 900, now);
    const payload = verifyJwt(token, secret, now);
    expect(payload.sub).toBe('user-1');
    expect(payload.roles).toEqual(['STUDENT']);
    expect(payload.mfa).toBe(true);
  });

  it('rejects tampered payloads and wrong secrets', () => {
    const token = signJwt({ sub: 'user-1', typ: 'access' }, secret, 900, now);
    const [header, body, sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ sub: 'admin-1', typ: 'access', jti: 'x', iat: 1, exp: 9999999999 })).toString('base64url');
    expect(() => verifyJwt(`${header}.${forgedBody}.${sig}`, secret, now)).toThrowError(AppError);
    expect(() => verifyJwt(token, 'other-secret', now)).toThrowError(AppError);
    expect(() => verifyJwt(`${header}.${body}`, secret, now)).toThrowError(/Malformed/);
  });

  it('rejects expired tokens with TOKEN_EXPIRED', () => {
    const token = signJwt({ sub: 'user-1', typ: 'access' }, secret, 60, now);
    const later = new Date(now.getTime() + 61_000);
    try {
      verifyJwt(token, secret, later);
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.TOKEN_EXPIRED);
    }
  });
});

describe('HMAC + presign', () => {
  it('hmac is deterministic and timing-safe comparison works', () => {
    const mac = hmacSha256Hex('secret', 'payload');
    expect(timingSafeEqualHex(mac, hmacSha256Hex('secret', 'payload'))).toBe(true);
    expect(timingSafeEqualHex(mac, hmacSha256Hex('secret', 'other'))).toBe(false);
  });

  it('fs presign verifies, detects tamper and expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const sig = FsPresign.sign('presign-secret', 'documents/a/b.pdf', exp);
    expect(FsPresign.verify('presign-secret', 'documents/a/b.pdf', exp, sig)).toBe('ok');
    expect(FsPresign.verify('presign-secret', 'documents/a/other.pdf', exp, sig)).toBe('invalid');
    expect(FsPresign.verify('presign-secret', 'documents/a/b.pdf', exp + 1, sig)).toBe('invalid');
    expect(FsPresign.verify('presign-secret', 'documents/a/b.pdf', Math.floor(Date.now() / 1000) - 1, FsPresign.sign('presign-secret', 'documents/a/b.pdf', Math.floor(Date.now() / 1000) - 1))).toBe('expired');
  });

  it('random tokens are unique and url-safe', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
