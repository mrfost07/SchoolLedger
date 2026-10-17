import type { AuditLog } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { auditChainHash, canonicalJson, GENESIS_HASH } from '../../core/crypto/hash';
import type { Db } from '../../infra/prisma';

export interface AuditAppendInput {
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  payload?: unknown;
  timestamp?: Date;
}

export interface AuditEntryRef {
  id: bigint;
  entryHash: string;
}

/**
 * Tamper-evident audit log (BSL-008 / INV-6).
 * Hash chain: entry_hash = sha256(prev_hash ‖ actor_id ‖ action ‖ resource_type
 *   ‖ resource_id ‖ canonical_json(payload) ‖ iso_timestamp)
 * Appends take a transaction-scoped advisory lock so the chain stays strictly
 * serialized under concurrency.
 */
export class AuditService {
  static readonly CHAIN_LOCK_KEY = 982451653n;

  constructor(private readonly prisma: PrismaClient) {}

  async append(db: Db, input: AuditAppendInput): Promise<AuditEntryRef> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${AuditService.CHAIN_LOCK_KEY})`;

    const previous = await db.auditLog.findFirst({
      orderBy: { id: 'desc' },
      select: { entryHash: true },
    });
    const prevHash = previous?.entryHash ?? GENESIS_HASH;
    const createdAt = input.timestamp ?? new Date();
    const payload = input.payload ?? {};
    const canonical = canonicalJson(payload);

    const entryHash = auditChainHash({
      prevHash,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      payload,
      timestampIso: createdAt.toISOString(),
    });

    const row = await db.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        payload: JSON.parse(canonical),
        prevHash,
        entryHash,
        createdAt,
      },
      select: { id: true, entryHash: true },
    });
    return row;
  }

  async appendStandalone(input: AuditAppendInput): Promise<AuditEntryRef> {
    return this.prisma.$transaction(async (tx) => this.append(tx, input));
  }

  async verifyChain(fromId?: bigint): Promise<{ valid: boolean; checked: number; brokenAtId?: string; reason?: string }> {
    const entries = await this.prisma.auditLog.findMany({
      where: fromId ? { id: { gte: fromId } } : undefined,
      orderBy: { id: 'asc' },
    });

    let expectedPrev: string | null = null;
    let checked = 0;
    for (const entry of entries) {
      if (expectedPrev !== null && entry.prevHash !== expectedPrev) {
        return { valid: false, checked, brokenAtId: entry.id.toString(), reason: 'prev_hash mismatch' };
      }
      const recomputed = auditChainHash({
        prevHash: entry.prevHash,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        payload: entry.payload as unknown,
        timestampIso: entry.createdAt.toISOString(),
      });
      if (recomputed !== entry.entryHash) {
        return { valid: false, checked, brokenAtId: entry.id.toString(), reason: 'entry_hash mismatch' };
      }
      expectedPrev = entry.entryHash;
      checked += 1;
    }
    return { valid: true, checked };
  }

  async list(params: { limit: number; cursor?: bigint; resourceType?: string; actorId?: string }): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: {
        ...(params.cursor ? { id: { lt: params.cursor } } : {}),
        ...(params.resourceType ? { resourceType: params.resourceType } : {}),
        ...(params.actorId ? { actorId: params.actorId } : {}),
      },
      orderBy: { id: 'desc' },
      take: params.limit,
    });
  }
}
