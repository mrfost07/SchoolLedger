import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  createBackbone,
  createSection,
  createStudent,
  createUser,
  openTermWindow,
  TEST_SCHOOL_ID,
  type FixtureBackbone,
} from '../helpers/fixtures';

describe('enrollment flow', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let instructorId: string;
  let aliceId: string;
  let bobId: string;
  let cashierId: string;

  beforeAll(async () => {
    test = await createTestApp();
    backbone = await createBackbone(test.prisma, test.clock.now());
    const instructor = await createUser(test.prisma, { email: 'flow.instructor@test.dev', roles: ['INSTRUCTOR'] });
    instructorId = instructor.id;
    const cashier = await createUser(test.prisma, { email: 'flow.cashier@test.dev', roles: ['CASHIER'] });
    cashierId = cashier.id;
    aliceId = (await createStudent(test.prisma, backbone, { email: 'alice@test.dev', studentNo: 'TST-A-001' })).id;
    bobId = (await createStudent(test.prisma, backbone, { email: 'bob@test.dev', studentNo: 'TST-B-001' })).id;
  });

  afterAll(async () => {
    await test.close();
  });

  const reserve = (studentId: string, termId: string, sectionIds: string[], extra: Record<string, unknown> = {}) =>
    test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers: { ...test.auth(test.mintToken(studentId, ['STUDENT'])), 'idempotency-key': randomUUID() },
      payload: { termId, sectionIds, ...extra },
    });

  it('reports curriculum eligibility with missing prerequisites', async () => {
    const response = await test.app.inject({
      method: 'GET',
      url: `/api/v1/enrollments/eligibility?termId=${backbone.term.id}`,
      headers: test.auth(test.mintToken(aliceId, ['STUDENT'])),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    const eligibleCodes = body.eligible.map((course: { code: string }) => course.code).sort();
    expect(eligibleCodes).toEqual(['T101', 'T102', 'T104']);

    const blocked = body.blocked.find((course: { code: string }) => course.code === 'T103');
    expect(blocked).toBeDefined();
    expect(blocked.reason).toBe('MISSING_PREREQUISITES');
    expect(blocked.missingPrerequisites[0].code).toBe('T102');

    const unlock = body.eligible.find((course: { code: string }) => course.code === 'T102');
    expect(unlock.unlocksCount).toBe(1);
  });

  it('reserves a section, computes the immutable assessment, and replays idempotently', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'FLOW-T101-A',
      maxCapacity: 40,
      schedules: [{ dayOfWeek: 1, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    const key = randomUUID();
    const headers = { ...test.auth(test.mintToken(aliceId, ['STUDENT'])), 'idempotency-key': key };

    const first = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers,
      payload: { termId: backbone.term.id, sectionIds: [section.id] },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].status).toBe('ENROLLED');
    expect(body.items[0].unitsAtReservation).toBe('3');
    expect(body.assessment).not.toBeNull();
    expect(body.assessment.totalAmount).toBe('2500');
    expect(body.assessment.breakdown.units).toEqual({ lecture: 3, lab: 0, total: 3 });
    expect(body.assessment.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const replay = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers,
      payload: { termId: backbone.term.id, sectionIds: [section.id] },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().enrollment.id).toBe(body.enrollment.id);

    const counter = await test.prisma.section.findUniqueOrThrow({ where: { id: section.id } });
    expect(counter.enrolledCount).toBe(1);

    const readBack = await test.app.inject({
      method: 'GET',
      url: `/api/v1/enrollments?termId=${backbone.term.id}`,
      headers: test.auth(test.mintToken(aliceId, ['STUDENT'])),
    });
    expect(readBack.statusCode).toBe(200);
    expect(readBack.json().items).toHaveLength(1);
    expect(readBack.json().assessment.status).toBe('ASSESSED');
  });

  it('marks an assessment PAID once under concurrent payment and audits once', async () => {
    const enrollment = await test.prisma.enrollment.findFirstOrThrow({
      where: { studentId: aliceId, termId: backbone.term.id },
    });
    const assessment = await test.prisma.tuitionAssessment.findUniqueOrThrow({ where: { enrollmentId: enrollment.id } });
    expect(assessment.status).toBe('ASSESSED');

    const token = test.mintToken(cashierId, ['CASHIER']);
    const pay = () =>
      test.app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/assessments/${assessment.id}/pay`,
        headers: test.auth(token),
      });
    const [p1, p2] = await Promise.all([pay(), pay()]);
    expect(p1.statusCode, p1.body).toBe(200);
    expect(p2.statusCode, p2.body).toBe(200);

    const paid = await test.prisma.tuitionAssessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).not.toBeNull();

    const audits = await test.prisma.auditLog.count({
      where: { action: 'enrollment.assessment.paid', resourceId: assessment.id },
    });
    expect(audits).toBe(1);
  });

  it('rejects duplicate reservations, missing idempotency keys and same-course double booking', async () => {
    const sectionA = await test.prisma.section.findFirstOrThrow({ where: { sectionCode: 'FLOW-T101-A' } });
    const sectionB = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'FLOW-T101-B',
      schedules: [{ dayOfWeek: 5, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });

    const missingKey = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers: test.auth(test.mintToken(aliceId, ['STUDENT'])),
      payload: { termId: backbone.term.id, sectionIds: [sectionA.id] },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const duplicate = await reserve(aliceId, backbone.term.id, [sectionA.id]);
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json().code).toBe('ALREADY_ENROLLED');

    const sameCourse = await reserve(aliceId, backbone.term.id, [sectionA.id, sectionB.id]);
    expect(sameCourse.statusCode).toBe(400);
    expect(sameCourse.json().code).toBe('VALIDATION_FAILED');
  });

  it('blocks reservation when the enrollment window is closed', async () => {
    const window = openTermWindow(test.clock.now());
    const closedTerm = await test.prisma.academicTerm.create({
      data: {
        schoolId: backbone.schoolId,
        code: 'TST-CLOSED',
        schoolYear: 2026,
        termNo: 2,
        status: 'PLANNING',
        ...window,
        enrollmentStartAt: new Date(test.clock.now().getTime() + 7 * 86_400_000),
      },
    });
    const section = await test.prisma.section.findFirstOrThrow({ where: { sectionCode: 'FLOW-T101-A' } });
    const response = await reserve(aliceId, closedTerm.id, [section.id]);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('ENROLLMENT_WINDOW_CLOSED');
  });

  it('student holds block reservation until lifted', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T102!.id,
      instructorId,
      sectionCode: 'FLOW-T102-A',
      schedules: [{ dayOfWeek: 2, startMin: 600, endMin: 660, roomId: backbone.room.id }],
    });

    const hold = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/students/${bobId}/holds`,
      headers: test.auth(test.mintToken(cashierId, ['CASHIER'])),
      payload: { type: 'FINANCIAL', reason: 'Unpaid balance from previous term' },
    });
    expect(hold.statusCode).toBe(201);
    const holdId = hold.json().id as string;

    const blocked = await reserve(bobId, backbone.term.id, [section.id]);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('STUDENT_CLEARANCE_HOLD');

    const lift = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/holds/${holdId}/lift`,
      headers: test.auth(test.mintToken(cashierId, ['CASHIER'])),
    });
    expect(lift.statusCode).toBe(200);

    const allowed = await reserve(bobId, backbone.term.id, [section.id]);
    expect(allowed.statusCode).toBe(201);
  });

  it('students cannot use the overload override', async () => {
    const section = await test.prisma.section.findFirstOrThrow({ where: { sectionCode: 'FLOW-T101-B' } });
    const response = await reserve(bobId, backbone.term.id, [section.id], { allowOverload: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FORBIDDEN');
  });

  it('frees a slot on drop and auto-promotes the FIFO waitlist inline', async () => {
    const carol = await createStudent(test.prisma, backbone, { email: 'carol@test.dev', studentNo: 'TST-C-001' });
    const dave = await createStudent(test.prisma, backbone, { email: 'dave@test.dev', studentNo: 'TST-D-001' });

    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T104!.id,
      instructorId,
      sectionCode: 'FLOW-T104-A',
      maxCapacity: 1,
      schedules: [{ dayOfWeek: 3, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });

    const carolReserve = await reserve(carol.id, backbone.term.id, [section.id]);
    expect(carolReserve.statusCode).toBe(201);
    const carolItemId = carolReserve.json().items[0].id as string;

    const daveWaitlist = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/waitlist',
      headers: test.auth(test.mintToken(dave.id, ['STUDENT'])),
      payload: { termId: backbone.term.id, sectionId: section.id },
    });
    expect(daveWaitlist.statusCode).toBe(201);
    expect(daveWaitlist.json().status).toBe('WAITLISTED');

    const daveDirect = await reserve(dave.id, backbone.term.id, [section.id]);
    expect(daveDirect.statusCode).toBe(422);
    expect(['SECTION_FULL', 'ALREADY_ENROLLED']).toContain(daveDirect.json().code);

    const drop = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/drop',
      headers: test.auth(test.mintToken(carol.id, ['STUDENT'])),
      payload: { itemId: carolItemId },
    });
    expect(drop.statusCode).toBe(200);
    expect(drop.json().item.status).toBe('DROPPED');
    expect(drop.json().promoted).toBe(true);

    const daveItem = await test.prisma.enrollmentItem.findFirstOrThrow({
      where: { sectionId: section.id, enrollment: { studentId: dave.id } },
    });
    expect(daveItem.status).toBe('ENROLLED');

    const sectionState = await test.prisma.section.findUniqueOrThrow({ where: { id: section.id } });
    expect(sectionState.enrolledCount).toBe(1);
    expect(sectionState.waitlistCount).toBe(0);
  });

  it('reclaims an idempotency key whose TTL elapsed instead of blocking it forever', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'FLOW-T101-EXP',
      schedules: [{ dayOfWeek: 7, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    const erin = await createStudent(test.prisma, backbone, { email: 'erin@test.dev', studentNo: 'TST-E-001' });
    const token = test.mintToken(erin.id, ['STUDENT']);
    const key = randomUUID();
    const headers = { ...test.auth(token), 'idempotency-key': key };

    const first = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers,
      payload: { termId: backbone.term.id, sectionIds: [section.id] },
    });
    expect(first.statusCode).toBe(201);

    const row = await test.prisma.idempotencyKey.findUniqueOrThrow({
      where: { schoolId_userId_key: { schoolId: TEST_SCHOOL_ID, userId: erin.id, key } },
    });
    expect(row.state).toBe('COMPLETED');
    await test.prisma.idempotencyKey.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // Different body => different request hash. If the dead row were still
    // honored this would 409 IDEMPOTENCY_KEY_REUSED; instead it must be reaped
    // and the request executed for real (and fail on the duplicate enrollment).
    const afterExpiry = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers,
      payload: { termId: backbone.term.id, sectionIds: [section.id], allowOverload: false },
    });
    expect(afterExpiry.statusCode).toBe(422);
    expect(afterExpiry.json().code).toBe('ALREADY_ENROLLED');

    const recreated = await test.prisma.idempotencyKey.findUnique({
      where: { schoolId_userId_key: { schoolId: TEST_SCHOOL_ID, userId: erin.id, key } },
    });
    expect(recreated).toBeNull();
  });

  it('nobody can drop someone else\u2019s item', async () => {
    const aliceItem = await test.prisma.enrollmentItem.findFirstOrThrow({
      where: { enrollment: { studentId: aliceId }, status: 'ENROLLED' },
    });
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/drop',
      headers: test.auth(test.mintToken(bobId, ['STUDENT'])),
      payload: { itemId: aliceItem.id },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FORBIDDEN');
  });
});
