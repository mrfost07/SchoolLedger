import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gradeEntryHash, markToString } from '../../src/modules/grading/ledger-hash';
import { markFromEntry } from '../../src/modules/grading/state-machine';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  createBackbone,
  createSection,
  createStudent,
  createUser,
  enrollStudentDirect,
  type FixtureBackbone,
} from '../helpers/fixtures';

describe('grading flow: sheet lifecycle, ledger immutability, rectification, GWA', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let sectionId: string;
  let instructorId: string;
  let otherInstructorId: string;
  let chairId: string;
  let registrarId: string;
  let student1: string;
  let student2: string;
  let student3: string;
  let enrollmentItemIds: Record<string, string>;

  const entries = () =>
    [
      { studentId: student1, mark: { kind: 'NUMERIC', value: '1.50' } },
      { studentId: student2, mark: { kind: 'NUMERIC', value: '2.00' } },
      { studentId: student3, mark: { kind: 'INC' } },
    ] as const;

  beforeAll(async () => {
    test = await createTestApp();
    const now = test.clock.now();
    backbone = await createBackbone(test.prisma, now, {
      term: {
        status: 'GRADING',
        gradingStartAt: new Date(now.getTime() - 86_400_000),
        gradingEndAt: new Date(now.getTime() + 10 * 86_400_000),
      },
    });
    instructorId = (await createUser(test.prisma, { email: 'grade.instructor@test.dev', roles: ['INSTRUCTOR'] })).id;
    otherInstructorId = (await createUser(test.prisma, { email: 'grade.other@test.dev', roles: ['INSTRUCTOR'] })).id;
    chairId = (await createUser(test.prisma, { email: 'grade.chair@test.dev', roles: ['PROGRAM_CHAIR'] })).id;
    registrarId = (await createUser(test.prisma, { email: 'grade.registrar@test.dev', roles: ['REGISTRAR'] })).id;

    const s1 = await createStudent(test.prisma, backbone, { email: 'g1@test.dev', studentNo: 'TST-G1' });
    const s2 = await createStudent(test.prisma, backbone, { email: 'g2@test.dev', studentNo: 'TST-G2' });
    const s3 = await createStudent(test.prisma, backbone, { email: 'g3@test.dev', studentNo: 'TST-G3' });
    student1 = s1.id;
    student2 = s2.id;
    student3 = s3.id;

    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'GRADE-A',
      maxCapacity: 10,
      schedules: [{ dayOfWeek: 1, startMin: 600, endMin: 660, roomId: backbone.room.id }],
    });
    sectionId = section.id;

    enrollmentItemIds = {};
    for (const [studentId, id] of [
      [student1, 'one'],
      [student2, 'two'],
      [student3, 'three'],
    ] as const) {
      const item = await enrollStudentDirect(test.prisma, {
        studentId,
        termId: backbone.term.id,
        sectionId,
        units: 3,
        at: test.clock.now(),
      });
      enrollmentItemIds[id] = item.id;
    }
  });

  afterAll(async () => {
    await test.close();
  });

  const instructor = (mfa = false) => test.mintToken(instructorId, ['INSTRUCTOR'], { mfa });
  const registrar = (mfa = false) => test.mintToken(registrarId, ['REGISTRAR'], { mfa });

  it('rejects a foreign instructor touching the sheet', async () => {
    const response = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/grading/sections/${sectionId}/sheet`,
      headers: test.auth(test.mintToken(otherInstructorId, ['INSTRUCTOR'])),
      payload: { entries: entries() },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FORBIDDEN');
  });

  it('runs the full lifecycle DRAFT -> SUBMITTED -> returned -> VERIFIED -> POSTED', async () => {
    const draft = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/grading/sections/${sectionId}/sheet`,
      headers: test.auth(instructor()),
      payload: { entries: entries() },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().status).toBe('DRAFT');
    expect(draft.json().entries).toHaveLength(3);

    const noMfa = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sections/${sectionId}/sheet/submit`,
      headers: test.auth(instructor()),
    });
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().code).toBe('STEP_UP_REQUIRED');

    const submitted = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sections/${sectionId}/sheet/submit`,
      headers: test.auth(instructor(true)),
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe('SUBMITTED');

    const returned = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/return`,
      headers: test.auth(test.mintToken(chairId, ['PROGRAM_CHAIR'])),
      payload: { note: 'One grade looks transposed, please double check.' },
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().status).toBe('DRAFT');
    expect(returned.json().submittedById).toBeNull();

    const redraft = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/grading/sections/${sectionId}/sheet`,
      headers: test.auth(instructor()),
      payload: { entries: entries() },
    });
    expect(redraft.statusCode).toBe(200);

    const resubmitted = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sections/${sectionId}/sheet/submit`,
      headers: test.auth(instructor(true)),
    });
    expect(resubmitted.statusCode).toBe(200);
    expect(resubmitted.json().status).toBe('SUBMITTED');

    const instructorVerify = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/verify`,
      headers: test.auth(instructor(true)),
    });
    expect(instructorVerify.statusCode).toBe(403);

    const verified = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/verify`,
      headers: test.auth(test.mintToken(chairId, ['PROGRAM_CHAIR'])),
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe('VERIFIED');

    const postNoMfa = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/post`,
      headers: test.auth(registrar()),
    });
    expect(postNoMfa.statusCode).toBe(403);
    expect(postNoMfa.json().code).toBe('STEP_UP_REQUIRED');

    const posted = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/post`,
      headers: test.auth(registrar(true)),
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().status).toBe('POSTED');

    const repost = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/sheets/${sectionId}/post`,
      headers: test.auth(registrar(true)),
    });
    expect(repost.statusCode).toBe(422);
    expect(repost.json().code).toBe('GRADE_STATE_INVALID');

    const lateEdit = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/grading/sections/${sectionId}/sheet`,
      headers: test.auth(instructor()),
      payload: { entries: entries() },
    });
    expect(lateEdit.statusCode).toBe(422);
    expect(lateEdit.json().code).toBe('GRADE_STATE_INVALID');
  });

  it('ledger entries are hash-chained, verifiable and frozen by the database trigger', async () => {
    const ledger = await test.prisma.gradeLedgerEntry.findMany({
      where: { sectionId, status: 'POSTED' },
    });
    expect(ledger).toHaveLength(3);

    for (const entry of ledger) {
      expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.version).toBe(1);
      const recomputed = gradeEntryHash({
        prevHash: entry.prevHash,
        studentId: entry.studentId,
        courseId: entry.courseId,
        termId: entry.termId,
        sectionId: entry.sectionId,
        mark: markToString(markFromEntry(entry)),
        version: entry.version,
        timestampIso: test.clock.now().toISOString(),
      });
      expect(recomputed).toBe(entry.entryHash);
    }

    const incEntry = ledger.find((entry) => entry.isInc);
    expect(incEntry).toBeDefined();
    expect(incEntry!.value).toBeNull();
    expect(incEntry!.incDeadlineAt).not.toBeNull();
    const deadlineDays = Math.round((incEntry!.incDeadlineAt!.getTime() - test.clock.now().getTime()) / 86_400_000);
    expect(deadlineDays).toBe(365);

    const target = ledger.find((entry) => !entry.isInc)!;
    await expect(
      test.prisma.gradeLedgerEntry.update({ where: { id: target.id }, data: { value: '1.25' } }),
    ).rejects.toThrow(/immutable/);
    await expect(test.prisma.gradeLedgerEntry.delete({ where: { id: target.id } })).rejects.toThrow(/append-only/);

    const ledgerResponse = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${student1}/ledger`,
      headers: test.auth(test.mintToken(student1, ['STUDENT'])),
    });
    expect(ledgerResponse.statusCode).toBe(200);
    expect(ledgerResponse.json()).toHaveLength(1);
    expect(ledgerResponse.json()[0].course.code).toBe('T101');

    const forbidden = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${student2}/ledger`,
      headers: test.auth(test.mintToken(student1, ['STUDENT'])),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('reports GWA excluding INC and derives standing', async () => {
    const report = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${student1}/gwa`,
      headers: test.auth(test.mintToken(student1, ['STUDENT'])),
    });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.terms).toHaveLength(1);
    expect(body.terms[0].gwa).toBe('1.5000');
    expect(body.terms[0].incCount).toBe(0);
    expect(body.cumulativeGwa).toBe('1.5000');
    expect(body.totalUnits).toBe(3);
    expect(body.standing).toBe('GOOD_STANDING');
    expect(body.latinHonors).toBe('CUM_LAUDE');

    const incStudent = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${student3}/gwa`,
      headers: test.auth(test.mintToken(student3, ['STUDENT'])),
    });
    expect(incStudent.json().terms[0].gwa).toBeNull();
    expect(incStudent.json().terms[0].incCount).toBe(1);
  });

  it('rectification supersedes the posted entry with a hash-linked version 2', async () => {
    const original = await test.prisma.gradeLedgerEntry.findFirstOrThrow({
      where: { sectionId, studentId: student1, status: 'POSTED' },
    });

    const request = await test.app.inject({
      method: 'POST',
      url: '/api/v1/grading/rectifications',
      headers: test.auth(instructor()),
      payload: {
        entryId: original.id,
        proposedValue: '1.25',
        reason: 'Encoding error: the class record shows 1.25, not 1.50.',
      },
    });
    expect(request.statusCode).toBe(201);
    const rectificationId = request.json().id as string;
    expect(request.json().status).toBe('PENDING');

    const duplicate = await test.app.inject({
      method: 'POST',
      url: '/api/v1/grading/rectifications',
      headers: test.auth(instructor()),
      payload: { entryId: original.id, proposedValue: '1.00', reason: 'Another attempt while one is open.' },
    });
    expect(duplicate.statusCode).toBe(409);

    const approveTooEarly = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/rectifications/${rectificationId}/approve`,
      headers: test.auth(registrar(true)),
      payload: {},
    });
    expect(approveTooEarly.statusCode).toBe(422);
    expect(approveTooEarly.json().code).toBe('RECTIFICATION_INVALID_STATE');

    const endorse = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/rectifications/${rectificationId}/endorse`,
      headers: test.auth(test.mintToken(chairId, ['PROGRAM_CHAIR'])),
      payload: { note: 'Verified against the class record.' },
    });
    expect(endorse.statusCode).toBe(200);
    expect(endorse.json().status).toBe('CHAIR_ENDORSED');

    const approveNoMfa = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/rectifications/${rectificationId}/approve`,
      headers: test.auth(registrar()),
      payload: {},
    });
    expect(approveNoMfa.statusCode).toBe(403);

    const approve = await test.app.inject({
      method: 'POST',
      url: `/api/v1/grading/rectifications/${rectificationId}/approve`,
      headers: test.auth(registrar(true)),
      payload: { note: 'Approved.' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().rectification.status).toBe('APPROVED');
    const newEntryId = approve.json().newEntryId as string;
    expect(newEntryId).not.toBe(original.id);

    const oldEntry = await test.prisma.gradeLedgerEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(oldEntry.status).toBe('SUPERSEDED');

    const newEntry = await test.prisma.gradeLedgerEntry.findUniqueOrThrow({ where: { id: newEntryId } });
    expect(newEntry.status).toBe('POSTED');
    expect(newEntry.version).toBe(2);
    expect(newEntry.value!.toString()).toBe('1.25');
    expect(newEntry.prevHash).toBe(original.entryHash);
    expect(newEntry.entryHash).not.toBe(original.entryHash);

    const recomputed = gradeEntryHash({
      prevHash: newEntry.prevHash,
      studentId: newEntry.studentId,
      courseId: newEntry.courseId,
      termId: newEntry.termId,
      sectionId: newEntry.sectionId,
      mark: markToString(markFromEntry(newEntry)),
      version: newEntry.version,
      timestampIso: test.clock.now().toISOString(),
    });
    expect(recomputed).toBe(newEntry.entryHash);

    const ledgerResponse = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${student1}/ledger`,
      headers: test.auth(test.mintToken(student1, ['STUDENT'])),
    });
    const rows = ledgerResponse.json() as Array<{ status: string; version: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['POSTED', 'SUPERSEDED']);

    const report = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${student1}/gwa`,
      headers: test.auth(test.mintToken(student1, ['STUDENT'])),
    });
    expect(report.json().cumulativeGwa).toBe('1.2500');
    expect(report.json().latinHonors).toBe('MAGNA_CUM_LAUDE');
  });
});
