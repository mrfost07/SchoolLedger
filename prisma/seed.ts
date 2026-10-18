/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env';
import { hashPassword } from '../src/modules/iam/passwords';
import { PERMISSIONS, ROLE_TEMPLATES } from '../src/modules/iam/permissions';

const PASSWORD = 'Password123!';

/** Fixed School #1 id — matches migration 0003 (MAIN / Main Campus). */
const MAIN_SCHOOL_ID = '11111111-1111-4111-8111-111111111111';
/** Fixed School #2 id for cross-tenant demos and isolation checks. */
const NORTH_SCHOOL_ID = '22222222-2222-4222-8222-222222222222';

type SeedRole = 'STUDENT' | 'INSTRUCTOR' | 'PROGRAM_CHAIR' | 'REGISTRAR' | 'CASHIER' | 'ADMIN';

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function upsertUser(
  prisma: PrismaClient,
  input: { email: string; firstName: string; lastName: string; roles: SeedRole[]; passwordHash: string },
) {
  return prisma.user.upsert({
    where: { email: input.email },
    update: { roles: input.roles },
    create: {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      roles: input.roles,
      passwordHash: input.passwordHash,
    },
  });
}

async function grantMembership(prisma: PrismaClient, schoolId: string, userId: string, roles: string[]): Promise<void> {
  const membership = await prisma.membership.upsert({
    where: { schoolId_userId: { schoolId, userId } },
    update: { status: 'ACTIVE' },
    create: { schoolId, userId, status: 'ACTIVE' },
  });
  for (const roleCode of roles) {
    await prisma.roleAssignment.upsert({
      where: { membershipId_roleCode: { membershipId: membership.id, roleCode } },
      update: {},
      create: { schoolId, membershipId: membership.id, roleCode },
    });
  }
}

interface SchoolSeedOptions {
  address?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  brandColor?: string;
  policy?: {
    maxAcademicUnits?: number;
    incCompletionDays?: number;
  };
}

async function upsertSchool(prisma: PrismaClient, id: string, code: string, name: string, options: SchoolSeedOptions = {}): Promise<void> {
  const { policy, ...profile } = options;
  await prisma.school.upsert({
    where: { id },
    update: { code, name, ...profile },
    create: { id, code, name, ...profile },
  });
  await prisma.schoolPolicy.upsert({
    where: { schoolId: id },
    update: policy ?? {},
    create: { schoolId: id, ...(policy ?? {}) },
  });
}

async function seedPermissionRegistry(prisma: PrismaClient): Promise<void> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: { code: permission.code, module: permission.module, description: permission.description },
    });
  }
  for (const spec of ROLE_TEMPLATES) {
    const template = await prisma.roleTemplate.upsert({
      where: { mode_roleCode: { mode: spec.mode, roleCode: spec.roleCode } },
      update: {},
      create: { mode: spec.mode, roleCode: spec.roleCode },
    });
    await prisma.roleTemplatePermission.deleteMany({ where: { templateId: template.id } });
    if (spec.permissions.length > 0) {
      await prisma.roleTemplatePermission.createMany({
        data: spec.permissions.map((permissionCode) => ({ templateId: template.id, permissionCode })),
      });
    }
  }
}

