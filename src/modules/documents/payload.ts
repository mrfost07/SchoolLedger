import type { DocumentType, PrismaClient } from '@prisma/client';
import type { Env } from '../../config/env';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { GradingService } from '../grading/grading.service';
import { signSnapshot, snapshotHashOf, verifyUrlFor, serialHashOf } from './signing';

/** Document types that require the student to be in good standing (BSL-007). */
export const OFFICIAL_DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set([
  'TOR_OFFICIAL',
  'CERT_GRADES',
  'CERT_GOOD_MORAL',
]);

export interface DocumentSnapshotCore {
  documentType: DocumentType;
  serialNo: string;
  issuedAt: string;
  student: {
    id: string;
    studentNo: string;
    firstName: string;
    lastName: string;
    email: string;
    yearLevel: number;
    program: { code: string; name: string; degreeTitle: string };
    curriculumVersion: string;
  };
  term: { id: string; code: string; schoolYear: number; termNo: number } | null;
  grades?: {
    cumulativeGwa: string | null;
    totalUnits: number;
    standing: string;
    latinHonors: string | null;
    terms: Array<{ termCode: string; gwa: string | null; units: number }>;
    entries: Array<{ termCode: string; courseCode: string; courseTitle: string; units: number; mark: string }>;
  };
  enrollment?: {
    status: string;
    items: Array<{ sectionCode: string; courseCode: string; courseTitle: string; units: number; status: string }>;
    assessment: { currency: string; totalAmount: string; status: string; computedAt: string } | null;
  };
  remarks?: string[];
}

export interface DocumentSnapshot extends DocumentSnapshotCore {
  verification: { serialHash: string; verifyUrl: string };
}

export interface BuiltDocument {
  snapshot: DocumentSnapshot;
  snapshotHash: string;
  signature: string;
  serialNo: string;
  serialHash: string;
}

function markOf(entry: { isInc: boolean; value: unknown }): string {
  if (entry.isInc) return 'INC';
  if (entry.value === null || entry.value === undefined) return 'DRP';
  return String(entry.value);
}

export interface SnapshotDependencies {
  prisma: PrismaClient;
  grading: GradingService;
  config: Pick<Env, 'documentHmacSecret' | 'publicBaseUrl'>;
}

/**
 * Builds and cryptographically seals the frozen issuance snapshot.
 * Whatever ends up in `snapshot` is exactly what the PDF renders — later data
 * changes never alter an issued document (BSL-4xx: point-in-time issuance).
 */
export async function buildDocumentSnapshot(
  deps: SnapshotDependencies,
  input: { studentId: string; type: DocumentType; termId?: string | null; serialNo: string; now: Date },
): Promise<BuiltDocument> {
  const { prisma, grading, config } = deps;

  const student = await prisma.user.findUnique({
    where: { id: input.studentId },
    include: { profile: { include: { program: true, curriculumVersion: true } } },
  });
  if (!student || !student.profile) {
    throw new AppError(ErrorCodes.STUDENT_PROFILE_REQUIRED, 'User has no student profile.');
  }

  let term: DocumentSnapshotCore['term'] = null;
  if (input.termId) {
    const record = await prisma.academicTerm.findUnique({ where: { id: input.termId } });
    if (!record) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    term = { id: record.id, code: record.code, schoolYear: record.schoolYear, termNo: record.termNo };
  }

  const core: DocumentSnapshotCore = {
    documentType: input.type,
    serialNo: input.serialNo,
    issuedAt: input.now.toISOString(),
    student: {
      id: student.id,
      studentNo: student.profile.studentNo,
      firstName: student.firstName,
      lastName: student.lastName,
      email: student.email,
      yearLevel: student.profile.yearLevel,
      program: {
        code: student.profile.program.code,
        name: student.profile.program.name,
        degreeTitle: student.profile.program.degreeTitle,
      },
      curriculumVersion: student.profile.curriculumVersion.version,
    },
    term,
  };

  const needsGrades =
    input.type === 'TOR_UNOFFICIAL' || input.type === 'TOR_OFFICIAL' || input.type === 'CERT_GRADES' || input.type === 'GRADE_SLIP';
  const needsEnrollment = input.type === 'COR' || input.type === 'CERT_ENROLLMENT' || input.type === 'GRADE_SLIP';

  if (needsGrades) {
    const report = await grading.computeStudentGwa(input.studentId);
    const ledger = await prisma.gradeLedgerEntry.findMany({
      where: {
        studentId: input.studentId,
        status: 'POSTED',
        ...(input.type === 'GRADE_SLIP' && input.termId ? { termId: input.termId } : {}),
      },
      include: {
        course: { select: { code: true, title: true, lectureUnits: true, labUnits: true } },
        term: { select: { code: true } },
      },
      orderBy: [{ term: { startsAt: 'asc' } }, { course: { code: 'asc' } }],
    });
    if (input.type === 'GRADE_SLIP' && input.termId && ledger.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'No posted grades exist for this term.');
    }
    core.grades = {
      cumulativeGwa: report.cumulativeGwa,
      totalUnits: report.totalUnits,
      standing: report.standing,
      latinHonors: report.latinHonors,
      terms: report.terms.map((t) => ({ termCode: t.termCode, gwa: t.gwa, units: t.units })),
      entries: ledger.map((entry) => ({
        termCode: entry.term.code,
        courseCode: entry.course.code,
        courseTitle: entry.course.title,
        units: entry.course.lectureUnits + entry.course.labUnits,
        mark: markOf(entry),
      })),
    };
  }

  if (needsEnrollment) {
    if (!input.termId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, `Document type ${input.type} requires a termId.`);
    }
    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_termId: { studentId: input.studentId, termId: input.termId } },
      include: {
        items: { include: { section: { include: { course: true } } } },
        assessment: true,
      },
    });
    if (!enrollment) {
      throw new AppError(ErrorCodes.NOT_ENROLLED, 'No enrollment record for this student in the requested term.');
    }
    core.enrollment = {
      status: enrollment.status,
      items: enrollment.items.map((item) => ({
        sectionCode: item.section.sectionCode,
        courseCode: item.section.course.code,
        courseTitle: item.section.course.title,
        units: Number(item.unitsAtReservation),
        status: item.status,
      })),
      assessment: enrollment.assessment
        ? {
            currency: enrollment.assessment.currency,
            totalAmount: enrollment.assessment.totalAmount.toString(),
            status: enrollment.assessment.status,
            computedAt: enrollment.assessment.computedAt.toISOString(),
          }
        : null,
    };
  }

  if (input.type === 'CERT_GOOD_MORAL') {
    core.remarks = [
      'The student has no pending disciplinary case on record as of the issuance date.',
      'Any subsequently filed case renders this certification subject to review.',
    ];
  }

  const snapshotHash = snapshotHashOf(core);
  const signature = signSnapshot(config.documentHmacSecret, snapshotHash);
  const serialHash = serialHashOf(input.serialNo, signature);
  const snapshot: DocumentSnapshot = {
    ...core,
    verification: { serialHash, verifyUrl: verifyUrlFor(config.publicBaseUrl, serialHash) },
  };

  return { snapshot, snapshotHash, signature, serialNo: input.serialNo, serialHash };
}
