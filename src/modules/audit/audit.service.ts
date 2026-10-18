import type { AuditLog } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { auditChainHash, canonicalJson, GENESIS_HASH, sha256Hex } from '../../core/crypto/hash';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { getTenantStore, requireTenantSchoolId } from '../../core/tenant/context';
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
 * Tamper-evident audit log (BSL-008 / INV-6). One hash chain per school plus a
 * platform chain (schoolId NULL) for events with no tenant (login of an
 * unknown user, session revocation of an unbound token).
 *
 * Hash chain: entry_hash = sha256(prev_hash ‖ actor_id ‖ action ‖ resource_type
 *   ‖ resource_id ‖ canonical_json(payload) ‖ iso_timestamp)
 * Appends take a transaction-scoped advisory lock keyed per chain so each
 * school's chain stays strictly serialized under concurrency.
 */
export class AuditService {
  static readonly CHAIN_LOCK_KEY = 982451653n;

  constructor(private readonly prisma: PrismaClient) {}

  /** Advisory lock key for a chain (platform chain uses the base key). */
  static chainLockKey(schoolId: string | null): bigint {
    if (schoolId === null) return AuditService.CHAIN_LOCK_KEY;
    const digest = sha256Hex(`audit-chain:${schoolId}`).slice(0, 15);
    return AuditService.CHAIN_LOCK_KEY ^ BigInt(`0x${digest}`);
  }

  /**
   * Chain the append belongs to, from the ambient context:
   * school tenant context -> that school; system context -> platform (NULL).
   */
  private currentChainSchoolId(): string | null {
    const store = getTenantStore();
    if (!store) {
      throw new AppError(ErrorCodes.TENANT_CONTEXT_MISSING, 'audit.append requires a tenant/system context frame.');
    }
    return store.system ? null : requireTenantSchoolId();
  }

  async append(db: Db, input: AuditAppendInput): Promise<AuditEntryRef> {
    const schoolId = this.currentChainSchoolId();
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${AuditService.chainLockKey(schoolId)}::bigint)`;

    const previous = await db.auditLog.findFirst({
      where: schoolId === null ? { schoolId: null } : undefined,
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

  /**
   * Verifies the chain for the ambient school (or the platform chain in system
   * context). Pass `schoolId` explicitly to verify another chain from a system
   * context.
   */
  async verifyChain(options: { fromId?: bigint; schoolId?: string | null } = {}): Promise<{
    valid: boolean;
    checked: number;
    brokenAtId?: string;
    reason?: string;
  }> {
    const store = getTenantStore();
    const schoolId = options.schoolId !== undefined ? options.schoolId : store?.system ? null : requireTenantSchoolId();
    const entries = await this.prisma.auditLog.findMany({
      where: {
        schoolId,
        ...(options.fromId ? { id: { gte: options.fromId } } : {}),
      },
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
