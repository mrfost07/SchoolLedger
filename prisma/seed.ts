/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/infra/prisma';
import { hashPassword } from '../src/modules/iam/passwords';

const PASSWORD = 'Password123!';

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function upsertUser(
  prisma: PrismaClient,
  input: { email: string; firstName: string; lastName: string; roles: ('STUDENT' | 'INSTRUCTOR' | 'PROGRAM_CHAIR' | 'REGISTRAR' | 'CASHIER' | 'ADMIN')[]; passwordHash: string },
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

async function main(): Promise<void> {
  const config = loadEnv();
  const prisma = createPrismaClient(config.databaseUrl);
  const passwordHash = await hashPassword(PASSWORD);

  const department = await prisma.department.upsert({
    where: { code: 'CCS' },
    update: {},
    create: { code: 'CCS', name: 'College of Computing Studies' },
  });

  const bscs = await prisma.program.upsert({
    where: { code: 'BSCS' },
    update: {},
    create: { code: 'BSCS', name: 'Computer Science', degreeTitle: 'Bachelor of Science in Computer Science', departmentId: department.id },
  });
  const bsit = await prisma.program.upsert({
    where: { code: 'BSIT' },
    update: {},
    create: { code: 'BSIT', name: 'Information Technology', degreeTitle: 'Bachelor of Science in Information Technology', departmentId: department.id },
  });

  const curriculum = await prisma.curriculumVersion.upsert({
    where: { programId_version: { programId: bscs.id, version: '2025' } },
    update: { status: 'ACTIVE' },
    create: { programId: bscs.id, version: '2025', name: 'BSCS Curriculum 2025', unitsRequired: 12, status: 'ACTIVE', effectiveFrom: new Date('2025-06-01') },
  });
  await prisma.curriculumVersion.upsert({
    where: { programId_version: { programId: bsit.id, version: '2025' } },
    update: { status: 'ACTIVE' },
    create: { programId: bsit.id, version: '2025', name: 'BSIT Curriculum 2025', unitsRequired: 6, status: 'ACTIVE', effectiveFrom: new Date('2025-06-01') },
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
      where: { code: spec.code },
      update: {},
      create: { code: spec.code, title: spec.title, lectureUnits: spec.lectureUnits, labUnits: spec.labUnits },
    });
    courses[spec.code] = course;
    await prisma.curriculumCourse.upsert({
      where: { curriculumVersionId_courseId: { curriculumVersionId: curriculum.id, courseId: course.id } },
      update: { yearLevel: spec.yearLevel, termNo: spec.termNo },
      create: { curriculumVersionId: curriculum.id, courseId: course.id, yearLevel: spec.yearLevel, termNo: spec.termNo, isRequired: true },
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
      create: { courseId: courses[req.course]!.id, requiredCourseId: courses[req.required]!.id, type: 'PREREQUISITE', minGrade: '3.00' },
    });
  }

  for (const room of [
    { code: 'R-201', building: 'Main', capacity: 45 },
    { code: 'R-202', building: 'Main', capacity: 45 },
    { code: 'LAB-1', building: 'Tech', capacity: 30 },
  ]) {
    await prisma.room.upsert({ where: { code: room.code }, update: { capacity: room.capacity }, create: room });
  }

  const term = await prisma.academicTerm.upsert({
    where: { code: '2025-2A' },
    update: { status: 'ENROLLMENT' },
    create: {
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
      where: { code: fee.code },
      update: { amount: fee.amount },
      create: { code: fee.code, name: fee.name, category: fee.category, amount: fee.amount, perUnit: fee.perUnit },
    });
  }

  const admin = await upsertUser(prisma, { email: 'admin@portal.test', firstName: 'Ada', lastName: 'Admin', roles: ['ADMIN'], passwordHash });
  const registrar = await upsertUser(prisma, { email: 'registrar@portal.test', firstName: 'Rosa', lastName: 'Registrar', roles: ['REGISTRAR'], passwordHash });
  const chair = await upsertUser(prisma, { email: 'chair@portal.test', firstName: 'Carlo', lastName: 'Chair', roles: ['PROGRAM_CHAIR'], passwordHash });
  const instructor = await upsertUser(prisma, { email: 'instructor@portal.test', firstName: 'Iris', lastName: 'Instructor', roles: ['INSTRUCTOR'], passwordHash });
  await upsertUser(prisma, { email: 'instructor2@portal.test', firstName: 'Ivan', lastName: 'Instructor', roles: ['INSTRUCTOR'], passwordHash });
  await upsertUser(prisma, { email: 'cashier@portal.test', firstName: 'Cora', lastName: 'Cashier', roles: ['CASHIER'], passwordHash });

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
      create: { userId: user.id, studentNo: student.studentNo, programId: bscs.id, curriculumVersionId: curriculum.id, yearLevel: 1 },
    });
  }

  const sectionSpecs = [
    { code: 'CS102-A', course: 'CS102', cap: 40, day: 1, start: 480, end: 540 },
    { code: 'CS103-A', course: 'CS103', cap: 30, day: 2, start: 540, end: 600 },
    { code: 'GE101-A', course: 'GE101', cap: 50, day: 3, start: 480, end: 540 },
  ];
  const room = await prisma.room.findUniqueOrThrow({ where: { code: 'R-201' } });
  for (const spec of sectionSpecs) {
    const existing = await prisma.section.findFirst({ where: { termId: term.id, sectionCode: spec.code } });
    const section = existing ?? (await prisma.section.create({
      data: {
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
  console.log(`  Users: admin/registrar/chair/instructor/cashier @ ${PASSWORD}`);
  console.log(`  Students: ${students.map((s) => s.email).join(', ')} @ ${PASSWORD}`);
  console.log(`  Term ${term.code} open for enrollment until ${term.addDropEndAt.toISOString()}`);

  await prisma.$disconnect();
  void admin;
  void registrar;
  void chair;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
