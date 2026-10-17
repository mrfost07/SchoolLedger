import { Type } from '@sinclair/typebox';
import { DateTime, DecimalString, NullableDateTime, Uuid } from '../../core/http/schemas';

const NullableDate = NullableDateTime;

export const RoomRefSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  building: Type.String(),
});

export const ScheduleRefSchema = Type.Object({
  id: Uuid,
  dayOfWeek: Type.Integer(),
  startMin: Type.Integer(),
  endMin: Type.Integer(),
  room: RoomRefSchema,
});

export const CourseRefSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  title: Type.String(),
  lectureUnits: Type.Integer(),
  labUnits: Type.Integer(),
});

export const SectionRefSchema = Type.Object({
  id: Uuid,
  sectionCode: Type.String(),
  instructorId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  maxCapacity: Type.Integer(),
  enrolledCount: Type.Integer(),
  waitlistCount: Type.Integer(),
  status: Type.String(),
  course: CourseRefSchema,
  schedules: Type.Array(ScheduleRefSchema),
});

export const EnrollmentItemSchema = Type.Object({
  id: Uuid,
  enrollmentId: Uuid,
  sectionId: Uuid,
  status: Type.String(),
  unitsAtReservation: DecimalString,
  createdAt: DateTime,
  enrolledAt: NullableDate,
  droppedAt: NullableDate,
});

export const AssessmentSchema = Type.Object({
  id: Uuid,
  enrollmentId: Uuid,
  status: Type.String(),
  currency: Type.String(),
  breakdown: Type.Any(),
  totalAmount: DecimalString,
  snapshotHash: Type.String(),
  computedAt: DateTime,
  paidAt: NullableDate,
});

export const EnrollmentSchema = Type.Object({
  id: Uuid,
  studentId: Uuid,
  termId: Uuid,
  status: Type.String(),
  createdAt: DateTime,
  confirmedAt: NullableDate,
});

export const ReserveResponseSchema = Type.Object({
  enrollment: EnrollmentSchema,
  items: Type.Array(EnrollmentItemSchema),
  assessment: Type.Union([AssessmentSchema, Type.Null()]),
});

export const EligibilityResponseSchema = Type.Object({
  studentId: Uuid,
  termId: Uuid,
  curriculumVersionId: Uuid,
  eligible: Type.Array(
    Type.Object({
      courseId: Uuid,
      code: Type.String(),
      title: Type.String(),
      lectureUnits: Type.Integer(),
      labUnits: Type.Integer(),
      yearLevel: Type.Integer(),
      termNo: Type.Integer(),
      unlocksCount: Type.Integer(),
    }),
  ),
  blocked: Type.Array(
    Type.Object({
      courseId: Uuid,
      code: Type.String(),
      title: Type.String(),
      reason: Type.String(),
      missingPrerequisites: Type.Array(
        Type.Object({
          courseId: Uuid,
          code: Type.String(),
          minGrade: Type.Union([Type.String(), Type.Null()]),
          requiredType: Type.String(),
        }),
      ),
    }),
  ),
  alreadyPassed: Type.Array(
    Type.Object({ courseId: Uuid, code: Type.String(), title: Type.String(), bestValue: Type.String() }),
  ),
  consumedThisTerm: Type.Array(
    Type.Object({ courseId: Uuid, code: Type.String(), title: Type.String(), status: Type.String(), sectionId: Uuid }),
  ),
});
