import type {
  AcademicTerm,
  Course,
  CurriculumVersion,
  Department,
  EnrollmentItem,
  FeeCategory,
  PrismaClient,
  Program,
  Room,
  Section,
  TermStatus,
  User,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { hashPassword } from '../../src/modules/iam/passwords';

export interface FixtureBackbone {
  schoolId: string;
  department: Department;
  program: Program;
  curriculum: CurriculumVersion;
  courses: Record<string, Course>;
  term: AcademicTerm;
  room: Room;
}

/** Fixed School #1 id — matches the seed/migration (`MAIN` / Main Campus). */
export const TEST_SCHOOL_ID = '11111111-1111-4111-8111-111111111111';
/** Fixed School #2 id for cross-tenant isolation tests. */
export const TEST_SCHOOL2_ID = '22222222-2222-4222-8222-222222222222';

export async function ensureTestSchool(
  prisma: PrismaClient,
  school: { id: string; code: string; name: string } = { id: TEST_SCHOOL_ID, code: 'MAIN', name: 'Main Campus' },
): Promise<void> {
  await prisma.school.upsert({ where: { id: school.id }, create: school, update: {} });
}

export interface TermWindow {
  status?: TermStatus;
  enrollmentStartAt?: Date;
  addDropEndAt?: Date;
  startsAt?: Date;
  endsAt?: Date;
  gradingStartAt?: Date;
  gradingEndAt?: Date;
}

export function openTermWindow(now: Date): Required<Pick<TermWindow, 'enrollmentStartAt' | 'addDropEndAt' | 'startsAt' | 'endsAt' | 'gradingStartAt' | 'gradingEndAt'>> {
  return {
    enrollmentStartAt: new Date(now.getTime() - 7 * 86_400_000),
    addDropEndAt: new Date(now.getTime() + 14 * 86_400_000),
    startsAt: new Date(now.getTime() + 21 * 86_400_000),
    endsAt: new Date(now.getTime() + 120 * 86_400_000),
    gradingStartAt: new Date(now.getTime() + 110 * 86_400_000),
    gradingEndAt: new Date(now.getTime() + 130 * 86_400_000),
  };
}

export async function createUser(
  prisma: PrismaClient,
  input: { email: string; roles: User['roles']; firstName?: string; lastName?: string; password?: string; schoolId?: string },
): Promise<User> {
  const schoolId = input.schoolId ?? TEST_SCHOOL_ID;
  await ensureTestSchool(prisma, schoolId === TEST_SCHOOL_ID ? undefined : { id: schoolId, code: `TST-${schoolId.slice(0, 8)}`, name: `Test School ${schoolId.slice(0, 8)}` });
  const user = await prisma.user.create({
    data: {
      email: input.email,
      firstName: input.firstName ?? 'Test',
      lastName: input.lastName ?? 'User',
      roles: input.roles,
      passwordHash: await hashPassword(input.password ?? 'Password123!'),
    },
  });
  const membership = await prisma.membership.create({
    data: { schoolId, userId: user.id, status: 'ACTIVE' },
  });
  if (input.roles.length > 0) {
    await prisma.roleAssignment.createMany({
      data: input.roles.map((role) => ({ schoolId, membershipId: membership.id, roleCode: String(role) })),
    });
  }
  return user;
}

export async function createBackbone(
  prisma: PrismaClient,
  now: Date,
  options: { termCode?: string; term?: TermWindow; withFees?: boolean; schoolId?: string } = {},
): Promise<FixtureBackbone> {
  const schoolId = options.schoolId ?? TEST_SCHOOL_ID;
  await ensureTestSchool(prisma, schoolId === TEST_SCHOOL_ID ? undefined : { id: schoolId, code: `TST-${schoolId.slice(0, 8)}`, name: `Test School ${schoolId.slice(0, 8)}` });
  const department = await prisma.department.create({ data: { schoolId, code: 'TST-DEPT', name: 'Test Department' } });
  const program = await prisma.program.create({
    data: { schoolId, code: 'TST-BSCS', name: 'Test CS', degreeTitle: 'BS Test', departmentId: department.id },
  });
  const curriculum = await prisma.curriculumVersion.create({
    data: { schoolId, programId: program.id, version: '1', name: 'Test Curriculum', unitsRequired: 30, status: 'ACTIVE' },
  });

  const courseSpecs = [
    { code: 'T101', title: 'Intro', lectureUnits: 3, labUnits: 0, yearLevel: 1, termNo: 1 },
    { code: 'T102', title: 'Programming', lectureUnits: 2, labUnits: 1, yearLevel: 1, termNo: 1 },
    { code: 'T103', title: 'Data Structures', lectureUnits: 3, labUnits: 0, yearLevel: 1, termNo: 2 },
    { code: 'T104', title: 'Databases', lectureUnits: 2, labUnits: 1, yearLevel: 2, termNo: 1 },
  ];
  const courses: Record<string, Course> = {};
  for (const spec of courseSpecs) {
    courses[spec.code] = await prisma.course.create({
      data: { schoolId, code: spec.code, title: spec.title, lectureUnits: spec.lectureUnits, labUnits: spec.labUnits },
    });
    await prisma.curriculumCourse.create({
      data: {
        schoolId,
        curriculumVersionId: curriculum.id,
        courseId: courses[spec.code]!.id,
        yearLevel: spec.yearLevel,
        termNo: spec.termNo,
        isRequired: true,
      },
    });
  }
  await prisma.courseRequisite.create({
    data: {
      schoolId,
      courseId: courses.T103!.id,
      requiredCourseId: courses.T102!.id,
      type: 'PREREQUISITE',
      minGrade: '3.00',
    },
  });

  const window = { ...openTermWindow(now), ...options.term };
  const term = await prisma.academicTerm.create({
    data: {
      schoolId,
      code: options.termCode ?? 'TST-2026-1',
      schoolYear: 2026,
      termNo: 1,
      status: options.term?.status ?? 'ENROLLMENT',
      ...window,
    },
  });

  const room = await prisma.room.create({ data: { schoolId, code: 'TST-R1', building: 'Test', capacity: 100 } });

  if (options.withFees !== false) {
    const fees: Array<{ code: string; name: string; category: FeeCategory; amount: string; perUnit: boolean }> = [
      { code: 'TST-TUITION', name: 'Tuition', category: 'TUITION', amount: '500.00', perUnit: true },
      { code: 'TST-REG', name: 'Registration', category: 'MISC', amount: '1000.00', perUnit: false },
      { code: 'TST-LAB', name: 'Lab', category: 'LAB', amount: '750.00', perUnit: false },
    ];
    for (const fee of fees) {
      await prisma.feeDefinition.create({ data: { schoolId, ...fee } });
    }
  }

  return { schoolId, department, program, curriculum, courses, term, room };
}

export async function createStudent(
  prisma: PrismaClient,
  backbone: FixtureBackbone,
  input: { email: string; studentNo: string; password?: string; firstName?: string; lastName?: string },
): Promise<User> {
  const user = await createUser(prisma, {
    email: input.email,
    roles: ['STUDENT'],
    password: input.password,
    firstName: input.firstName,
    lastName: input.lastName,
    schoolId: backbone.schoolId,
  });
  await prisma.studentProfile.create({
    data: {
      schoolId: backbone.schoolId,
      userId: user.id,
      studentNo: input.studentNo,
      programId: backbone.program.id,
      curriculumVersionId: backbone.curriculum.id,
      yearLevel: 1,
    },
  });
  return user;
}

/**
 * Bulk version for concurrency tests: hashes the password once and inserts
 * users/profiles via `createMany` (argon2 hashing per student is too slow at
 * 50+ students).
 */
export async function createBulkStudents(
  prisma: PrismaClient,
  backbone: FixtureBackbone,
  count: number,
  prefix = 'bulk',
): Promise<User[]> {
  const passwordHash = await hashPassword('Password123!');
  await prisma.user.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      email: `${prefix}.${String(index + 1).padStart(3, '0')}@test.dev`,
      firstName: 'Bulk',
      lastName: `Student${index + 1}`,
      roles: ['STUDENT'],
      passwordHash,
    })),
  });
  const users = await prisma.user.findMany({
    where: { email: { startsWith: `${prefix}.` } },
    orderBy: { email: 'asc' },
  });
  await prisma.studentProfile.createMany({
    data: users.map((user, index) => ({
      schoolId: backbone.schoolId,
      userId: user.id,
      studentNo: `TST-${prefix.toUpperCase()}-${String(index + 1).padStart(3, '0')}`,
      programId: backbone.program.id,
      curriculumVersionId: backbone.curriculum.id,
      yearLevel: 1,
    })),
  });
  await prisma.membership.createMany({
    data: users.map((user) => ({ schoolId: backbone.schoolId, userId: user.id, status: 'ACTIVE' })),
  });
  const memberships = await prisma.membership.findMany({
    where: { userId: { in: users.map((user) => user.id) } },
    select: { id: true },
  });
  await prisma.roleAssignment.createMany({
    data: memberships.map((membership) => ({
      schoolId: backbone.schoolId,
      membershipId: membership.id,
      roleCode: 'STUDENT',
    })),
  });
  return users;
}

