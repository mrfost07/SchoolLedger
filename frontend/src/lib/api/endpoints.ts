import { api, apiFetch } from "./client";
import { toApiError } from "./errors";
import type {
  Assessment,
  DocumentRequestRow,
  DocumentStatusValue,
  DocumentTypeValue,
  Eligibility,
  EnrollmentDetail,
  GwaReport,
  HoldRow,
  LedgerEntry,
  Me,
  ReserveResult,
  SectionListItem,
  TermRow,
} from "./types";

export function fetchMe(): Promise<Me> {
  return apiFetch(api.GET("/api/v1/auth/me"));
}

export function fetchTerms(): Promise<TermRow[]> {
  return apiFetch(api.GET("/api/v1/academics/terms"));
}

export function fetchEligibility(termId: string): Promise<Eligibility> {
  return apiFetch(api.GET("/api/v1/enrollments/eligibility", { params: { query: { termId } } }));
}

export async function fetchEnrollment(termId: string): Promise<EnrollmentDetail | null> {
  const result = await api.GET("/api/v1/enrollments", { params: { query: { termId } } });
  if (result.response.status === 404) return null;
  if (!result.response.ok || result.error !== undefined) {
    throw toApiError(result.error, result.response.status);
  }
  return result.data as unknown as EnrollmentDetail;
}

export async function fetchSections(termId: string, courseId?: string): Promise<SectionListItem[]> {
  const result = await api.GET("/api/v1/academics/terms/{termId}/sections", {
    params: { path: { termId }, query: courseId ? { courseId } : {} },
  });
  return (await apiFetch(Promise.resolve(result))) as unknown as SectionListItem[];
}

export function fetchAssessment(enrollmentId: string): Promise<Assessment> {
  return apiFetch(
    api.GET("/api/v1/enrollments/{enrollmentId}/assessment", {
      params: { path: { enrollmentId } },
    }),
  );
}

export function fetchLedger(studentId: string): Promise<LedgerEntry[]> {
  return apiFetch(
    api.GET("/api/v1/grading/students/{studentId}/ledger", { params: { path: { studentId } } }),
  );
}

export function fetchGwa(studentId: string): Promise<GwaReport> {
  return apiFetch(
    api.GET("/api/v1/grading/students/{studentId}/gwa", { params: { path: { studentId } } }),
  );
}

export function fetchHolds(studentId: string, includeLifted: boolean): Promise<HoldRow[]> {
  return apiFetch(
    api.GET("/api/v1/iam/students/{studentId}/holds", {
      params: { path: { studentId }, query: includeLifted ? { includeLifted: true } : {} },
    }),
  );
}

export function fetchDocuments(
  studentId: string,
  filters?: { type?: DocumentTypeValue; status?: DocumentStatusValue },
): Promise<DocumentRequestRow[]> {
  return apiFetch(
    api.GET("/api/v1/documents/requests", {
      params: {
        query: {
          studentId,
          ...(filters?.type ? { type: filters.type } : {}),
          ...(filters?.status ? { status: filters.status } : {}),
        },
      },
    }),
  );
}

export function fetchDocument(id: string): Promise<DocumentRequestRow> {
  return apiFetch(api.GET("/api/v1/documents/requests/{id}", { params: { path: { id } } }));
}

export function reserveSections(
  body: { termId: string; sectionIds: string[] },
  idempotencyKey: string,
): Promise<ReserveResult> {
  return apiFetch(
    api.POST("/api/v1/enrollments/reserve", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    }),
  );
}

export function dropItem(itemId: string): Promise<{ item: unknown; promoted: boolean }> {
  return apiFetch(api.POST("/api/v1/enrollments/drop", { body: { itemId } }));
}

export function joinWaitlist(termId: string, sectionId: string): Promise<unknown> {
  return apiFetch(api.POST("/api/v1/enrollments/waitlist", { body: { termId, sectionId } }));
}

export function requestDocument(
  body: { type: DocumentTypeValue; termId?: string },
  idempotencyKey: string,
): Promise<DocumentRequestRow> {
  return apiFetch(
    api.POST("/api/v1/documents/requests", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    }),
  );
}

export function fetchDownloadUrl(id: string): Promise<{ documentId: string; url: string; expiresInSeconds: number }> {
  return apiFetch(
    api.GET("/api/v1/documents/requests/{id}/download", { params: { path: { id } } }),
  );
}

export function stepUp(code: string): Promise<unknown> {
  return apiFetch(api.POST("/api/v1/auth/step-up", { body: { code } }));
}

export function totpSetup(): Promise<{ secret: string; otpauthUrl: string }> {
  return apiFetch(api.POST("/api/v1/auth/totp/setup"));
}

export function totpEnable(code: string): Promise<void> {
  return apiFetch(api.POST("/api/v1/auth/totp/enable", { body: { code } }));
}

export function logoutAll(): Promise<{ revokedFamilies: number }> {
  return apiFetch(api.POST("/api/v1/auth/logout-all"));
}
