import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithTenant } from '../../src/core/tenant/context';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  createBackbone,
  createSection,
  createStudent,
  createUser,
  enrollStudentDirect,
  TEST_SCHOOL2_ID,
  type FixtureBackbone,
} from '../helpers/fixtures';

describe('tenant isolation: cross-school access via HTTP', () => {
  let test: TestApp;
  let school1: FixtureBackbone;
  let school2: FixtureBackbone;
  let aliceId: string;
  let bobId: string;
  let registrar1Id: string;
  let admin1Id: string;
  let instructor1Id: string;
  let section2Id: string;

  beforeAll(async () => {
    test = await createTestApp();
    const now = test.clock.now();
    school1 = await createBackbone(test.prisma, now);
    school2 = await createBackbone(test.prisma, now, { schoolId: TEST_SCHOOL2_ID });
    aliceId = (await createStudent(test.prisma, school1, { email: 'iso.alice@test.dev', studentNo: 'ISO-A1' })).id;
    bobId = (await createStudent(test.prisma, school2, { email: 'iso.bob@test.dev', studentNo: 'ISO-B1' })).id;
    registrar1Id = (
      await createUser(test.prisma, { email: 'iso.registrar1@test.dev', roles: ['REGISTRAR'] })
    ).id;
    admin1Id = (await createUser(test.prisma, { email: 'iso.admin1@test.dev', roles: ['ADMIN'] })).id;
    const instructor1 = await createUser(test.prisma, { email: 'iso.inst1@test.dev', roles: ['INSTRUCTOR'] });
    instructor1Id = instructor1.id;
    const instructor2 = await createUser(test.prisma, {
      email: 'iso.inst2@test.dev',
      roles: ['INSTRUCTOR'],
      schoolId: TEST_SCHOOL2_ID,
    });
    const section2 = await createSection(test.prisma, {
      termId: school2.term.id,
      courseId: school2.courses.T101!.id,
      instructorId: instructor2.id,
      sectionCode: 'ISO-B',
      schedules: [{ dayOfWeek: 1, startMin: 480, endMin: 540, roomId: school2.room.id }],
      schoolId: TEST_SCHOOL2_ID,
    });
    section2Id = section2.id;
    await enrollStudentDirect(test.prisma, {
      studentId: bobId,
      termId: school2.term.id,
      sectionId: section2Id,
      units: 3,
      at: now,
      schoolId: TEST_SCHOOL2_ID,
    });
  });

  afterAll(async () => {
    await test.close();
  });

  const aliceToken = () => test.auth(test.mintToken(aliceId, ['STUDENT']));
  const bobToken = () => test.auth(test.mintToken(bobId, ['STUDENT'], { schoolId: TEST_SCHOOL2_ID }));
  const registrar1Token = () => test.auth(test.mintToken(registrar1Id, ['REGISTRAR']));

  it('school-1 student cannot reserve a school-2 section', async () => {
    const res = await test.app.inject({
      method: 'POST',
      url: '/api/v1/enrollments/reserve',
      headers: { ...aliceToken(), 'idempotency-key': randomUUID() },
      payload: { termId: school2.term.id, sectionIds: [section2Id] },
    });
    expect(res.statusCode).toBe(404);
    const rawCount = await test.prisma.enrollmentItem.count({ where: { schoolId: TEST_SCHOOL2_ID } });
    expect(rawCount).toBe(1);
  });

  it('document requests are invisible to other schools (student and staff)', async () => {
    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/documents/requests',
      headers: { ...bobToken(), 'idempotency-key': randomUUID() },
      payload: { type: 'COR', termId: school2.term.id },
    });
    expect(created.statusCode).toBe(201);
    const documentId = created.json().id as string;

    const own = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${documentId}`,
      headers: bobToken(),
    });
    expect(own.statusCode).toBe(200);

    const sneakStudent = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${documentId}`,
      headers: aliceToken(),
    });
    expect(sneakStudent.statusCode).toBe(404);

    const sneakRegistrar = await test.app.inject({
      method: 'GET',
      url: `/api/v1/documents/requests/${documentId}`,
      headers: registrar1Token(),
    });
    expect(sneakRegistrar.statusCode).toBe(404);
  });

  it("school-1 admin cannot create a user against school-2's program", async () => {
    const res = await test.app.inject({
      method: 'POST',
      url: '/api/v1/iam/users',
      headers: test.auth(test.mintToken(admin1Id, ['ADMIN'])),
      payload: {
        email: 'iso.ghost@test.dev',
        password: 'Password123!',
        firstName: 'Ghost',
        lastName: 'User',
        roles: ['STUDENT'],
        student: {
          studentNo: 'ISO-G1',
          programId: school2.program.id,
          curriculumVersionId: school2.curriculum.id,
          yearLevel: 1,
        },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(await test.prisma.user.count({ where: { email: 'iso.ghost@test.dev' } })).toBe(0);
  });

  it('grade ledger of another school resolves to an empty list, sheet reads 404', async () => {
    const ledger = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/students/${bobId}/ledger`,
      headers: registrar1Token(),
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toEqual([]);

    const sheet = await test.app.inject({
      method: 'GET',
      url: `/api/v1/grading/sections/${section2Id}/sheet`,
      headers: test.auth(test.mintToken(instructor1Id, ['INSTRUCTOR'])),
    });
    expect(sheet.statusCode).toBe(404);
  });
});

describe('tenant extension + ALS context', () => {
  let test: TestApp;
  let school1: FixtureBackbone;
  let school2: FixtureBackbone;

  beforeAll(async () => {
    test = await createTestApp();
    school1 = await createBackbone(test.prisma, test.clock.now());
    school2 = await createBackbone(test.prisma, test.clock.now(), { schoolId: TEST_SCHOOL2_ID });
  });

  afterAll(async () => {
    await test.close();
  });

  it('fails closed when no tenant is bound', async () => {
    await expect(test.ctx.prisma.department.findMany()).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
    });
  });

  it('scopes reads to the bound school', async () => {
    const s1 = await runWithTenant(school1.schoolId, () => test.ctx.prisma.department.findMany());
    expect(s1.length).toBeGreaterThan(0);
    expect(s1.every((d) => d.schoolId === school1.schoolId)).toBe(true);
    expect(s1.some((d) => d.id === school1.department.id)).toBe(true);
    expect(s1.some((d) => d.id === school2.department.id)).toBe(false);

    const s2 = await runWithTenant(TEST_SCHOOL2_ID, () => test.ctx.prisma.department.findMany());
    expect(s2.every((d) => d.schoolId === TEST_SCHOOL2_ID)).toBe(true);
    expect(s2.some((d) => d.id === school1.department.id)).toBe(false);
  });

  it('returns null for a unique lookup of another school row', async () => {
    const found = await runWithTenant(school1.schoolId, () =>
      test.ctx.prisma.department.findUnique({ where: { id: school2.department.id } }),
    );
    expect(found).toBeNull();
  });

  it('refuses cross-school deletes and leaves the row intact', async () => {
    await expect(
      runWithTenant(school1.schoolId, () =>
        test.ctx.prisma.department.delete({ where: { id: school2.department.id } }),
      ),
    ).rejects.toBeTruthy();
    const still = await test.prisma.department.findUnique({ where: { id: school2.department.id } });
    expect(still).not.toBeNull();
  });

  it('injects the bound schoolId into creates that omit it (safety net)', async () => {
    const created = await runWithTenant(school1.schoolId, () =>
      test.ctx.prisma.department.create({
        data: { code: 'ISO-INJ', name: 'Injected' } as unknown as Prisma.DepartmentUncheckedCreateInput,
      }),
    );
    expect(created.schoolId).toBe(school1.schoolId);
    const raw = await test.prisma.department.findUnique({ where: { id: created.id } });
    expect(raw?.schoolId).toBe(school1.schoolId);
  });
});

describe('RLS: schoolledger_app role (defense in depth)', () => {
  let test: TestApp;
  let appPrisma: PrismaClient;
  let school1: FixtureBackbone;
  let school2: FixtureBackbone;

  beforeAll(async () => {
    test = await createTestApp();
    school1 = await createBackbone(test.prisma, test.clock.now());
    school2 = await createBackbone(test.prisma, test.clock.now(), { schoolId: TEST_SCHOOL2_ID });
    appPrisma = new PrismaClient({ datasources: { db: { url: test.infra.appDatabaseUrl } } });
  });

  afterAll(async () => {
    await appPrisma.$executeRawUnsafe(`DELETE FROM "departments" WHERE code = 'RLS-OK'`).catch(() => undefined);
    await appPrisma.$disconnect().catch(() => undefined);
    await test.close();
  });

  const countVisible = (id: string) =>
    appPrisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "departments" WHERE id = '${id}'::uuid`,
      );
      return rows[0]!.n;
    });

  it('fails closed without session GUCs: no rows visible and writes rejected', async () => {
    const rows = await appPrisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "departments"`,
    );
    expect(rows[0]!.n).toBe(0);
    await expect(countVisible(school1.department.id)).resolves.toBe(0);

    await expect(
      appPrisma.$executeRawUnsafe(
        `INSERT INTO "departments" (id, "schoolId", code, name, "createdAt")
         VALUES (gen_random_uuid(), '${TEST_SCHOOL2_ID}', 'RLS-X', 'X', now())`,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('scopes visibility by app.current_school_id', async () => {
    const asSchool1 = await appPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_school_id', '${school1.schoolId}', false)`);
      const own = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "departments" WHERE id = '${school1.department.id}'::uuid`,
      );
      const other = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "departments" WHERE id = '${school2.department.id}'::uuid`,
      );
      return { own: own[0]!.n, other: other[0]!.n };
    });
    expect(asSchool1).toEqual({ own: 1, other: 0 });

    const asSchool2 = await appPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_school_id', '${TEST_SCHOOL2_ID}', false)`);
      const own = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "departments" WHERE id = '${school2.department.id}'::uuid`,
      );
      return own[0]!.n;
    });
    expect(asSchool2).toBe(1);
  });

  it('blocks cross-school inserts while allowing matching-school ones', async () => {
    await expect(
      appPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_school_id', '${school1.schoolId}', false)`);
        await tx.$executeRawUnsafe(
          `INSERT INTO "departments" (id, "schoolId", code, name, "createdAt")
           VALUES (gen_random_uuid(), '${TEST_SCHOOL2_ID}', 'RLS-CTX', 'Ctx', now())`,
        );
      }),
    ).rejects.toThrow(/row-level security|violates/i);

    await appPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_school_id', '${school1.schoolId}', false)`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "departments" (id, "schoolId", code, name, "createdAt")
         VALUES (gen_random_uuid(), '${school1.schoolId}', 'RLS-OK', 'Ok', now())`,
      );
    });
    const inserted = await test.prisma.department.findFirst({ where: { code: 'RLS-OK' } });
    expect(inserted?.schoolId).toBe(school1.schoolId);
  });

  it('system flag sees every school (platform maintenance escape hatch)', async () => {
    const total = await appPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.system', 'on', false)`);
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "departments" WHERE id IN ('${school1.department.id}'::uuid, '${school2.department.id}'::uuid)`,
      );
      return rows[0]!.n;
    });
    expect(total).toBe(2);
  });
});
