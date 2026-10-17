import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { canonicalJson, sha256Hex } from '../crypto/hash';
import { AppError, ErrorCodes } from '../errors/taxonomy';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const TTL_HOURS = 24;

export interface IdempotencyContext {
  prisma: PrismaClient;
}

/**
 * Idempotent write middleware. Contract:
 *  - Clients send `Idempotency-Key` for flagged endpoints (required for
 *    enrollment reservation and document requests).
 *  - First execution inserts an IN_PROGRESS row; the response is persisted on
 *    success (state COMPLETED) for 24h.
 *  - Replays return the stored response with `Idempotency-Replayed: true`.
 *  - Concurrent execution of the same key returns 409 IDEMPOTENT_REQUEST_IN_PROGRESS.
 *  - Reusing a key with a different body returns 409 IDEMPOTENCY_KEY_REUSED.
 */
export async function withIdempotency<T>(
  ctx: IdempotencyContext,
  request: FastifyRequest,
  reply: FastifyReply,
  required: boolean,
  handler: () => Promise<T>,
): Promise<T> {
  const rawKey = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (!key || key.trim() === '') {
    if (required) {
      throw new AppError(ErrorCodes.IDEMPOTENCY_KEY_REQUIRED, `Header ${IDEMPOTENCY_HEADER} is required for this endpoint.`);
    }
    return handler();
  }
  if (key.length > 200) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Idempotency-Key is too long (max 200 characters).');
  }
  const idempotencyKey: string = key;

  const userId = request.auth?.userId ?? null;
  const route = `${request.method} ${request.routeOptions?.url ?? request.url}`;
  const requestHash = sha256Hex(canonicalJson({ route, body: request.body ?? null }));
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3_600_000);

  try {
    await ctx.prisma.idempotencyKey.create({
      data: { userId, key, route, requestHash, state: 'IN_PROGRESS', expiresAt },
    });
  } catch (err) {
    const conflict = await ctx.prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId: userId as string, key } },
    });
    if (!conflict) throw err;

    // A row that outlived its TTL (e.g. process died mid-request) must not
    // block the key forever — reap it and let this attempt claim the key.
    if (conflict.expiresAt.getTime() <= Date.now()) {
      const reaped = await ctx.prisma.idempotencyKey.deleteMany({ where: { id: conflict.id } });
      if (reaped.count === 0) {
        throw new AppError(ErrorCodes.IDEMPOTENT_REQUEST_IN_PROGRESS, 'An identical request is already being processed.');
      }
      try {
        await ctx.prisma.idempotencyKey.create({
          data: { userId, key, route, requestHash, state: 'IN_PROGRESS', expiresAt },
        });
      } catch {
        throw new AppError(ErrorCodes.IDEMPOTENT_REQUEST_IN_PROGRESS, 'An identical request is already being processed.');
      }
      return handlerAndPersist();
    }

    if (conflict.requestHash !== requestHash) {
      throw new AppError(
        ErrorCodes.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used with a different request payload.',
      );
    }
    if (conflict.state === 'COMPLETED') {
      void reply.header('Idempotency-Replayed', 'true');
      return (conflict.responseJson as { data: T })?.data ?? (conflict.responseJson as T);
    }
    throw new AppError(ErrorCodes.IDEMPOTENT_REQUEST_IN_PROGRESS, 'An identical request is already being processed.');
  }

  async function handlerAndPersist(): Promise<T> {
    try {
      const result = await handler();
      await ctx.prisma.idempotencyKey.update({
        where: { userId_key: { userId: userId as string, key: idempotencyKey } },
        data: {
          state: 'COMPLETED',
          statusCode: reply.statusCode ?? 200,
          responseJson: JSON.parse(JSON.stringify({ data: result })),
        },
      });
      return result;
    } catch (error) {
      await ctx.prisma.idempotencyKey
        .delete({ where: { userId_key: { userId: userId as string, key: idempotencyKey } } })
        .catch(() => undefined);
      throw error;
    }
  }

  return handlerAndPersist();
}

/** Periodic housekeeping: drops rows whose TTL elapsed (COMPLETED or not). */
export async function cleanupExpiredIdempotencyKeys(prisma: PrismaClient): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
