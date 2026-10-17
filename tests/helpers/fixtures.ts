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
  department: Department;
  program: Program;
  curriculum: CurriculumVersion;
  courses: Record<string, Course>;
  term: AcademicTerm;
  room: Room;
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
  input: { email: string; roles: User['roles']; firstName?: string; lastName?: string; password?: string },
): Promise<User> {
  return prisma.user.create({
    data: {
      email: input.email,
      firstName: input.firstName ?? 'Test',
      lastName: input.lastName ?? 'User',
      roles: input.roles,
      passwordHash: await hashPassword(input.password ?? 'Password123!'),
    },
  });
}

export async function createBackbone(
  prisma: PrismaClient,
  now: Date,
  options: { termCode?: string; term?: TermWindow; withFees?: boolean } = {},
): Promise<FixtureBackbone> {
  const department = await prisma.department.create({ data: { code: 'TST-DEPT', name: 'Test Department' } });
  const program = await prisma.program.create({
    data: { code: 'TST-BSCS', name: 'Test CS', degreeTitle: 'BS Test', departmentId: department.id },
  });
  const curriculum = await prisma.curriculumVersion.create({
    data: { programId: program.id, version: '1', name: 'Test Curriculum', unitsRequired: 30, status: 'ACTIVE' },
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
      data: { code: spec.code, title: spec.title, lectureUnits: spec.lectureUnits, labUnits: spec.labUnits },
    });
    await prisma.curriculumCourse.create({
      data: {
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
      courseId: courses.T103!.id,
      requiredCourseId: courses.T102!.id,
      type: 'PREREQUISITE',
      minGrade: '3.00',
    },
  });

  const window = { ...openTermWindow(now), ...options.term };
  const term = await prisma.academicTerm.create({
    data: {
      code: options.termCode ?? 'TST-2026-1',
      schoolYear: 2026,
      termNo: 1,
      status: options.term?.status ?? 'ENROLLMENT',
      ...window,
    },
  });

  const room = await prisma.room.create({ data: { code: 'TST-R1', building: 'Test', capacity: 100 } });

  if (options.withFees !== false) {
    const fees: Array<{ code: string; name: string; category: FeeCategory; amount: string; perUnit: boolean }> = [
      { code: 'TST-TUITION', name: 'Tuition', category: 'TUITION', amount: '500.00', perUnit: true },
      { code: 'TST-REG', name: 'Registration', category: 'MISC', amount: '1000.00', perUnit: false },
      { code: 'TST-LAB', name: 'Lab', category: 'LAB', amount: '750.00', perUnit: false },
    ];
    for (const fee of fees) {
      await prisma.feeDefinition.create({ data: fee });
    }
  }

  return { department, program, curriculum, courses, term, room };
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
  });
  await prisma.studentProfile.create({
    data: {
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
      userId: user.id,
      studentNo: `TST-${prefix.toUpperCase()}-${String(index + 1).padStart(3, '0')}`,
      programId: backbone.program.id,
      curriculumVersionId: backbone.curriculum.id,
      yearLevel: 1,
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
  input: { studentId: string; termId: string; sectionId: string; units: number; at: Date },
): Promise<EnrollmentItem> {
  const enrollment = await prisma.enrollment.upsert({
    where: { studentId_termId: { studentId: input.studentId, termId: input.termId } },
    create: { studentId: input.studentId, termId: input.termId, status: 'ENROLLED', confirmedAt: input.at },
    update: {},
  });
  const item = await prisma.enrollmentItem.create({
    data: {
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
  },
): Promise<Section> {
  const section = await prisma.section.create({
    data: {
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
