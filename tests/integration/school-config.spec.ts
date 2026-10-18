import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  createBackbone,
  createSection,
  createStudent,
  createUser,
  TEST_SCHOOL2_ID,
  TEST_SCHOOL_ID,
  type FixtureBackbone,
} from '../helpers/fixtures';

describe('school configuration surface (Phase 1b)', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let adminId: string;
  let admin2Id: string;
  let instructorId: string;
  let studentId: string;
  let student2Id: string;
  let sectionId: string;

  beforeAll(async () => {
    test = await createTestApp();
    const now = test.clock.now();
    backbone = await createBackbone(test.prisma, now);
    adminId = (await createUser(test.prisma, { email: 'school.admin@test.dev', roles: ['ADMIN'] })).id;
    admin2Id = (
      await createUser(test.prisma, { email: 'school.admin2@test.dev', roles: ['ADMIN'], schoolId: TEST_SCHOOL2_ID })
    ).id;
    instructorId = (await createUser(test.prisma, { email: 'school.inst@test.dev', roles: ['INSTRUCTOR'] })).id;
    studentId = (await createStudent(test.prisma, backbone, { email: 'school.student@test.dev', studentNo: 'SCH-001' })).id;
    student2Id = (await createStudent(test.prisma, backbone, { email: 'school.student2@test.dev', studentNo: 'SCH-002' })).id;

    sectionId = (
      await createSection(test.prisma, {
        termId: backbone.term.id,
        courseId: backbone.courses.T101!.id,
        instructorId,
        sectionCode: 'SCH-A',
        maxCapacity: 10,
        schedules: [{ dayOfWeek: 2, startMin: 480, endMin: 540, roomId: backbone.room.id }],
      })
    ).id;
  });

  afterAll(async () => {
    await test.close();
  });

  const adminToken = () => test.auth(test.mintToken(adminId, ['ADMIN']));
  const admin2Token = () => test.auth(test.mintToken(admin2Id, ['ADMIN'], { schoolId: TEST_SCHOOL2_ID }));
  const studentToken = () => test.auth(test.mintToken(studentId, ['STUDENT']));

  const getSchool = (headers: Record<string, string>) =>
    test.app.inject({ method: 'GET', url: '/api/v1/school', headers });
  const patchSchool = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    test.app.inject({ method: 'PATCH', url: '/api/v1/school', headers, payload });
  const patchPolicy = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    test.app.inject({ method: 'PATCH', url: '/api/v1/school/policies', headers, payload });
  const reserve = (student: string, key: string = randomUUID()) =>
    test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers: { ...test.auth(test.mintToken(student, ['STUDENT'])), 'idempotency-key': key },
      payload: { termId: backbone.term.id, sectionIds: [sectionId] },
    });

  it('students can read the school profile with env-default policy', async () => {
    const res = await getSchool(studentToken());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.school.code).toBe('MAIN');
    expect(body.school.name).toBe('Main Campus');
    expect(body.policySource).toBe('env');
    expect(body.policy.maxAcademicUnits).toBe(30);
    expect(body.policy.currency).toBe('PHP');
    expect(body.policy.honorsSummaMax).toBe('1.20');
    expect(body.policy.incCompletionDays).toBe(365);
  });

  it('students cannot update profile or policy', async () => {
    const profile = await patchSchool(studentToken(), { name: 'Hacked Campus' });
    expect(profile.statusCode).toBe(403);
    const policy = await patchPolicy(studentToken(), { maxAcademicUnits: 1 });
    expect(policy.statusCode).toBe(403);
    const school = await test.prisma.school.findUnique({ where: { id: TEST_SCHOOL_ID } });
    expect(school!.name).toBe('Main Campus');
  });

  it('admin can update profile and branding; the change is audited', async () => {
    const res = await patchSchool(adminToken(), {
      name: 'Main Campus (Updated)',
      address: '1 Config Way, Manila',
      contactEmail: 'hello@main.test.dev',
      brandColor: '#1d4ed8',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.school.name).toBe('Main Campus (Updated)');
    expect(body.school.address).toBe('1 Config Way, Manila');
    expect(body.school.brandColor).toBe('#1d4ed8');
    expect(body.policySource).toBe('env');

    const visible = await getSchool(studentToken());
    expect(visible.json().school.name).toBe('Main Campus (Updated)');

    const audits = await test.prisma.auditLog.findMany({
      where: { schoolId: TEST_SCHOOL_ID, action: 'school.profile.updated' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(adminId);
  });

  it('admin can update the academic policy; it becomes the policy source', async () => {
    const res = await patchPolicy(adminToken(), { maxAcademicUnits: 33, deansListerMaxGwa: '1.50' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policySource).toBe('school');
    expect(body.policy.maxAcademicUnits).toBe(33);
    expect(body.policy.deansListerMaxGwa).toBe('1.50');
    expect(body.policy.currency).toBe('PHP');

    const row = await test.prisma.schoolPolicy.findUnique({ where: { schoolId: TEST_SCHOOL_ID } });
    expect(row!.maxAcademicUnits).toBe(33);
    expect(row!.deansListerMaxGwa.toFixed(2)).toBe('1.50');

    const audits = await test.prisma.auditLog.findMany({
      where: { schoolId: TEST_SCHOOL_ID, action: 'school.policy.updated' },
    });
    expect(audits).toHaveLength(1);
  });

  it('a lowered unit limit blocks overload with the policy-driven error', async () => {
    const lowered = await patchPolicy(adminToken(), { maxAcademicUnits: 2 });
    expect(lowered.statusCode).toBe(200);

    const blocked = await reserve(studentId);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('MAX_UNITS_EXCEEDED');
    expect(blocked.json().meta.limit).toBe(2);

    const restored = await patchPolicy(adminToken(), { maxAcademicUnits: 30 });
    expect(restored.statusCode).toBe(200);

    const reserved = await reserve(studentId);
    expect(reserved.statusCode).toBe(201);
    expect(reserved.json().items).toHaveLength(1);
  });

  it('currency flows into the immutable fee snapshot', async () => {
    const updated = await patchPolicy(adminToken(), { currency: 'USD' });
    expect(updated.statusCode).toBe(200);

    const reserved = await reserve(student2Id);
    expect(reserved.statusCode).toBe(201);
    expect(reserved.json().assessment.breakdown.currency).toBe('USD');

    const stored = await test.prisma.tuitionAssessment.findFirst({
      where: { enrollment: { studentId: student2Id } },
      orderBy: { computedAt: 'desc' },
    });
    expect(stored!.currency).toBe('USD');

    const restored = await patchPolicy(adminToken(), { currency: 'PHP' });
    expect(restored.statusCode).toBe(200);
  });

  it('policy changes are per-school isolated', async () => {
    const res = await patchPolicy(admin2Token(), { maxAcademicUnits: 12 });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.maxAcademicUnits).toBe(12);

    const northRow = await test.prisma.schoolPolicy.findUnique({ where: { schoolId: TEST_SCHOOL2_ID } });
    expect(northRow!.maxAcademicUnits).toBe(12);

    const mainRow = await test.prisma.schoolPolicy.findUnique({ where: { schoolId: TEST_SCHOOL_ID } });
    expect(mainRow!.maxAcademicUnits).toBe(30);

    const mainView = await getSchool(studentToken());
    expect(mainView.json().policy.maxAcademicUnits).toBe(30);

    const northAudits = await test.prisma.auditLog.findMany({
      where: { schoolId: TEST_SCHOOL2_ID, action: 'school.policy.updated' },
    });
    expect(northAudits).toHaveLength(1);
  });
});
