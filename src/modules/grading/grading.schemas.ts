import { Type } from '@sinclair/typebox';
import { DateTime, NullableDateTime, NullableDecimalString, Uuid } from '../../core/http/schemas';

export const SheetStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('SUBMITTED'),
  Type.Literal('VERIFIED'),
  Type.Literal('POSTED'),
]);

export const EntryStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('SUBMITTED'),
  Type.Literal('VERIFIED'),
  Type.Literal('POSTED'),
  Type.Literal('SUPERSEDED'),
]);

export const MarkSchema = Type.Union([
  Type.Object({ kind: Type.Literal('NUMERIC'), value: Type.String({ pattern: '^[1-5](\\.\\d{1,2})?$' }) }),
  Type.Object({ kind: Type.Literal('INC') }),
  Type.Object({ kind: Type.Literal('DRP') }),
]);

export const GradeEntrySchema = Type.Object({
  id: Uuid,
  studentId: Uuid,
  courseId: Uuid,
  termId: Uuid,
  sectionId: Uuid,
  status: EntryStatusSchema,
  version: Type.Integer(),
  value: NullableDecimalString,
  isInc: Type.Boolean(),
  incDeadlineAt: NullableDateTime,
  prevHash: Type.Union([Type.String(), Type.Null()]),
  entryHash: Type.Union([Type.String(), Type.Null()]),
  student: Type.Optional(
    Type.Object({ id: Uuid, firstName: Type.String(), lastName: Type.String(), email: Type.String() }),
  ),
});

export const GradeSheetSchema = Type.Object({
  id: Uuid,
  sectionId: Uuid,
  termId: Uuid,
  status: SheetStatusSchema,
  submittedById: Type.Union([Uuid, Type.Null()]),
  submittedAt: NullableDateTime,
  verifiedById: Type.Union([Uuid, Type.Null()]),
  verifiedAt: NullableDateTime,
  postedById: Type.Union([Uuid, Type.Null()]),
  postedAt: NullableDateTime,
  createdAt: Type.Optional(DateTime),
  updatedAt: Type.Optional(DateTime),
  entries: Type.Optional(Type.Array(GradeEntrySchema)),
  section: Type.Optional(
    Type.Object({
      id: Uuid,
      sectionCode: Type.String(),
      course: Type.Object({ id: Uuid, code: Type.String(), title: Type.String() }),
      term: Type.Object({ id: Uuid, code: Type.String() }),
      instructor: Type.Union([
        Type.Object({ id: Uuid, firstName: Type.String(), lastName: Type.String() }),
        Type.Null(),
      ]),
    }),
  ),
});

export const RectificationSchema = Type.Object({
  id: Uuid,
  targetEntryId: Uuid,
  status: Type.Union([
    Type.Literal('PENDING'),
    Type.Literal('CHAIR_ENDORSED'),
    Type.Literal('APPROVED'),
    Type.Literal('REJECTED'),
    Type.Literal('CANCELLED'),
  ]),
  reason: Type.String(),
  proposedValue: NullableDecimalString,
  proposedIsInc: Type.Boolean(),
  requestedById: Uuid,
  endorsedById: Type.Union([Uuid, Type.Null()]),
  approvedById: Type.Union([Uuid, Type.Null()]),
  decisionNote: Type.Union([Type.String(), Type.Null()]),
  decidedAt: NullableDateTime,
  createdAt: DateTime,
});

export const GwaReportSchema = Type.Object({
  studentId: Uuid,
  terms: Type.Array(
    Type.Object({
      termId: Uuid,
      termCode: Type.String(),
      gwa: Type.Union([Type.String(), Type.Null()]),
      units: Type.Integer(),
      entries: Type.Integer(),
      incCount: Type.Integer(),
    }),
  ),
  cumulativeGwa: Type.Union([Type.String(), Type.Null()]),
  totalUnits: Type.Integer(),
  standing: Type.Union([
    Type.Literal('DEANS_LISTER'),
    Type.Literal('GOOD_STANDING'),
    Type.Literal('PROBATION'),
    Type.Literal('DISQUALIFIED'),
  ]),
  latinHonors: Type.Union([
    Type.Literal('SUMMA_CUM_LAUDE'),
    Type.Literal('MAGNA_CUM_LAUDE'),
    Type.Literal('CUM_LAUDE'),
    Type.Null(),
  ]),
});

export const LedgerEntrySchema = Type.Object({
  id: Uuid,
  studentId: Uuid,
  courseId: Uuid,
  termId: Uuid,
  sectionId: Uuid,
  status: EntryStatusSchema,
  version: Type.Integer(),
  value: NullableDecimalString,
  isInc: Type.Boolean(),
  incDeadlineAt: NullableDateTime,
  prevHash: Type.Union([Type.String(), Type.Null()]),
  entryHash: Type.Union([Type.String(), Type.Null()]),
  course: Type.Object({ id: Uuid, code: Type.String(), title: Type.String(), lectureUnits: Type.Integer(), labUnits: Type.Integer() }),
  term: Type.Object({ id: Uuid, code: Type.String() }),
  section: Type.Union([Type.Object({ id: Uuid, sectionCode: Type.String() }), Type.Null()]),
});
