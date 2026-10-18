import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from '../../src/core/crypto/hash';
import { runWithSystem } from '../../src/core/tenant/context';
import { FsPresign } from '../../src/infra/storage';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  createBackbone,
  createSection,
  createStudent,
  createUser,
  enrollStudentDirect,
  type FixtureBackbone,
} from '../helpers/fixtures';

describe('documents flow: request, render, download, verify, revoke', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let studentId: string;
  let registrarId: string;
  let cashierId: string;
  let corDocumentId: string;
  let corSerialHash: string;

  beforeAll(async () => {
    test = await createTestApp();
    backbone = await createBackbone(test.prisma, test.clock.now());
    const student = await createStudent(test.prisma, backbone, {
      email: 'docs.student@test.dev',
      studentNo: 'TST-DOC-001',
      firstName: 'Dana',
      lastName: 'Diaz',
    });
    studentId = student.id;
    registrarId = (await createUser(test.prisma, { email: 'docs.registrar@test.dev', roles: ['REGISTRAR'] })).id;
    cashierId = (await createUser(test.prisma, { email: 'docs.cashier@test.dev', roles: ['CASHIER'] })).id;

    const instructor = await createUser(test.prisma, { email: 'docs.instructor@test.dev', roles: ['INSTRUCTOR'] });
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId: instructor.id,
      sectionCode: 'DOC-A',
      schedules: [{ dayOfWeek: 3, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    await enrollStudentDirect(test.prisma, {
      studentId,
      termId: backbone.term.id,
      sectionId: section.id,
      units: 3,
      at: test.clock.now(),
    });
  });

  afterAll(async () => {
    await test.close();
  });

  const studentToken = () => test.mintToken(studentId, ['STUDENT']);
  const registrarToken = () => test.mintToken(registrarId, ['REGISTRAR']);
  const registrarMfaToken = () => test.mintToken(registrarId, ['REGISTRAR'], { mfa: true });

  it('requests a COR, freezes a signed snapshot and renders it inline', async () => {
    const headers = { ...test.auth(studentToken()), 'idempotency-key': randomUUID() };
    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers,
      payload: { type: 'COR', termId: backbone.term.id },
    });
    expect(created.statusCode).toBe(201);
    const document = created.json();
    corDocumentId = document.id;
    expect(document.status).toBe('QUEUED');
    expect(document.serialNo).toMatch(/^SP-\d{4}-[0-9A-F]{16}$/);

    const replay = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers,
      payload: { type: 'COR', termId: backbone.term.id },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().id).toBe(corDocumentId);

    const detail = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${corDocumentId}`,
      headers: test.auth(studentToken()),
    });
    expect(detail.statusCode).toBe(200);
    const rendered = detail.json();
    expect(rendered.status).toBe('READY');
    expect(rendered.pageCount).toBeGreaterThanOrEqual(1);
    expect(rendered.fileSize).toBeGreaterThan(0);
    expect(rendered.storageKey).toBeUndefined();
    corSerialHash = rendered.serialHash;

    const row = await test.prisma.documentRequest.findUniqueOrThrow({ where: { id: corDocumentId } });
    expect(row.storageKey).toContain(studentId);
    expect(timingSafeEqualHex(row.signature!, hmacSha256Hex(test.config.documentHmacSecret, row.snapshotHash!))).toBe(true);
    expect(row.serialHash).toBe(sha256Hex(`${row.serialNo}|${row.signature}`));
    expect(row.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('downloads through a presigned URL, audits the access and rejects tampered links', async () => {
    const download = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${corDocumentId}/download`,
      headers: test.auth(studentToken()),
    });
    expect(download.statusCode).toBe(200);
    const { url, expiresInSeconds } = download.json();
    expect(expiresInSeconds).toBe(300);
    expect(url).toContain('/api/v1/documents/blob/documents%2F');
    expect(url).toContain('sig=');

    const pathWithQuery = url.replace(test.config.publicBaseUrl, '');
    const blob = await test.app.inject({ method: 'GET', url: pathWithQuery });
    expect(blob.statusCode).toBe(200);
    expect(blob.headers['content-type']).toContain('application/pdf');
    expect(blob.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(blob.rawPayload.length).toBeGreaterThan(1000);

    const afterDownload = await test.prisma.documentRequest.findUniqueOrThrow({ where: { id: corDocumentId } });
    expect(afterDownload.downloadCount).toBe(1);
    const event = await test.prisma.documentDownloadEvent.findFirst({ where: { documentId: corDocumentId } });
    expect(event).not.toBeNull();

    const tampered = pathWithQuery.replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64));
    const bad = await test.app.inject({ method: 'GET', url: tampered });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('UNSIGNED_DOCUMENT_URL');

    const parsed = new URL(url);
    const key = decodeURIComponent(parsed.pathname.replace('/api/v1/documents/blob/', ''));
    const expiredSig = FsPresign.sign(test.config.presignSecret, key, 1);
    const stale = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/blob/${encodeURIComponent(key)}?exp=1&sig=${expiredSig}`,
    });
    expect(stale.statusCode).toBe(410);
    expect(stale.json().code).toBe('DOCUMENT_EXPIRED');
  });

  it('verifies publicly by serial hash with minimal disclosure', async () => {
    const verify = await test.app.inject({ method: 'GET', url: `/api/v1/public/verify/${corSerialHash}` });
    expect(verify.statusCode).toBe(200);
    const body = verify.json();
    expect(body.valid).toBe(true);
    expect(body.documentType).toBe('COR');
    expect(body.status).toBe('READY');
    expect(body.studentName).toBe('Dana D.');
    expect(body.studentNoMasked).toBe('TST******01');
    expect(body.issuedAt).not.toBeNull();

    const unknown = await test.app.inject({ method: 'GET', url: `/api/v1/public/verify/${'a'.repeat(64)}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('blocks official documents on FINANCIAL holds until lifted', async () => {
    const studentAttempt = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers: { ...test.auth(studentToken()), 'idempotency-key': randomUUID() },
      payload: { type: 'TOR_OFFICIAL' },
    });
    expect(studentAttempt.statusCode).toBe(403);
    expect(studentAttempt.json().code).toBe('FORBIDDEN');

    const noStepUp = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers: { ...test.auth(registrarToken()), 'idempotency-key': randomUUID() },
      payload: { type: 'TOR_OFFICIAL', studentId },
    });
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().code).toBe('STEP_UP_REQUIRED');

    const hold = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/students/${studentId}/holds`,
      headers: test.auth(test.mintToken(cashierId, ['CASHIER'])),
      payload: { type: 'FINANCIAL', reason: 'Outstanding tuition balance' },
    });
    expect(hold.statusCode).toBe(201);

    const blocked = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers: { ...test.auth(registrarMfaToken()), 'idempotency-key': randomUUID() },
      payload: { type: 'TOR_OFFICIAL', studentId },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('STUDENT_CLEARANCE_HOLD');

    await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/holds/${hold.json().id}/lift`,
      headers: test.auth(test.mintToken(cashierId, ['CASHIER'])),
    });

    const allowed = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers: { ...test.auth(registrarMfaToken()), 'idempotency-key': randomUUID() },
      payload: { type: 'TOR_OFFICIAL', studentId, termId: backbone.term.id },
    });
    expect(allowed.statusCode).toBe(201);
    const torDocumentId = allowed.json().id as string;
    const detail = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${torDocumentId}`,
      headers: test.auth(registrarToken()),
    });
    expect(detail.json().status).toBe('READY');

    // BSL-007: a hold placed after issuance must also block the download.
    const reblock = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/students/${studentId}/holds`,
      headers: test.auth(test.mintToken(cashierId, ['CASHIER'])),
      payload: { type: 'FINANCIAL', reason: 'Download re-check regression' },
    });
    expect(reblock.statusCode).toBe(201);

    const downloadBlocked = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${torDocumentId}/download`,
      headers: test.auth(registrarToken()),
    });
    expect(downloadBlocked.statusCode).toBe(422);
    expect(downloadBlocked.json().code).toBe('STUDENT_CLEARANCE_HOLD');

    await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/holds/${reblock.json().id}/lift`,
      headers: test.auth(test.mintToken(cashierId, ['CASHIER'])),
    });

    const downloadAllowed = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${torDocumentId}/download`,
      headers: test.auth(registrarToken()),
    });
    expect(downloadAllowed.statusCode).toBe(200);
  });

  it('revokes a document: downloads stop and verification turns invalid immediately', async () => {
    const revoke = await test.app.inject({
      method: 'POST',
      url: `/api/v1/documents/requests/${corDocumentId}/revoke`,
      headers: test.auth(registrarToken()),
      payload: { reason: 'Issued with a wrong term snapshot' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe('REVOKED');

    const download = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${corDocumentId}/download`,
      headers: test.auth(studentToken()),
    });
    expect(download.statusCode).toBe(422);
    expect(download.json().code).toBe('DOCUMENT_REVOKED');

    const verify = await test.app.inject({ method: 'GET', url: `/api/v1/public/verify/${corSerialHash}` });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().valid).toBe(false);
    expect(verify.json().revokedAt).not.toBeNull();
  });

  it('re-renders FAILED documents from the frozen snapshot on retry', async () => {
    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers: { ...test.auth(studentToken()), 'idempotency-key': randomUUID() },
      payload: { type: 'CERT_ENROLLMENT', termId: backbone.term.id },
    });
    expect(created.statusCode).toBe(201);
    const documentId = created.json().id as string;

    // markFailed is a worker/system callback (no request frame in this test).
    await runWithSystem(() => test.services.documents.markFailed(documentId, 'simulated renderer crash'));
    const failed = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${documentId}`,
      headers: test.auth(studentToken()),
    });
    expect(failed.json().status).toBe('FAILED');

    const downloadWhileFailed = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${documentId}/download`,
      headers: test.auth(studentToken()),
    });
    expect(downloadWhileFailed.statusCode).toBe(409);
    expect(downloadWhileFailed.json().code).toBe('DOCUMENT_NOT_READY');

    const retry = await test.app.inject({
      method: 'POST',
      url: `/api/v1/documents/requests/${documentId}/retry`,
      headers: test.auth(registrarToken()),
    });
    expect(retry.statusCode).toBe(200);

    const after = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${documentId}`,
      headers: test.auth(studentToken()),
    });
    expect(after.json().status).toBe('READY');
    expect(after.json().snapshotHash).toBe(failed.json().snapshotHash);

    const auditActions = await test.prisma.auditLog.findMany({
      where: { resourceId: documentId, resourceType: 'document_request' },
      select: { action: true },
    });
    const actions = auditActions.map((row) => row.action);
    expect(actions).toContain('documents.requested');
    expect(actions).toContain('documents.render_failed');
    expect(actions).toContain('documents.retry');
  });
});
