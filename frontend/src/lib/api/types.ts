import type { paths } from "./schema";

export type Me = paths["/api/v1/auth/me"]["get"]["responses"][200]["content"]["application/json"];
export type TermRow =
  paths["/api/v1/academics/terms"]["get"]["responses"][200]["content"]["application/json"][number];
export type Eligibility =
  paths["/api/v1/enrollments/eligibility"]["get"]["responses"][200]["content"]["application/json"];
export type ReserveResult =
  paths["/api/v1/enrollments/reserve"]["post"]["responses"][201]["content"]["application/json"];
export type Assessment =
  paths["/api/v1/enrollments/{enrollmentId}/assessment"]["get"]["responses"][200]["content"]["application/json"];
export type LedgerEntry =
  paths["/api/v1/grading/students/{studentId}/ledger"]["get"]["responses"][200]["content"]["application/json"][number];
export type GwaReport =
  paths["/api/v1/grading/students/{studentId}/gwa"]["get"]["responses"][200]["content"]["application/json"];
export type DocumentRequestRow =
  paths["/api/v1/documents/requests"]["get"]["responses"][200]["content"]["application/json"][number];
export type HoldRow =
  paths["/api/v1/iam/students/{studentId}/holds"]["get"]["responses"][200]["content"]["application/json"][number];

/**
 * Hand-typed shapes mirroring the backend Prisma includes for endpoints whose
 * OpenAPI schemas are `Type.Any()` (verified against academics.service.ts and
 * enrollment.service.ts at build time of this app).
 */
export interface RoomRef {
  id: string;
  code: string;
  building: string | null;
}

export interface SectionSchedule {
  id: string;
  sectionId: string;
  dayOfWeek: number;
  startMin: number;
  endMin: number;
  room: RoomRef;
}

export interface CourseRef {
  id: string;
  code: string;
  title: string;
}

export interface SectionBase {
  id: string;
  sectionCode: string;
  status: "OPEN" | "CLOSED" | "CANCELLED";
  maxCapacity: number;
  course: CourseRef;
  instructor: { id: string; firstName: string; lastName: string } | null;
  schedules: SectionSchedule[];
}

export interface SectionListItem extends Omit<SectionBase, "course"> {
  course: CourseRef & { lectureUnits: number | string; labUnits: number | string };
  _count: { items: number };
}

export interface FeeLineItem {
  code: string;
  name: string;
  category: "TUITION" | "LAB" | "MISC" | "OTHER";
  amount: string;
  detail?: string;
}

export interface FeeDiscount {
  code: string;
  name: string;
  percent: string;
  amount: string;
}

export interface FeeBreakdown {
  currency: string;
  units: { lecture: number; lab: number; total: number };
  lineItems: FeeLineItem[];
  discounts: FeeDiscount[];
  subtotal: string;
  total: string;
}

export type EnrollmentItemBase = ReserveResult["items"][number];

export interface EnrollmentItem extends EnrollmentItemBase {
  section: SectionBase;
}

export interface EnrollmentDetail {
  id: string;
  studentId: string;
  termId: string;
  status: "ENROLLED" | "DROPPED" | "CANCELLED";
  createdAt: string;
  confirmedAt: string | null;
  items: EnrollmentItem[];
  assessment: Assessment | null;
}

export interface CourseRow extends CourseRef {
  lectureUnits: string;
  labUnits: string;
}

export type DocumentTypeValue = DocumentRequestRow["type"];

export type DocumentStatusValue = DocumentRequestRow["status"];

export const OFFICIAL_DOCUMENT_TYPES: DocumentTypeValue[] = [
  "TOR_OFFICIAL",
  "CERT_GRADES",
  "CERT_GOOD_MORAL",
];

// TOR_OFFICIAL is registrar/admin-only (BSL-005/BSL-405); it never appears in
// the student request form but can show up in lists on documents issued for us.
export const REQUESTABLE_DOCUMENT_TYPES: DocumentTypeValue[] = [
  "COR",
  "GRADE_SLIP",
  "TOR_UNOFFICIAL",
  "CERT_GRADES",
  "CERT_GOOD_MORAL",
  "CERT_ENROLLMENT",
];

export const DOCUMENT_TYPE_LABELS: Record<DocumentTypeValue, string> = {
  COR: "Certificate of registration",
  GRADE_SLIP: "Grade slip",
  TOR_UNOFFICIAL: "Unofficial transcript",
  TOR_OFFICIAL: "Official transcript of records",
  CERT_GRADES: "Certified grades",
  CERT_GOOD_MORAL: "Good moral certificate",
  CERT_ENROLLMENT: "Certificate of enrollment",
};
