import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { createBackbone, createBulkStudents, createSection, createUser, type FixtureBackbone } from '../helpers/fixtures';

const RUSH_STUDENTS = 50;
const SECTION_CAPACITY = 5;

describe('enrollment race (INV-1: capacity can never be exceeded)', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let instructorId: string;

  beforeAll(async () => {
    test = await createTestApp();
    backbone = await createBackbone(test.prisma, test.clock.now());
    const instructor = await createUser(test.prisma, { email: 'race-instructor@test.dev', roles: ['INSTRUCTOR'] });
    instructorId = instructor.id;
  });

  afterAll(async () => {
    await test.close();
  });

  it('50 concurrent reservations against a cap-5 section produce exactly 5 enrollments', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'RACE-5',
      maxCapacity: SECTION_CAPACITY,
      schedules: [{ dayOfWeek: 1, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });

    const students = await createBulkStudents(test.prisma, backbone, RUSH_STUDENTS, 'race');
    expect(students).toHaveLength(RUSH_STUDENTS);

    const barrier = { resolve: undefined as (() => void) | undefined };
    const gate = new Promise<void>((resolve) => {
      barrier.resolve = resolve;
    });

    const attempts = students.map(async (student) => {
      const token = test.mintToken(student.id, ['STUDENT']);
      await gate;
      const response = await test.app.inject({
        method: 'POST',
        url: '/api/v1/enrollments/reserve',
        headers: { ...test.auth(token), 'idempotency-key': randomUUID() },
        payload: { termId: backbone.term.id, sectionIds: [section.id] },
      });
      return response;
    });
    barrier.resolve!();
    const responses = await Promise.all(attempts);

    const created = responses.filter((r) => r.statusCode === 201);
    const rejected = responses.filter((r) => r.statusCode !== 201);
    expect(created).toHaveLength(SECTION_CAPACITY);
    expect(rejected).toHaveLength(RUSH_STUDENTS - SECTION_CAPACITY);
    for (const response of rejected) {
      expect([409, 422]).toContain(response.statusCode);
    }
    expect(rejected.filter((r) => r.json().code === 'SECTION_FULL').length).toBeGreaterThan(0);

    const persisted = await test.prisma.section.findUniqueOrThrow({ where: { id: section.id } });
    expect(persisted.enrolledCount).toBe(SECTION_CAPACITY);

    const enrolledItems = await test.prisma.enrollmentItem.findMany({
      where: { sectionId: section.id, status: 'ENROLLED' },
    });
    expect(enrolledItems).toHaveLength(SECTION_CAPACITY);
    const uniqueStudents = new Set(enrolledItems.map((item) => item.enrollmentId));
    expect(uniqueStudents.size).toBe(SECTION_CAPACITY);

    const enrollmentIds = [...uniqueStudents];
    const enrollments = await test.prisma.enrollment.findMany({ where: { id: { in: enrollmentIds } } });
    expect(new Set(enrollments.map((e) => e.studentId)).size).toBe(SECTION_CAPACITY);

    for (const response of created) {
      const body = response.json();
      expect(body.enrollment.status).toBe('ENROLLED');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].sectionId).toBe(section.id);
    }

    const auditCount = await test.prisma.auditLog.count({ where: { action: 'enrollment.reserved' } });
    expect(auditCount).toBe(SECTION_CAPACITY);
  });

  it('the same student spamming reservations concurrently enrolls exactly once', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T102!.id,
      instructorId,
      sectionCode: 'SPAM-1',
      maxCapacity: 10,
      schedules: [{ dayOfWeek: 2, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    const [student] = await createBulkStudents(test.prisma, backbone, 1, 'spam');
    const token = test.mintToken(student!.id, ['STUDENT']);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        test.app.inject({
          method: 'POST',
          url: '/api/v1/enrollments/reserve',
          headers: { ...test.auth(token), 'idempotency-key': randomUUID() },
          payload: { termId: backbone.term.id, sectionIds: [section.id] },
        }),
      ),
    );

    const created = responses.filter((r) => r.statusCode === 201);
    const summary = responses.map((r) => `${r.statusCode}:${r.json().code ?? 'ok'}`).join(', ');
    expect(created, `responses=[${summary}]`).toHaveLength(1);
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }

    const persisted = await test.prisma.section.findUniqueOrThrow({ where: { id: section.id } });
    expect(persisted.enrolledCount).toBe(1);
    const items = await test.prisma.enrollmentItem.count({ where: { sectionId: section.id, status: 'ENROLLED' } });
    expect(items).toBe(1);
  });

  it('database enforcement is real: the CHECK constraint rejects an oversell behind the service', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T104!.id,
      instructorId,
      sectionCode: 'DB-GUARD',
      maxCapacity: 1,
      schedules: [{ dayOfWeek: 3, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    await expect(
      test.prisma.section.update({ where: { id: section.id }, data: { enrolledCount: 2 } }),
    ).rejects.toThrow(/capacity|constraint/i);
  });
});
