export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: Array<{ path: string; message: string }>;
  meta?: Record<string, unknown>;
  requestId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  readonly errors: Array<{ path: string; message: string }>;
  readonly meta: Record<string, unknown> | undefined;

  constructor(problem: ProblemDetails = {}) {
    const detail = problem.detail ?? problem.title ?? "Request failed.";
    super(detail);
    this.name = "ApiError";
    this.code = problem.code ?? "INTERNAL_ERROR";
    this.status = problem.status ?? 500;
    this.detail = detail;
    this.errors = problem.errors ?? [];
    this.meta = problem.meta;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function toApiError(error: unknown, status: number): ApiError {
  if (error instanceof ApiError) return error;
  if (error && typeof error === "object") {
    const problem = error as ProblemDetails;
    return new ApiError({ ...problem, status: problem.status ?? status });
  }
  return new ApiError({ status });
}

export interface ErrorCopy {
  message: string;
  action?: string;
}

const COPY: Record<string, ErrorCopy> = {
  ENROLLMENT_WINDOW_CLOSED: { message: "Enrollment is closed for this term." },
  MAX_UNITS_EXCEEDED: {
    message: "That load is over the maximum for the term.",
    action: "Drop a section, or reserve fewer sections.",
  },
  ALREADY_ENROLLED: { message: "Already reserved for this section." },
  SECTION_FULL: {
    message: "Section is full.",
    action: "Join the waitlist to queue for a seat.",
  },
  WAITLIST_NOT_AVAILABLE: { message: "The waitlist is not open for this section." },
  SCHEDULE_CONFLICT: { message: "This schedule conflicts with another reserved section." },
  SCHEDULE_CONFLICT_STUDENT: {
    message: "This schedule conflicts with your current classes.",
    action: "Remove the conflicting block, then reserve again.",
  },
  PREREQUISITE_NOT_MET: { message: "A prerequisite is not met yet." },
  COREQUISITE_NOT_MET: { message: "A corequisite is not met yet." },
  STUDENT_CLEARANCE_HOLD: {
    message:
      "Clearance hold. Enrollment and official documents are blocked until the cashier lifts it.",
    action: "View holds",
  },
  STUDENT_PROFILE_REQUIRED: { message: "Your student profile is incomplete." },
  STEP_UP_REQUIRED: { message: "Confirm it's you to continue." },
  STEP_UP_MFA_NOT_ENROLLED: {
    message: "Set up your authenticator app first.",
    action: "Open Account",
  },
  DOCUMENT_NOT_READY: { message: "The document is still being prepared." },
  DOCUMENT_EXPIRED: {
    message: "This download link has expired.",
    action: "Request a fresh link.",
  },
  DOCUMENT_REVOKED: { message: "This document request was revoked." },
  DOCUMENT_NOT_FOUND: { message: "Document not found." },
  IDEMPOTENT_REQUEST_IN_PROGRESS: {
    message: "This request is already in progress.",
    action: "Wait a moment, then try again.",
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    message: "Something went wrong preparing this request.",
    action: "Try again.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    message: "This request was already completed.",
    action: "Start a new request.",
  },
  RATE_LIMITED: { message: "Too many attempts. Try again in a minute." },
  NOT_ENROLLED: { message: "You are no longer enrolled in this section." },
  UNSIGNED_DOCUMENT_URL: { message: "That download link is not valid." },
  AUTH_INVALID_CREDENTIALS: { message: "Incorrect email or password." },
  AUTH_MFA_INVALID: { message: "That code is not right. Try the next one from your app." },
  AUTH_MFA_REQUIRED: { message: "Enter your authenticator code to continue." },
  AUTH_MFA_ALREADY_ENABLED: { message: "Authenticator is already set up." },
  AUTH_MFA_NOT_SETUP: { message: "Authenticator is not set up yet." },
  AUTH_ACCOUNT_DISABLED: { message: "This account is disabled." },
  REFRESH_TOKEN_REUSED: { message: "Your session was closed for security. Sign in again." },
  REFRESH_TOKEN_INVALID: { message: "Your session expired. Sign in again." },
  TOKEN_EXPIRED: { message: "Your session expired. Sign in again." },
  TOKEN_INVALID: { message: "Sign in again to continue." },
  UNAUTHENTICATED: { message: "Sign in to continue." },
  FORBIDDEN: { message: "You don't have access to this." },
  NOT_FOUND: { message: "Not found." },
  VALIDATION_FAILED: { message: "Check the form and try again." },
  CONFLICT: { message: "That conflicts with the current state.", action: "Refresh and try again." },
  INTERNAL_ERROR: {
    message: "Something failed on our side. Try again in a moment.",
  },
};

const FALLBACK: ErrorCopy = { message: "Request failed." };

export function codeCopy(code: string | undefined): ErrorCopy {
  if (!code) return COPY.INTERNAL_ERROR;
  return COPY[code] ?? FALLBACK;
}

export function messageFor(error: unknown): string {
  if (isApiError(error)) return codeCopy(error.code).message;
  if (error instanceof Error) return error.message;
  return FALLBACK.message;
}
