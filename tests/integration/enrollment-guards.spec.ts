import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { createBackbone, createBulkStudents, createSection, createUser, type FixtureBackbone } from '../helpers/fixtures';

describe('enrollment concurrency guards (unit cap, drop idempotence)', () => {
  let test: TestApp;
  let backbone: FixtureBackbone;
  let instructorId: string;

  beforeAll(async () => {
    test = await createTestApp();
    backbone = await createBackbone(test.prisma, test.clock.now());
    const instructor = await createUser(test.prisma, { email: 'guards.instructor@test.dev', roles: ['INSTRUCTOR'] });
    instructorId = instructor.id;
  });

  afterAll(async () => {
    await test.close();
  });

  it('same-student concurrent reservations across sections respect the unit cap', async () => {
    const heavyA = await test.prisma.course.create({
      data: { code: 'HEAVY-A', title: 'Heavy A', lectureUnits: 20, labUnits: 0 },
    });
    const heavyB = await test.prisma.course.create({
      data: { code: 'HEAVY-B', title: 'Heavy B', lectureUnits: 20, labUnits: 0 },
    });
    for (const course of [heavyA, heavyB]) {
      await test.prisma.curriculumCourse.create({
        data: {
          curriculumVersionId: backbone.curriculum.id,
          courseId: course.id,
          yearLevel: 1,
          termNo: 1,
          isRequired: false,
        },
      });
    }
    const sectionA = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: heavyA.id,
      instructorId,
      sectionCode: 'UNITS-A',
      maxCapacity: 10,
      schedules: [{ dayOfWeek: 4, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    const sectionB = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: heavyB.id,
      instructorId,
      sectionCode: 'UNITS-B',
      maxCapacity: 10,
      schedules: [{ dayOfWeek: 5, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });

    const [student] = await createBulkStudents(test.prisma, backbone, 1, 'units');
    const token = test.mintToken(student!.id, ['STUDENT']);
    const reserveSection = (sectionId: string) =>
      test.app.inject({
        method: 'POST',
        url: '/api/v1/enrollments/reserve',
        headers: { ...test.auth(token), 'idempotency-key': randomUUID() },
        payload: { termId: backbone.term.id, sectionIds: [sectionId] },
      });

    const [a, b] = await Promise.all([reserveSection(sectionA.id), reserveSection(sectionB.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    const loser = a.statusCode === 201 ? b : a;
    expect(loser.json().code).toBe('MAX_UNITS_EXCEEDED');

    const items = await test.prisma.enrollmentItem.findMany({
      where: { status: 'ENROLLED', enrollment: { studentId: student!.id, termId: backbone.term.id } },
      select: { unitsAtReservation: true },
    });
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.unitsAtReservation)).toBe(20);
  });

  it('concurrent drops of the same item decrement the section counter exactly once', async () => {
    const section = await createSection(test.prisma, {
      termId: backbone.term.id,
      courseId: backbone.courses.T101!.id,
      instructorId,
      sectionCode: 'DROP-1',
      maxCapacity: 5,
      schedules: [{ dayOfWeek: 6, startMin: 480, endMin: 540, roomId: backbone.room.id }],
    });
    const [student] = await createBulkStudents(test.prisma, backbone, 1, 'drop');
    const token = test.mintToken(student!.id, ['STUDENT']);

    const reserve = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers: { ...test.auth(token), 'idempotency-key': randomUUID() },
      payload: { termId: backbone.term.id, sectionIds: [section.id] },
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const itemId = reserve.json().items[0].id as string;

    const drop = () =>
      test.app.inject({
        method: 'POST',
        url: '/api/v1/enrollments/drop',
        headers: test.auth(token),
        payload: { itemId },
      });
    const [d1, d2] = await Promise.all([drop(), drop()]);

    expect(
      [d1.statusCode, d2.statusCode].filter((status) => status === 200),
      `${d1.body} | ${d2.body}`,
    ).toHaveLength(1);
    const loser = d1.statusCode === 200 ? d2 : d1;
    expect(loser.statusCode).toBeGreaterThanOrEqual(400);
    expect(loser.json().code).toBe('NOT_ENROLLED');

    const persisted = await test.prisma.section.findUniqueOrThrow({ where: { id: section.id } });
    expect(persisted.enrolledCount).toBe(0);
    expect(persisted.waitlistCount).toBe(0);
    const items = await test.prisma.enrollmentItem.findMany({ where: { sectionId: section.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('DROPPED');
  });
});
