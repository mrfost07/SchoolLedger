import pino from 'pino';
import type { PrismaClient } from '@prisma/client';
import type { AppServer } from '../../src/core/http/server-types';
import type { AppContext } from '../../src/context';
import type { Env } from '../../src/config/env';
import { MutableClock } from '../../src/core/time/clock';
import { FsStorage } from '../../src/infra/storage';
import { buildApp, composeServices, type ComposedServices } from '../../src/app';
import { signJwt } from '../../src/core/crypto/jwt';
import { getTestInfra, type TestInfra } from './infra';

export const TEST_START = new Date('2026-01-05T08:00:00.000Z');

export interface TestApp {
  app: AppServer;
  ctx: AppContext;
  services: ComposedServices;
  clock: MutableClock;
  infra: TestInfra;
  prisma: PrismaClient;
  config: Env;
  /** Directly minted access token (bypasses password/TOTP for setup-heavy tests). */
  mintToken(
    userId: string,
    roles: string[],
    options?: { mfa?: boolean; ttlSeconds?: number },
  ): string;
  auth(token: string): Record<string, string>;
  close(): Promise<void>;
}

export function testEnv(infra: TestInfra): Env {
  return {
    nodeEnv: 'test',
    port: 0,
    logLevel: 'silent',
    workersEnabled: false,
    publicBaseUrl: 'http://localhost:3000',
    corsOrigins: [],
    databaseUrl: infra.databaseUrl,
    redisUrl: '',
    redisRequired: false,
    jwtAccessSecret: 'test-access-secret',
    jwtMfaSecret: 'test-mfa-secret',
    documentHmacSecret: 'test-document-hmac-secret',
    presignSecret: 'test-presign-secret',
    accessTokenTtlMinutes: 15,
    refreshTokenTtlDays: 30,
    mfaTokenTtlMinutes: 5,
    stepUpTtlMinutes: 5,
    passingGradeMax: '3.00',
    incCompletionDays: 365,
    incDefaultGrade: '5.00',
    deansListerMaxGwa: '1.45',
    honorsSummaMax: '1.20',
    honorsMagnaMax: '1.45',
    honorsCumLaudeMax: '1.75',
    maxAcademicUnits: 30,
    storageDriver: 'fs',
    storageFsDir: infra.storageDir,
    s3Endpoint: '',
    s3Region: 'us-east-1',
    s3Bucket: '',
    s3AccessKey: '',
    s3SecretKey: '',
    s3ForcePathStyle: true,
    presignTtlSeconds: 300,
    currency: 'PHP',
    rateLimitMax: 100_000,
    rateLimitWindowMs: 60_000,
  };
}

/**
 * Builds a fully wired app against the shared embedded infra with a mutable
 * clock and inline job execution (documents render synchronously).
 */
export async function createTestApp(options: { reset?: boolean; clockAt?: Date } = {}): Promise<TestApp> {
  const infra = await getTestInfra();
  if (options.reset !== false) await infra.resetDatabase();

  const clock = new MutableClock(options.clockAt ?? TEST_START);
  const config = testEnv(infra);
  const logger = pino({ level: 'silent' });
  const storage = new FsStorage(config, infra.storageDir);
  const ctx: AppContext = { config, prisma: infra.prisma, redis: infra.redis, storage, clock, logger };

  const services = composeServices(ctx, { inlineJobs: true });
  const app = buildApp(ctx, services);
  await app.ready();

  return {
    app,
    ctx,
    services,
    clock,
    infra,
    prisma: infra.prisma,
    config,
    mintToken(userId, roles, opts = {}) {
      // JWT lifetime/skew are wall-clock based in this codebase (auth.ts uses
      // `new Date()`), while business logic uses the mutable test clock.
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      return signJwt(
        {
          sub: userId,
          typ: 'access',
          roles,
          ...(opts.mfa ? { mfa: true, mfaAt: nowSeconds } : {}),
        },
        config.jwtAccessSecret,
        opts.ttlSeconds ?? 900,
        now,
      );
    },
    auth(token) {
      return { authorization: `Bearer ${token}` };
    },
    async close() {
      await app.close();
      await services.close();
    },
  };
}
