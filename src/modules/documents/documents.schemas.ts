import { Type } from '@sinclair/typebox';
import { DateTime, NullableDateTime, Uuid } from '../../core/http/schemas';

export const DocumentTypeSchema = Type.Union([
  Type.Literal('COR'),
  Type.Literal('GRADE_SLIP'),
  Type.Literal('TOR_UNOFFICIAL'),
  Type.Literal('TOR_OFFICIAL'),
  Type.Literal('CERT_GRADES'),
  Type.Literal('CERT_GOOD_MORAL'),
  Type.Literal('CERT_ENROLLMENT'),
]);

export const DocumentStatusSchema = Type.Union([
  Type.Literal('QUEUED'),
  Type.Literal('PROCESSING'),
  Type.Literal('READY'),
  Type.Literal('FAILED'),
  Type.Literal('EXPIRED'),
  Type.Literal('REVOKED'),
]);

export const DocumentSchema = Type.Object({
  id: Uuid,
  studentId: Uuid,
  type: DocumentTypeSchema,
  termId: Type.Union([Uuid, Type.Null()]),
  status: DocumentStatusSchema,
  requestedById: Type.Union([Uuid, Type.Null()]),
  serialNo: Type.Union([Type.String(), Type.Null()]),
  serialHash: Type.Union([Type.String(), Type.Null()]),
  snapshotHash: Type.Union([Type.String(), Type.Null()]),
  fileSize: Type.Union([Type.Integer(), Type.Null()]),
  pageCount: Type.Union([Type.Integer(), Type.Null()]),
  downloadCount: Type.Integer(),
  failureReason: Type.Union([Type.String(), Type.Null()]),
  requestedAt: DateTime,
  processingAt: NullableDateTime,
  readyAt: NullableDateTime,
  expiresAt: NullableDateTime,
  revokedAt: NullableDateTime,
});

export const VerifyResponseSchema = Type.Object({
  valid: Type.Boolean(),
  documentType: Type.String(),
  studentName: Type.String(),
  studentNoMasked: Type.String(),
  issuedAt: NullableDateTime,
  status: Type.String(),
  revokedAt: NullableDateTime,
});

export const DownloadResponseSchema = Type.Object({
  documentId: Uuid,
  url: Type.String(),
  expiresInSeconds: Type.Integer(),
});
