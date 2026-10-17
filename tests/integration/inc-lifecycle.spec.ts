import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gradeEntryHash } from '../../src/modules/grading/ledger-hash';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  createBackbone,
  createSection,
  createStudent,
  createUser,
  enrollStudentDirect,
  type FixtureBackbone,
} from '../helpers/fixtures';

describe('INC lifecycle: completion and expiry sweep (BSL-304)', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let sectionId: string;
  let instructorId: string;
  let registrarId: string;
  let adminId: string;
  let studentComplete: string;
  let studentExpire: string;

  beforeAll(async () => {
    test = await createTestApp();
    const now = test.clock.now();
    backbone = await createBackbone(test.prisma, now, {
      term: {
        status: 'GRADING',
        gradingStartAt: new Date(now.getTime() - 86_400_000),
        gradingEndAt: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
    instructorId = (await createUser(test.prisma, { email: 'inc.instructor@test.dev', roles: ['INSTRUCTOR'] })).id;
    const chairId = (await createUser(test.prisma, { email: 'inc.chair@test.dev', roles: ['PROGRAM_CHAIR'] })).id;
    registrarId = (await createUser(test.prisma, { email: 'inc.registrar@test.dev', roles: ['REGISTRAR'] })).id;
    adminId = (await createUser(test.prisma, { email: 'inc.admin@test.dev', roles: ['ADMIN'] })).id;

    const sA = await createStudent(test.prisma, backbone, { email: 'inc.a@test.dev', studentNo: 'TST-INC-A' });
    const sB = await createStudent(test.prisma, backbone, { email: 'inc.b@test.dev', studentNo: 'TST-INC-B' });
    studentComplete = sA.id;
    studentExpire = sB.id;

    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'INC-A',
      maxCapacity: 10,
      schedules: [{ dayOfWeek: 4, startMin: 600, endMin: 660, roomId: backbone.room.id }],
    });
    sectionId = section.id;

    for (const studentId of [studentComplete, studentExpire]) {
      await enrollStudentDirect(test.prisma, {
        studentId,
        termId: backbone.term.id,
        sectionId,
        units: 3,
        at: now,
      });
    }

    const put = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/grading/sections/${sectionId}/sheet`,
      headers: test.auth(test.mintToken(instructorId, ['INSTRUCTOR'])),
      payload: {
        entries: [
          { studentId: studentComplete, mark: { kind: 'INC' } },
          { studentId: studentExpire, mark: { kind: 'INC' } },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const submit = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sections/${sectionId}/sheet/submit`,
      headers: test.auth(test.mintToken(instructorId, ['INSTRUCTOR'], { mfa: true })),
    });
    expect(submit.statusCode).toBe(200);

    const verify = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/verify`,
      headers: test.auth(test.mintToken(chairId, ['PROGRAM_CHAIR'])),
    });
    expect(verify.statusCode).toBe(200);

    const post = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/post`,
      headers: test.auth(test.mintToken(registrarId, ['REGISTRAR'], { mfa: true })),
    });
    expect(post.statusCode).toBe(200);
    expect(post.json().status).toBe('POSTED');
  });

  afterAll(async () => {
    await test.close();
  });

  const registrarToken = () => test.mintToken(registrarId, ['REGISTRAR'], { mfa: true });

  it('posted INC entries carry a 365-day deadline from the business clock', async () => {
    const entries = await test.prisma.gradeLedgerEntry.findMany({ where: { sectionId, status: 'POSTED' } });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.isInc).toBe(true);
      const deadlineDays = Math.round((entry.incDeadlineAt!.getTime() - test.clock.now().getTime()) / 86_400_000);
      expect(deadlineDays).toBe(365);
    }
  });

  it('completing an INC supersedes it with a hash-linked numeric version', async () => {
    const original = await test.prisma.gradeLedgerEntry.findFirstOrThrow({
      where: { sectionId, studentId: studentComplete, status: 'POSTED' },
    });

    const complete = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/inc/${original.id}/complete`,
      headers: test.auth(registrarToken()),
      payload: { value: '1.75' },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().supersededId).toBe(original.id);
    const replacement = complete.json().entry;
    expect(replacement.version).toBe(2);
    expect(replacement.value).toBe('1.75');
    expect(replacement.isInc).toBe(false);

    const recomputed = gradeEntryHash({
      prevHash: original.entryHash,
      studentId: original.studentId,
      courseId: original.courseId,
      termId: original.termId,
      sectionId: original.sectionId,
      mark: '1.75',
      version: 2,
      timestampIso: test.clock.now().toISOString(),
    });
    expect(replacement.entryHash).toBe(recomputed);
    expect(replacement.prevHash).toBe(original.entryHash);

    const old = await test.prisma.gradeLedgerEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(old.status).toBe('SUPERSEDED');

    const again = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/inc/${original.id}/complete`,
      headers: test.auth(registrarToken()),
      payload: { value: '2.00' },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe('GRADE_STATE_INVALID');

    const noMfa = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/inc/${await test.prisma.gradeLedgerEntry
        .findFirstOrThrow({ where: { sectionId, studentId: studentExpire, status: 'POSTED' } })
        .then((entry) => entry.id)}/complete`,
      headers: test.auth(test.mintToken(registrarId, ['REGISTRAR'])),
      payload: { value: '2.00' },
    });
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().code).toBe('STEP_UP_REQUIRED');
  });

  it('sweep ignores un-expired INCs and only converts after the deadline passes', async () => {
    const early = await test.app.inject({
      method: 'POST',
      url: '/api/v1/grading/inc/sweep',
      headers: test.auth(test.mintToken(adminId, ['ADMIN'])),
    });
    expect(early.statusCode).toBe(200);
    expect(early.json().converted).toHaveLength(0);

    test.clock.advanceMs(366 * 86_400_000);

    const expiredBeforeSweep = await test.prisma.gradeLedgerEntry.findFirstOrThrow({
      where: { sectionId, studentId: studentExpire, status: 'POSTED' },
    });
    expect(expiredBeforeSweep.isInc).toBe(true);
    expect(expiredBeforeSweep.incDeadlineAt!.getTime()).toBeLessThan(test.clock.now().getTime());

    const sweep = await test.app.inject({
      method: 'POST',
      url: '/api/v1/grading/inc/sweep',
      headers: test.auth(test.mintToken(adminId, ['ADMIN'])),
    });
    expect(sweep.statusCode).toBe(200);
    const converted = sweep.json().converted as Array<{ entryId: string; newEntryId: string }>;
    expect(converted).toHaveLength(1);
    expect(converted[0]!.entryId).toBe(expiredBeforeSweep.id);

    const defaulter = await test.prisma.gradeLedgerEntry.findUniqueOrThrow({ where: { id: converted[0]!.newEntryId } });
    expect(defaulter.value!.toString()).toBe('5');
    expect(defaulter.isInc).toBe(false);
    expect(defaulter.version).toBe(2);
    expect(defaulter.prevHash).toBe(expiredBeforeSweep.entryHash);
    expect(defaulter.incDeadlineAt).toBeNull();

    const systemAudit = await test.prisma.auditLog.findFirst({
      where: { action: 'grading.inc.expired_converted', resourceId: defaulter.id },
    });
    expect(systemAudit).not.toBeNull();
    expect(systemAudit!.actorId).toBeNull();

    const secondSweep = await test.app.inject({
      method: 'POST',
      url: '/api/v1/grading/inc/sweep',
      headers: test.auth(test.mintToken(adminId, ['ADMIN'])),
    });
    expect(secondSweep.json().converted).toHaveLength(0);

    const stillCompleted = await test.prisma.gradeLedgerEntry.findFirstOrThrow({
      where: { sectionId, studentId: studentComplete, status: 'POSTED' },
    });
    expect(stillCompleted.value!.toString()).toBe('1.75');
    expect(stillCompleted.isInc).toBe(false);

    const gwa = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${studentExpire}/gwa`,
      headers: test.auth(test.mintToken(adminId, ['ADMIN'])),
    });
    expect(gwa.statusCode).toBe(200);
    expect(gwa.json().cumulativeGwa).toBe('5.0000');
    expect(gwa.json().standing).toBe('PROBATION');
  });
});
