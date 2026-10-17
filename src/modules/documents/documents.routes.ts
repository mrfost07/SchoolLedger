import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { clientIp, requireAuth, requireRoles, requireStepUpMfa } from '../../core/http/auth';
import { errorResponses, IdempotencyKeyHeader, Uuid } from '../../core/http/schemas';
import { withIdempotency } from '../../core/http/idempotency';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { FsPresign } from '../../infra/storage';
import type { DocumentsService } from './documents.service';
import { DocumentSchema, DocumentTypeSchema, DownloadResponseSchema, VerifyResponseSchema } from './documents.schemas';

export function registerDocumentRoutes(app: AppServer, ctx: AppContext, documents: DocumentsService): void {
  app.post(
    '/api/v1/documents/requests',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Documents'],
        summary: 'Request a document (COR, grade slip, TOR, certificates). Snapshot is frozen at request time. Idempotency-Key required.',
        security: [{ bearerAuth: [] }],
        headers: Type.Object({ 'idempotency-key': IdempotencyKeyHeader }),
        body: Type.Object({
          type: DocumentTypeSchema,
          studentId: Type.Optional(Uuid),
          termId: Type.Optional(Uuid),
        }),
        response: { 201: DocumentSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request, ctx.config);
      const document = await withIdempotency(ctx, request, reply, true, async () => {
        // BSL-005/BSL-405: official transcripts are registrar/admin-only and
        // require a fresh step-up MFA elevation (checked inside the producer so
        // idempotent replays of an already-issued document do not demand a new
        // elevation). Authority is checked before elevation for honest errors.
        if (request.body.type === 'TOR_OFFICIAL') {
          requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN');
          requireStepUpMfa(request, ctx.config);
        }
        return documents.request(
          { userId: auth.userId, roles: auth.roles },
          {
            studentId: request.body.studentId ?? auth.userId,
            type: request.body.type,
            termId: request.body.termId ?? null,
          },
        );
      });
      return reply.status(201).send(document);
    },
  );

  app.get(
    '/api/v1/documents/requests',
    {
      schema: {
        tags: ['Documents'],
        summary: 'List document requests. STUDENT sees own; REGISTRAR/ADMIN may filter by student.',
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({
          studentId: Type.Optional(Uuid),
          type: Type.Optional(DocumentTypeSchema),
          status: Type.Optional(Type.String()),
        }),
        response: { 200: Type.Array(DocumentSchema), ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return documents.list(
        { userId: auth.userId, roles: auth.roles },
        { studentId: request.query.studentId, type: request.query.type, status: request.query.status },
      );
    },
  );

  app.get(
    '/api/v1/documents/requests/:id',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Document request detail (metadata; the frozen snapshot is rendered into the PDF, not exposed as JSON).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        response: { 200: DocumentSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return documents.get(request.params.id, { userId: auth.userId, roles: auth.roles });
    },
  );

  app.get(
    '/api/v1/documents/requests/:id/download',
    {
      schema: {
        tags: ['Documents'],
        summary: `Presigned download URL (TTL ${ctx.config.presignTtlSeconds}s). READY documents only; every download is audited.`,
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        response: { 200: DownloadResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return documents.download(
        request.params.id,
        { userId: auth.userId, roles: auth.roles },
        { ip: clientIp(request), userAgent: request.headers['user-agent'] },
      );
    },
  );

  app.post(
    '/api/v1/documents/requests/:id/revoke',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Revoke a document (REGISTRAR/ADMIN). Verification reports it as invalid immediately.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ reason: Type.String({ minLength: 5, maxLength: 500 }) }),
        response: { 200: DocumentSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN');
      return documents.revoke(auth.userId, request.params.id, request.body.reason);
    },
  );

  app.post(
    '/api/v1/documents/requests/:id/retry',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Re-queue a FAILED document render (REGISTRAR/ADMIN).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        response: { 200: DocumentSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN');
      return documents.retry(auth.userId, request.params.id);
    },
  );

  app.get(
    '/api/v1/public/verify/:serialHash',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Documents'],
        summary: 'Public document verification by QR serial hash. No authentication; minimal disclosure.',
        params: Type.Object({ serialHash: Type.String({ pattern: '^[0-9a-f]{64}$' }) }),
        response: { 200: VerifyResponseSchema, ...errorResponses },
      },
    },
    async (request) => documents.verifyBySerialHash(request.params.serialHash),
  );

  if (ctx.config.storageDriver === 'fs') {
    app.get(
      '/api/v1/documents/blob/*',
      {
        schema: {
          tags: ['Documents'],
          summary: 'HMAC-signed local blob download (filesystem storage driver only).',
          hide: true,
          querystring: Type.Object({
            exp: Type.String(),
            sig: Type.String(),
            name: Type.Optional(Type.String()),
          }),
        },
      },
      async (request, reply) => {
        const key = (request.params as Record<string, string>)['*'];
        const exp = Number.parseInt(request.query.exp, 10);
        if (!key || !Number.isFinite(exp)) {
          throw new AppError(ErrorCodes.UNSIGNED_DOCUMENT_URL, 'Malformed signed URL.');
        }
        const verdict = FsPresign.verify(ctx.config.presignSecret, key, exp, request.query.sig);
        if (verdict === 'invalid') throw new AppError(ErrorCodes.UNSIGNED_DOCUMENT_URL, 'Invalid signature.');
        if (verdict === 'expired') throw new AppError(ErrorCodes.DOCUMENT_EXPIRED, 'The download URL has expired.', { status: 410 });

        const body = await ctx.storage.getObject(key);
        const disposition = request.query.name ? `attachment; filename="${request.query.name.replaceAll('"', '')}"` : 'inline';
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', disposition)
          .header('cache-control', 'private, no-store')
          .send(body);
      },
    );
  }
}
