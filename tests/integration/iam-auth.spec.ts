import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { verifyJwt } from '../../src/core/crypto/jwt';
import { createTestApp, type TestApp } from '../helpers/app';
import { createUser } from '../helpers/fixtures';

describe('IAM auth flow', () => {
  let test: TestApp;
  let adminId: string;

  beforeAll(async () => {
    test = await createTestApp();
    const admin = await createUser(test.prisma, {
      email: 'admin.auth@test.dev',
      roles: ['ADMIN'],
      password: 'Password123!',
    });
    adminId = admin.id;
    await createUser(test.prisma, {
      email: 'suspended.auth@test.dev',
      roles: ['STUDENT'],
      password: 'Password123!',
    });
    await test.prisma.user.update({ where: { email: 'suspended.auth@test.dev' }, data: { status: 'SUSPENDED' } });
  });

  afterAll(async () => {
    await test.close();
  });

  it('rejects bad credentials and disabled accounts with precise codes', async () => {
    const wrong = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin.auth@test.dev', password: 'nope-nope-nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('AUTH_INVALID_CREDENTIALS');

    const disabled = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'suspended.auth@test.dev', password: 'Password123!' },
    });
    expect(disabled.statusCode).toBe(422);
    expect(disabled.json().code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  it('logs in, inspects /auth/me, and enforces bearer auth', async () => {
    const login = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
    });
    expect(login.statusCode).toBe(200);
    const tokens = login.json();
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresInSeconds).toBe(900);

    const me = await test.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: test.auth(tokens.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('admin.auth@test.dev');
    expect(me.json().roles).toEqual(['ADMIN']);
    expect(me.json().profile).toBeNull();

    const anonymous = await test.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anonymous.statusCode).toBe(401);

    const garbage = await test.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: test.auth('not.a.jwt'),
    });
    expect(garbage.statusCode).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const login = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
    });
    const first = login.json().refreshToken as string;

    const rotated = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first },
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json().refreshToken as string;
    expect(second).not.toBe(first);

    const reuse = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('REFRESH_TOKEN_REUSED');

    const afterRevocation = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: second },
    });
    expect(afterRevocation.statusCode).toBe(401);
    expect(afterRevocation.json().code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('serializes concurrent rotations of the same refresh token (exactly one winner)', async () => {
    const login = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
    });
    const token = login.json().refreshToken as string;

    const [a, b] = await Promise.all([
      test.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: token } }),
      test.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: token } }),
    ]);

    const winner = a.statusCode === 200 ? a : b;
    const loser = a.statusCode === 200 ? b : a;
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
    expect(loser.json().code).toBe('REFRESH_TOKEN_REUSED');

    // The loser is treated as reuse, which revokes the family — so even the
    // winner's freshly issued token must be dead immediately.
    const after = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: winner.json().refreshToken },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('logout revokes the presented family but not other sessions', async () => {
    const sessionA = (
      await test.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
      })
    ).json();
    const sessionB = (
      await test.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
      })
    ).json();

    const logout = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: sessionA.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const revoked = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: sessionA.refreshToken },
    });
    expect(revoked.statusCode).toBe(401);

    const stillValid = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: sessionB.refreshToken },
    });
    expect(stillValid.statusCode).toBe(200);
  });

  it('enrolls TOTP, challenges at login and honors step-up', async () => {
    const login = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
    });
    const access = login.json().accessToken as string;

    const setup = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/setup',
      headers: test.auth(access),
    });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;
    expect(setup.json().otpauthUrl).toContain('otpauth://totp/');

    const enable = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enable',
      headers: test.auth(access),
      payload: { code: authenticator.generate(secret) },
    });
    expect(enable.statusCode).toBe(204);

    const challenged = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
    });
    expect(challenged.statusCode).toBe(200);
    expect(challenged.json().mfaRequired).toBe(true);
    const mfaToken = challenged.json().mfaToken as string;

    const wrongCode = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { mfaToken, code: '000000' },
    });
    expect(wrongCode.statusCode).toBe(401);
    expect(wrongCode.json().code).toBe('AUTH_MFA_INVALID');

    const verified = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { mfaToken, code: authenticator.generate(secret) },
    });
    expect(verified.statusCode).toBe(200);
    const accessToken = verified.json().accessToken as string;
    const payload = verifyJwt(accessToken, test.config.jwtAccessSecret, new Date());
    // Login proves TOTP factor but does NOT grant the fresh step-up elevation.
    expect(payload.mfa).not.toBe(true);
    const me = await test.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: test.auth(accessToken) });
    expect(me.json().mfaEnabled).toBe(true);

    const stepUp = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/step-up',
      headers: test.auth(accessToken),
      payload: { code: authenticator.generate(secret) },
    });
    expect(stepUp.statusCode).toBe(200);
    const elevated = verifyJwt(stepUp.json().accessToken as string, test.config.jwtAccessSecret, new Date());
    expect(elevated.mfa).toBe(true);
    expect(elevated.sub).toBe(adminId);
  });

  it('logout-all revokes every family of the user', async () => {
    const s1 = (
      await test.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'admin.auth@test.dev', password: 'Password123!' },
      })
    ).json();
    const code = authenticator.generate((await test.prisma.user.findUniqueOrThrow({ where: { id: adminId } })).totpSecret!);
    const s2 = (
      await test.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        payload: { mfaToken: s1.mfaToken, code },
      })
    ).json();

    const result = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: test.auth(s2.accessToken),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().revokedFamilies).toBeGreaterThanOrEqual(1);

    const attempt = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: s2.refreshToken },
    });
    expect(attempt.statusCode).toBe(401);
  });
});
