import type { DocumentRequest, DocumentType, PrismaClient } from '@prisma/client';
import type { Env } from '../../config/env';
import type { Clock } from '../../core/time/clock';
import type { BackgroundDispatcher } from '../../context';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { AuditService } from '../audit/audit.service';
import type { HoldsService } from '../iam/holds.service';
import type { GradingService } from '../grading/grading.service';
import type { StoragePort } from '../../infra/storage';
import { buildDocumentSnapshot, OFFICIAL_DOCUMENT_TYPES, type DocumentSnapshot } from './payload';
import { generateSerialNo } from './signing';
import { renderDocumentPdf } from './renderer';

export const NEEDS_TERM: ReadonlySet<DocumentType> = new Set(['COR', 'CERT_ENROLLMENT', 'GRADE_SLIP']);

export interface RequestDocumentInput {
  studentId: string;
  type: DocumentType;
  termId?: string | null;
}

interface Actor {
  userId: string;
  roles: string[];
}

export class DocumentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly holds: HoldsService,
    private readonly grading: GradingService,
    private readonly storage: StoragePort,
    private readonly dispatcher: BackgroundDispatcher,
    private readonly clock: Clock,
    private readonly config: Pick<Env, 'documentHmacSecret' | 'publicBaseUrl' | 'presignTtlSeconds' | 'storageDriver'>,
  ) {}

  private isStaff(roles: string[]): boolean {
    return roles.some((role) => ['REGISTRAR', 'ADMIN'].includes(role));
  }

  private assertOwnershipOrStaff(document: DocumentRequest, actor: Actor): void {
    if (document.studentId === actor.userId) return;
    if (this.isStaff(actor.roles)) return;
    throw new AppError(ErrorCodes.FORBIDDEN, 'Not allowed to access this document.');
  }

  async request(actor: Actor, input: RequestDocumentInput): Promise<DocumentRequest> {
    if (input.studentId !== actor.userId && !this.isStaff(actor.roles)) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Only REGISTRAR/ADMIN may request documents for another student.');
    }
    if (input.type === 'TOR_OFFICIAL' && !this.isStaff(actor.roles)) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Official transcripts are issued by the Registrar; students may request an unofficial TOR.');
    }

    const student = await this.prisma.user.findUnique({ where: { id: input.studentId }, include: { profile: true } });
    if (!student || !student.profile) {
      throw new AppError(ErrorCodes.STUDENT_PROFILE_REQUIRED, 'User has no student profile.');
    }

    let termId = input.termId ?? null;
    if (NEEDS_TERM.has(input.type) && !termId) {
      const active = await this.prisma.academicTerm.findFirst({
        where: { status: { in: ['ENROLLMENT', 'ADD_DROP', 'ONGOING'] } },
        orderBy: { startsAt: 'desc' },
      });
      if (!active) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, `Document type ${input.type} requires a termId (no active term to default to).`);
      }
      termId = active.id;
    }

    if (OFFICIAL_DOCUMENT_TYPES.has(input.type)) {
      await this.holds.assertClearance(input.studentId, { forOfficialDocument: true });
    }

    const now = this.clock.now();
    const serialNo = generateSerialNo(now);
    const built = await buildDocumentSnapshot(
      { prisma: this.prisma, grading: this.grading, config: this.config },
      { studentId: input.studentId, type: input.type, termId, serialNo, now },
    );

    const document = await this.prisma.$transaction(async (tx) => {
      const created = await tx.documentRequest.create({
        data: {
          studentId: input.studentId,
          type: input.type,
          termId,
          status: 'QUEUED',
          requestedById: actor.userId,
          serialNo: built.serialNo,
          serialHash: built.serialHash,
          snapshot: built.snapshot as unknown as object,
          snapshotHash: built.snapshotHash,
          signature: built.signature,
        },
      });
      await this.audit.append(tx, {
        actorId: actor.userId,
        action: 'documents.requested',
        resourceType: 'document_request',
        resourceId: created.id,
        payload: { type: input.type, termId, studentId: input.studentId, serialNo: built.serialNo, snapshotHash: built.snapshotHash },
      });
      return created;
    });

    await this.dispatcher.enqueueDocumentRender(document.id);
    return document;
  }

  async list(
    actor: Actor,
    filter: { studentId?: string; type?: DocumentType; status?: string } = {},
  ): Promise<DocumentRequest[]> {
    const studentId = filter.studentId ?? (this.isStaff(actor.roles) ? undefined : actor.userId);
    if (studentId && studentId !== actor.userId && !this.isStaff(actor.roles)) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Not allowed to list another student documents.');
    }
    return this.prisma.documentRequest.findMany({
      where: {
        ...(studentId ? { studentId } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
      },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    });
  }

  async get(documentId: string, actor: Actor): Promise<DocumentRequest> {
    const document = await this.prisma.documentRequest.findUnique({ where: { id: documentId } });
    if (!document) throw new AppError(ErrorCodes.DOCUMENT_NOT_FOUND, 'Document not found.');
    this.assertOwnershipOrStaff(document, actor);
    return document;
  }

  /**
   * Issues a short-lived presigned download URL and records the access
   * (BSL-4xx: every download is auditable and rate-limited upstream).
   */
  async download(
    documentId: string,
    actor: Actor,
    requestMeta: { ip?: string; userAgent?: string },
  ): Promise<{ url: string; expiresInSeconds: number; documentId: string }> {
    const document = await this.get(documentId, actor);

    if (document.status === 'REVOKED') {
      throw new AppError(ErrorCodes.DOCUMENT_REVOKED, 'This document has been revoked and can no longer be downloaded.');
    }
    if (document.status !== 'READY' || !document.storageKey) {
      throw new AppError(ErrorCodes.DOCUMENT_NOT_READY, `Document is not ready for download (status: ${document.status}).`, {
        status: 409,
      });
    }
    if (document.expiresAt && document.expiresAt <= this.clock.now()) {
      await this.prisma.documentRequest.update({ where: { id: document.id }, data: { status: 'EXPIRED' } });
      throw new AppError(ErrorCodes.DOCUMENT_EXPIRED, 'This document has expired.');
    }
    // BSL-007: active holds block official document download, not just issuance.
    if (OFFICIAL_DOCUMENT_TYPES.has(document.type)) {
      await this.holds.assertClearance(document.studentId, { forOfficialDocument: true });
    }

    const student = await this.prisma.user.findUnique({
      where: { id: document.studentId },
      include: { profile: true },
    });
    const filename = `${document.type}-${student?.profile?.studentNo ?? document.studentId}.pdf`;
    const url = await this.storage.presignGet(document.storageKey, this.config.presignTtlSeconds, filename);

    await this.prisma.$transaction(async (tx) => {
      await tx.documentDownloadEvent.create({
        data: {
          documentId: document.id,
          actorId: actor.userId,
          ip: requestMeta.ip ?? null,
          userAgent: requestMeta.userAgent ?? null,
        },
      });
      await tx.documentRequest.update({
        where: { id: document.id },
        data: { downloadCount: { increment: 1 } },
      });
      await this.audit.append(tx, {
        actorId: actor.userId,
        action: 'documents.downloaded',
        resourceType: 'document_request',
        resourceId: document.id,
        payload: { ip: requestMeta.ip ?? null, storageKeyHash: this.storage.objectKeyHash(document.storageKey!) },
      });
    });

    return { documentId: document.id, url, expiresInSeconds: this.config.presignTtlSeconds };
  }

  async revoke(actorId: string, documentId: string, reason: string): Promise<DocumentRequest> {
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.documentRequest.findUnique({ where: { id: documentId } });
      if (!document) throw new AppError(ErrorCodes.DOCUMENT_NOT_FOUND, 'Document not found.');
      if (document.status === 'REVOKED') {
        throw new AppError(ErrorCodes.CONFLICT, 'Document is already revoked.');
      }
      const updated = await tx.documentRequest.update({
        where: { id: documentId },
        data: { status: 'REVOKED', revokedAt: this.clock.now(), failureReason: reason },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'documents.revoked',
        resourceType: 'document_request',
        resourceId: documentId,
        payload: { reason, previousStatus: document.status },
      });
      return updated;
    });
  }

  /** Public verification endpoint payload — intentionally minimal. */
  async verifyBySerialHash(serialHash: string): Promise<{
    valid: boolean;
    documentType: string;
    studentName: string;
    studentNoMasked: string;
    issuedAt: string | null;
    status: string;
    revokedAt: string | null;
  }> {
    const document = await this.prisma.documentRequest.findUnique({
      where: { serialHash },
      include: { student: { include: { profile: true } } },
    });
    if (!document) {
      throw new AppError(ErrorCodes.DOCUMENT_NOT_FOUND, 'No document matches this verification code.');
    }
    const studentNo = document.student.profile?.studentNo ?? '';
    return {
      valid: document.status === 'READY',
      documentType: document.type,
      studentName: `${document.student.firstName} ${document.student.lastName[0] ?? ''}.`,
      studentNoMasked: studentNo ? `${studentNo.slice(0, 3)}${'*'.repeat(Math.max(studentNo.length - 5, 0))}${studentNo.slice(-2)}` : '',
      issuedAt: document.readyAt?.toISOString() ?? null,
      status: document.status,
      revokedAt: document.revokedAt?.toISOString() ?? null,
    };
  }

  // ── Worker callbacks ───────────────────────────────────────────────────────

  /** Internal: loads a document eligible for rendering (no ownership check). */
  async loadForRender(documentId: string): Promise<DocumentRequest | null> {
    const document = await this.prisma.documentRequest.findUnique({ where: { id: documentId } });
    if (!document) return null;
    if (document.status !== 'QUEUED' && document.status !== 'PROCESSING' && document.status !== 'FAILED') return null;
    return document;
  }

  async markProcessing(documentId: string): Promise<DocumentRequest | null> {
    const document = await this.prisma.documentRequest.findUnique({ where: { id: documentId } });
    if (!document || document.status === 'READY' || document.status === 'REVOKED') return null;
    return this.prisma.documentRequest.update({
      where: { id: documentId },
      data: { status: 'PROCESSING', processingAt: this.clock.now(), failureReason: null },
    });
  }

  async markReady(
    documentId: string,
    result: { storageKey: string; fileSize: number; pageCount: number },
  ): Promise<DocumentRequest> {
    return this.prisma.documentRequest.update({
      where: { id: documentId },
      data: {
        status: 'READY',
        storageKey: result.storageKey,
        fileSize: result.fileSize,
        pageCount: result.pageCount,
        readyAt: this.clock.now(),
      },
    });
  }

  async markFailed(documentId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.documentRequest.update({
        where: { id: documentId },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
      await this.audit.append(tx, {
        actorId: null,
        action: 'documents.render_failed',
        resourceType: 'document_request',
        resourceId: documentId,
        payload: { reason: reason.slice(0, 500) },
      });
    });
  }

  /** Re-renders a failed document from its frozen snapshot. */
  async retry(actorId: string, documentId: string): Promise<DocumentRequest> {
    const document = await this.prisma.documentRequest.findUnique({ where: { id: documentId } });
    if (!document) throw new AppError(ErrorCodes.DOCUMENT_NOT_FOUND, 'Document not found.');
    if (document.status !== 'FAILED') {
      throw new AppError(ErrorCodes.CONFLICT, `Only FAILED documents can be retried (current: ${document.status}).`);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const queued = await tx.documentRequest.update({
        where: { id: documentId },
        data: { status: 'QUEUED', failureReason: null },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'documents.retry',
        resourceType: 'document_request',
        resourceId: documentId,
        payload: {},
      });
      return queued;
    });
    // Enqueue only after the transaction commits — the inline dispatcher (and a
    // fast worker) would otherwise race the still-open transaction's row lock.
    await this.dispatcher.enqueueDocumentRender(documentId);
    return updated;
  }
}

export interface RenderedDocument {
  key: string;
  body: Buffer;
  contentType: string;
  pageCount: number;
}

/** Renders the frozen snapshot to a PDF (shared by worker and tests). */
export async function renderSnapshotToPdf(
  document: Pick<DocumentRequest, 'snapshot' | 'snapshotHash' | 'signature'>,
): Promise<RenderedDocument> {
  if (!document.snapshot || !document.snapshotHash || !document.signature) {
    throw new Error('Document has no frozen snapshot to render');
  }
  const snapshot = document.snapshot as unknown as DocumentSnapshot;
  const body = await renderDocumentPdf(snapshot, { snapshotHash: document.snapshotHash, signature: document.signature });
  const { PDFDocument } = await import('pdf-lib');
  const parsed = await PDFDocument.load(body);
  return { key: '', body, contentType: 'application/pdf', pageCount: parsed.getPageCount() };
}