async function main(): Promise<void> {
  const config = loadEnv();
  // Raw admin client: the seed runs outside any tenant context and uses the
  // owner connection (the app-side client enforces tenant scoping).
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const passwordHash = await hashPassword(PASSWORD);

  await upsertSchool(prisma, MAIN_SCHOOL_ID, 'MAIN', 'Main Campus', {
    address: '123 Rizal Avenue, Manila, Philippines',
    contactEmail: 'registrar@main.portal.test',
    contactPhone: '+63 2 8123 4567',
    website: 'https://main.portal.test',
    brandColor: '#1d4ed8',
  });
  await upsertSchool(prisma, NORTH_SCHOOL_ID, 'NORTH', 'North Campus', {
    address: '45 Katipunan Road, Quezon City, Philippines',
    contactEmail: 'registrar@north.portal.test',
    contactPhone: '+63 2 8987 6543',
    website: 'https://north.portal.test',
    brandColor: '#0f766e',
    policy: { maxAcademicUnits: 24, incCompletionDays: 180 },
  });
  await seedPermissionRegistry(prisma);

  // ── School 1 (MAIN): full dataset ─────────────────────────────────────────
  const schoolId = MAIN_SCHOOL_ID;

  const department = await prisma.department.upsert({
    where: { schoolId_code: { schoolId, code: 'CCS' } },
    update: {},
    create: { schoolId, code: 'CCS', name: 'College of Computing Studies' },
  });

  const bscs = await prisma.program.upsert({
    where: { schoolId_code: { schoolId, code: 'BSCS' } },
    update: {},
    create: { schoolId, code: 'BSCS', name: 'Computer Science', degreeTitle: 'Bachelor of Science in Computer Science', departmentId: department.id },
  });
  const bsit = await prisma.program.upsert({
    where: { schoolId_code: { schoolId, code: 'BSIT' } },
    update: {},
    create: { schoolId, code: 'BSIT', name: 'Information Technology', degreeTitle: 'Bachelor of Science in Information Technology', departmentId: department.id },
  });

  const curriculum = await prisma.curriculumVersion.upsert({
    where: { programId_version: { programId: bscs.id, version: '2025' } },
    update: { status: 'ACTIVE' },
    create: { schoolId, programId: bscs.id, version: '2025', name: 'BSCS Curriculum 2025', unitsRequired: 12, status: 'ACTIVE', effectiveFrom: new Date('2025-06-01') },
  });
  await prisma.curriculumVersion.upsert({
    where: { programId_version: { programId: bsit.id, version: '2025' } },
    update: { status: 'ACTIVE' },
    create: { schoolId, programId: bsit.id, version: '2025', name: 'BSIT Curriculum 2025', unitsRequired: 6, status: 'ACTIVE', effectiveFrom: new Date('2025-06-01') },
  });

  const courseSpecs = [
    { code: 'CS101', title: 'Introduction to Computing', lectureUnits: 3, labUnits: 0, yearLevel: 1, termNo: 1 },
    { code: 'CS102', title: 'Programming 1', lectureUnits: 2, labUnits: 1, yearLevel: 1, termNo: 1 },
    { code: 'MATH101', title: 'Calculus 1', lectureUnits: 3, labUnits: 0, yearLevel: 1, termNo: 1 },
    { code: 'GE101', title: 'Understanding the Self', lectureUnits: 3, labUnits: 0, yearLevel: 1, termNo: 1 },
    { code: 'CS103', title: 'Data Structures and Algorithms', lectureUnits: 3, labUnits: 0, yearLevel: 1, termNo: 2 },
    { code: 'CS104', title: 'Database Management Systems', lectureUnits: 2, labUnits: 1, yearLevel: 2, termNo: 1 },
    { code: 'CS105', title: 'Computer Networks', lectureUnits: 3, labUnits: 0, yearLevel: 2, termNo: 1 },
    { code: 'CS106', title: 'Software Engineering', lectureUnits: 3, labUnits: 0, yearLevel: 2, termNo: 2 },
  ] as const;

  const courses: Record<string, { id: string }> = {};
  for (const spec of courseSpecs) {
    const course = await prisma.course.upsert({
      where: { schoolId_code: { schoolId, code: spec.code } },
      update: {},
      create: { schoolId, code: spec.code, title: spec.title, lectureUnits: spec.lectureUnits, labUnits: spec.labUnits },
    });
    courses[spec.code] = course;
    await prisma.curriculumCourse.upsert({
      where: { curriculumVersionId_courseId: { curriculumVersionId: curriculum.id, courseId: course.id } },
      update: { yearLevel: spec.yearLevel, termNo: spec.termNo },
      create: { schoolId, curriculumVersionId: curriculum.id, courseId: course.id, yearLevel: spec.yearLevel, termNo: spec.termNo, isRequired: true },
    });
  }

  const requisites = [
    { course: 'CS103', required: 'CS102' },
    { course: 'CS104', required: 'CS101' },
    { course: 'CS105', required: 'CS101' },
    { course: 'CS106', required: 'CS103' },
  ] as const;
  for (const req of requisites) {
    await prisma.courseRequisite.upsert({
      where: { courseId_requiredCourseId_type: { courseId: courses[req.course]!.id, requiredCourseId: courses[req.required]!.id, type: 'PREREQUISITE' } },
      update: {},
      create: { schoolId, courseId: courses[req.course]!.id, requiredCourseId: courses[req.required]!.id, type: 'PREREQUISITE', minGrade: '3.00' },
    });
  }

  for (const room of [
    { code: 'R-201', building: 'Main', capacity: 45 },
    { code: 'R-202', building: 'Main', capacity: 45 },
    { code: 'LAB-1', building: 'Tech', capacity: 30 },
  ]) {
    await prisma.room.upsert({
      where: { schoolId_code: { schoolId, code: room.code } },
      update: { capacity: room.capacity },
      create: { schoolId, ...room },
    });
  }

  const term = await prisma.academicTerm.upsert({
    where: { schoolId_code: { schoolId, code: '2025-2A' } },
    update: { status: 'ENROLLMENT' },
    create: {
      schoolId,
      code: '2025-2A',
      schoolYear: 2025,
      termNo: 2,
      status: 'ENROLLMENT',
      enrollmentStartAt: daysFromNow(-14),
      addDropEndAt: daysFromNow(21),
      startsAt: daysFromNow(30),
      endsAt: daysFromNow(135),
      gradingStartAt: daysFromNow(120),
      gradingEndAt: daysFromNow(150),
    },
  });

  const fees = [
    { code: 'TUITION', name: 'Tuition Fee (per unit)', category: 'TUITION' as const, amount: '500.00', perUnit: true },
    { code: 'REG', name: 'Registration Fee', category: 'MISC' as const, amount: '1500.00', perUnit: false },
    { code: 'LAB', name: 'Laboratory Fee', category: 'LAB' as const, amount: '1000.00', perUnit: false },
    { code: 'MISC', name: 'Miscellaneous Fee', category: 'MISC' as const, amount: '500.00', perUnit: false },
    { code: 'ATHLETIC', name: 'Athletic Fee', category: 'OTHER' as const, amount: '200.00', perUnit: false },
  ];
  for (const fee of fees) {
    await prisma.feeDefinition.upsert({
      where: { schoolId_code: { schoolId, code: fee.code } },
      update: { amount: fee.amount },
      create: { schoolId, code: fee.code, name: fee.name, category: fee.category, amount: fee.amount, perUnit: fee.perUnit },
    });
  }

  // ── School 2 (NORTH): minimal dataset proves per-school code uniqueness ──
  const northDepartment = await prisma.department.upsert({
    where: { schoolId_code: { schoolId: NORTH_SCHOOL_ID, code: 'CCS' } },
    update: {},
    create: { schoolId: NORTH_SCHOOL_ID, code: 'CCS', name: 'College of Computing Studies' },
  });
  const northProgram = await prisma.program.upsert({
    where: { schoolId_code: { schoolId: NORTH_SCHOOL_ID, code: 'BSCS' } },
    update: {},
    create: { schoolId: NORTH_SCHOOL_ID, code: 'BSCS', name: 'Computer Science', degreeTitle: 'Bachelor of Science in Computer Science', departmentId: northDepartment.id },
  });
  const northCurriculum = await prisma.curriculumVersion.upsert({
    where: { programId_version: { programId: northProgram.id, version: '2025' } },
    update: { status: 'ACTIVE' },
    create: { schoolId: NORTH_SCHOOL_ID, programId: northProgram.id, version: '2025', name: 'BSCS Curriculum 2025', unitsRequired: 9, status: 'ACTIVE', effectiveFrom: new Date('2025-06-01') },
  });
  const northCourse = await prisma.course.upsert({
    where: { schoolId_code: { schoolId: NORTH_SCHOOL_ID, code: 'CS101' } },
    update: {},
    create: { schoolId: NORTH_SCHOOL_ID, code: 'CS101', title: 'Introduction to Computing', lectureUnits: 3, labUnits: 0 },
  });
  await prisma.curriculumCourse.upsert({
    where: { curriculumVersionId_courseId: { curriculumVersionId: northCurriculum.id, courseId: northCourse.id } },
    update: {},
    create: { schoolId: NORTH_SCHOOL_ID, curriculumVersionId: northCurriculum.id, courseId: northCourse.id, yearLevel: 1, termNo: 1, isRequired: true },
  });
  await prisma.academicTerm.upsert({
    where: { schoolId_code: { schoolId: NORTH_SCHOOL_ID, code: '2025-2A' } },
    update: { status: 'ENROLLMENT' },
    create: {
      schoolId: NORTH_SCHOOL_ID,
      code: '2025-2A',
      schoolYear: 2025,
      termNo: 2,
      status: 'ENROLLMENT',
      enrollmentStartAt: daysFromNow(-14),
      addDropEndAt: daysFromNow(21),
      startsAt: daysFromNow(30),
      endsAt: daysFromNow(135),
      gradingStartAt: daysFromNow(120),
      gradingEndAt: daysFromNow(150),
    },
  });

  // ── Users, memberships, role assignments ──────────────────────────────────
  const admin = await upsertUser(prisma, { email: 'admin@portal.test', firstName: 'Ada', lastName: 'Admin', roles: ['ADMIN'], passwordHash });
  const registrar = await upsertUser(prisma, { email: 'registrar@portal.test', firstName: 'Rosa', lastName: 'Registrar', roles: ['REGISTRAR'], passwordHash });
  const chair = await upsertUser(prisma, { email: 'chair@portal.test', firstName: 'Carlo', lastName: 'Chair', roles: ['PROGRAM_CHAIR'], passwordHash });
  const instructor = await upsertUser(prisma, { email: 'instructor@portal.test', firstName: 'Iris', lastName: 'Instructor', roles: ['INSTRUCTOR'], passwordHash });
  const instructor2 = await upsertUser(prisma, { email: 'instructor2@portal.test', firstName: 'Ivan', lastName: 'Instructor', roles: ['INSTRUCTOR'], passwordHash });
  const cashier = await upsertUser(prisma, { email: 'cashier@portal.test', firstName: 'Cora', lastName: 'Cashier', roles: ['CASHIER'], passwordHash });

  await grantMembership(prisma, schoolId, admin.id, ['ADMIN']);
  await grantMembership(prisma, schoolId, registrar.id, ['REGISTRAR']);
  await grantMembership(prisma, schoolId, chair.id, ['PROGRAM_CHAIR']);
  await grantMembership(prisma, schoolId, instructor.id, ['INSTRUCTOR']);
  await grantMembership(prisma, schoolId, instructor2.id, ['INSTRUCTOR']);
  await grantMembership(prisma, schoolId, cashier.id, ['CASHIER']);
  // Admin is also a member of School 2 (multi-membership demo; login resolves
  // the oldest active membership → School 1).
  await grantMembership(prisma, NORTH_SCHOOL_ID, admin.id, ['ADMIN']);

  const students = [
    { email: 'alice.santos@student.portal.test', firstName: 'Alice', lastName: 'Santos', studentNo: '2025-0001' },
    { email: 'ben.reyes@student.portal.test', firstName: 'Ben', lastName: 'Reyes', studentNo: '2025-0002' },
    { email: 'carla.dizon@student.portal.test', firstName: 'Carla', lastName: 'Dizon', studentNo: '2025-0003' },
  ];
  for (const student of students) {
    const user = await upsertUser(prisma, { ...student, roles: ['STUDENT'], passwordHash });
    await prisma.studentProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { schoolId, userId: user.id, studentNo: student.studentNo, programId: bscs.id, curriculumVersionId: curriculum.id, yearLevel: 1 },
    });
    await grantMembership(prisma, schoolId, user.id, ['STUDENT']);
  }

  const sectionSpecs = [
    { code: 'CS102-A', course: 'CS102', cap: 40, day: 1, start: 480, end: 540 },
    { code: 'CS103-A', course: 'CS103', cap: 30, day: 2, start: 540, end: 600 },
    { code: 'GE101-A', course: 'GE101', cap: 50, day: 3, start: 480, end: 540 },
  ];
  const room = await prisma.room.findUniqueOrThrow({ where: { schoolId_code: { schoolId, code: 'R-201' } } });
  for (const spec of sectionSpecs) {
    const existing = await prisma.section.findFirst({ where: { termId: term.id, sectionCode: spec.code } });
    const section = existing ?? (await prisma.section.create({
      data: {
        schoolId,
        termId: term.id,
        courseId: courses[spec.course]!.id,
        sectionCode: spec.code,
        instructorId: instructor.id,
        maxCapacity: spec.cap,
        status: 'OPEN',
      },
    }));
    const scheduleExists = await prisma.sectionSchedule.findFirst({ where: { sectionId: section.id } });
    if (!scheduleExists) {
      await prisma.sectionSchedule.create({
        data: {
          schoolId,
          sectionId: section.id,
          termId: term.id,
          instructorId: instructor.id,
          roomId: room.id,
          dayOfWeek: spec.day,
          startMin: spec.start,
          endMin: spec.end,
        },
      });
    }
  }

  console.log('Seed complete.');
  console.log(`  Schools: ${MAIN_SCHOOL_ID} (MAIN / Main Campus), ${NORTH_SCHOOL_ID} (NORTH / North Campus)`);
  console.log(`  Permissions: ${PERMISSIONS.length} codes, ${ROLE_TEMPLATES.length} HE role templates`);
  console.log(`  Users: admin/registrar/chair/instructor/cashier @ ${PASSWORD}`);
  console.log(`  Students: ${students.map((s) => s.email).join(', ')} @ ${PASSWORD}`);
  console.log(`  Term ${term.code} open for enrollment until ${term.addDropEndAt.toISOString()}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