/**
 * Places an ENROLLED item directly (bypasses the reserve pipeline) for tests
 * that need a populated section without exercising enrollment itself.
 */
export async function enrollStudentDirect(
  prisma: PrismaClient,
  input: { studentId: string; termId: string; sectionId: string; units: number; at: Date; schoolId?: string },
): Promise<EnrollmentItem> {
  const schoolId = input.schoolId ?? TEST_SCHOOL_ID;
  const enrollment = await prisma.enrollment.upsert({
    where: { studentId_termId: { studentId: input.studentId, termId: input.termId } },
    create: { schoolId, studentId: input.studentId, termId: input.termId, status: 'ENROLLED', confirmedAt: input.at },
    update: {},
  });
  const item = await prisma.enrollmentItem.create({
    data: {
      schoolId,
      enrollmentId: enrollment.id,
      sectionId: input.sectionId,
      status: 'ENROLLED',
      unitsAtReservation: new Prisma.Decimal(input.units),
      enrolledAt: input.at,
    },
  });
  await prisma.section.update({ where: { id: input.sectionId }, data: { enrolledCount: { increment: 1 } } });
  return item;
}

export async function createSection(
  prisma: PrismaClient,
  input: {
    termId: string;
    courseId: string;
    instructorId: string;
    sectionCode: string;
    maxCapacity?: number;
    status?: Section['status'];
    schedules: Array<{ dayOfWeek: number; startMin: number; endMin: number; roomId: string }>;
    schoolId?: string;
  },
): Promise<Section> {
  const schoolId = input.schoolId ?? TEST_SCHOOL_ID;
  const section = await prisma.section.create({
    data: {
      schoolId,
      termId: input.termId,
      courseId: input.courseId,
      instructorId: input.instructorId,
      sectionCode: input.sectionCode,
      maxCapacity: input.maxCapacity ?? 40,
      status: input.status ?? 'OPEN',
    },
  });
  for (const schedule of input.schedules) {
    await prisma.sectionSchedule.create({
      data: {
        schoolId,
        sectionId: section.id,
        termId: input.termId,
        instructorId: input.instructorId,
        roomId: schedule.roomId,
        dayOfWeek: schedule.dayOfWeek,
        startMin: schedule.startMin,
        endMin: schedule.endMin,
      },
    });
  }
  return section;
}
