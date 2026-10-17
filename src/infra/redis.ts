import Redis from 'ioredis';
import type { Logger } from 'pino';

export interface RedisConnectResult {
  redis: Redis | null;
  degraded: boolean;
}

/**
 * Connects to Redis. When `required` is false and the server is unreachable the
 * process continues in degraded mode (DB-only capacity path, inline job
 * execution) instead of crashing — production sets REDIS_REQUIRED=true.
 */
export async function connectRedis(url: string, required: boolean, logger: Logger): Promise<RedisConnectResult> {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

  redis.on('error', (err) => {
    logger.warn({ err: err.message }, 'redis connection error');
  });

  try {
    await redis.connect();
    await redis.ping();
    return { redis, degraded: false };
  } catch (err) {
    if (required) {
      await redis.quit().catch(() => undefined);
      throw new Error(`Redis is required but unreachable at ${url}: ${(err as Error).message}`);
    }
    logger.warn({ url }, 'redis unreachable — running in degraded mode');
    redis.disconnect();
    return { redis: null, degraded: true };
  }
}
