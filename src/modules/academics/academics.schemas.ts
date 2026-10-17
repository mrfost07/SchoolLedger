import { Type } from '@sinclair/typebox';
import { DateTime, NullableDateTime, Uuid } from '../../core/http/schemas';

export const DepartmentSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  name: Type.String(),
  createdAt: DateTime,
});

export const ProgramSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  name: Type.String(),
  degreeTitle: Type.String(),
  departmentId: Uuid,
  createdAt: DateTime,
});

export const CurriculumVersionSchema = Type.Object({
  id: Uuid,
  programId: Uuid,
  version: Type.String(),
  name: Type.String(),
  unitsRequired: Type.Integer(),
  status: Type.String(),
  effectiveFrom: NullableDateTime,
  createdAt: DateTime,
});

export const CourseSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  title: Type.String(),
  lectureUnits: Type.Integer(),
  labUnits: Type.Integer(),
  description: Type.Union([Type.String(), Type.Null()]),
  createdAt: DateTime,
});

export const RequisiteTypeSchema = Type.Union([
  Type.Literal('PREREQUISITE'),
  Type.Literal('COREQUISITE'),
  Type.Literal('CONCURRENT'),
]);

export const RoomSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  building: Type.String(),
  capacity: Type.Integer(),
});

export const AcademicTermSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  schoolYear: Type.Integer(),
  termNo: Type.Integer(),
  status: Type.String(),
  startsAt: DateTime,
  endsAt: DateTime,
  enrollmentStartAt: DateTime,
  addDropEndAt: DateTime,
  gradingStartAt: DateTime,
  gradingEndAt: DateTime,
});

export const SectionScheduleSchema = Type.Object({
  id: Uuid,
  sectionId: Uuid,
  termId: Uuid,
  instructorId: Uuid,
  roomId: Uuid,
  dayOfWeek: Type.Integer({ minimum: 1, maximum: 7 }),
  startMin: Type.Integer(),
  endMin: Type.Integer(),
});

export const SectionSchema = Type.Object({
  id: Uuid,
  termId: Uuid,
  courseId: Uuid,
  sectionCode: Type.String(),
  instructorId: Type.Union([Uuid, Type.Null()]),
  maxCapacity: Type.Integer(),
  enrolledCount: Type.Integer(),
  waitlistCount: Type.Integer(),
  status: Type.String(),
  schedules: Type.Optional(Type.Array(SectionScheduleSchema)),
  createdAt: DateTime,
  updatedAt: DateTime,
});

export const ScheduleInputSchema = Type.Object({
  roomId: Uuid,
  dayOfWeek: Type.Integer({ minimum: 1, maximum: 7, description: '1 = Monday … 7 = Sunday' }),
  startMin: Type.Integer({ minimum: 0, maximum: 1439, description: 'minutes from midnight (inclusive)' }),
  endMin: Type.Integer({ minimum: 1, maximum: 1440, description: 'minutes from midnight (exclusive)' }),
});
