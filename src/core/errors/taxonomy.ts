/**
 * Error taxonomy — single source of truth for all machine-readable error codes.
 * Codes are exposed in RFC 7807 bodies as `code` and in `type` URLs.
 */
export const ErrorCodes = {
  // Generic
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // IAM
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
  AUTH_MFA_REQUIRED: 'AUTH_MFA_REQUIRED',
  AUTH_MFA_INVALID: 'AUTH_MFA_INVALID',
  AUTH_MFA_ALREADY_ENABLED: 'AUTH_MFA_ALREADY_ENABLED',
  AUTH_MFA_NOT_SETUP: 'AUTH_MFA_NOT_SETUP',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  STEP_UP_MFA_NOT_ENROLLED: 'STEP_UP_MFA_NOT_ENROLLED',

  // Clearance / holds
  STUDENT_CLEARANCE_HOLD: 'STUDENT_CLEARANCE_HOLD',
  STUDENT_PROFILE_REQUIRED: 'STUDENT_PROFILE_REQUIRED',

  // Academics
  DAG_CYCLE_DETECTED: 'DAG_CYCLE_DETECTED',
  DAG_SELF_REFERENCE: 'DAG_SELF_REFERENCE',
  SCHEDULE_CONFLICT: 'SCHEDULE_CONFLICT',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  INVALID_TERM_STATUS: 'INVALID_TERM_STATUS',
  INVALID_TERM_TRANSITION: 'INVALID_TERM_TRANSITION',
  INSTRUCTOR_WINDOW_CLOSED: 'INSTRUCTOR_WINDOW_CLOSED',

  // Enrollment
  ENROLLMENT_WINDOW_CLOSED: 'ENROLLMENT_WINDOW_CLOSED',
  PREREQUISITE_NOT_MET: 'PREREQUISITE_NOT_MET',
  COREQUISITE_NOT_MET: 'COREQUISITE_NOT_MET',
  SECTION_FULL: 'SECTION_FULL',
  SECTION_NOT_OPEN: 'SECTION_NOT_OPEN',
  ALREADY_ENROLLED: 'ALREADY_ENROLLED',
  NOT_ENROLLED: 'NOT_ENROLLED',
  MAX_UNITS_EXCEEDED: 'MAX_UNITS_EXCEEDED',
  SCHEDULE_CONFLICT_STUDENT: 'SCHEDULE_CONFLICT_STUDENT',
  WAITLIST_NOT_AVAILABLE: 'WAITLIST_NOT_AVAILABLE',

  // Grading
  GRADE_SHEET_NOT_FOUND: 'GRADE_SHEET_NOT_FOUND',
  GRADE_STATE_INVALID: 'GRADE_STATE_INVALID',
  GRADE_IMMUTABLE: 'GRADE_IMMUTABLE',
  GRADE_OUT_OF_RANGE: 'GRADE_OUT_OF_RANGE',
  RECTIFICATION_REQUIRED: 'RECTIFICATION_REQUIRED',
  RECTIFICATION_INVALID_STATE: 'RECTIFICATION_INVALID_STATE',
  INC_DEADLINE_NOT_EXPIRED: 'INC_DEADLINE_NOT_EXPIRED',

  // Documents
  DOCUMENT_NOT_READY: 'DOCUMENT_NOT_READY',
  DOCUMENT_EXPIRED: 'DOCUMENT_EXPIRED',
  DOCUMENT_REVOKED: 'DOCUMENT_REVOKED',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  UNSIGNED_DOCUMENT_URL: 'UNSIGNED_DOCUMENT_URL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AppErrorOptions {
  status?: number;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
  meta?: Record<string, unknown>;
  expose?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string;
  readonly errors: Array<{ path: string; message: string }>;
  readonly meta: Record<string, unknown>;
  readonly expose: boolean;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.detail = options.detail ?? message ?? defaultDetail(code);
    this.errors = options.errors ?? [];
    this.meta = options.meta ?? {};
    this.expose = options.expose ?? true;
  }
}

function defaultStatus(code: ErrorCode): number {
  if (
    code === ErrorCodes.UNAUTHENTICATED ||
    code === ErrorCodes.AUTH_INVALID_CREDENTIALS ||
    code === ErrorCodes.AUTH_MFA_REQUIRED ||
    code === ErrorCodes.AUTH_MFA_INVALID ||
    code === ErrorCodes.TOKEN_INVALID ||
    code === ErrorCodes.TOKEN_EXPIRED ||
    code === ErrorCodes.REFRESH_TOKEN_INVALID ||
    code === ErrorCodes.REFRESH_TOKEN_REUSED ||
    code === ErrorCodes.UNSIGNED_DOCUMENT_URL
  ) {
    return 401;
  }
  if (
    code === ErrorCodes.FORBIDDEN ||
    code === ErrorCodes.STEP_UP_REQUIRED ||
    code === ErrorCodes.STEP_UP_MFA_NOT_ENROLLED ||
    code === ErrorCodes.INSTRUCTOR_WINDOW_CLOSED
  ) {
    return 403;
  }
  if (code === ErrorCodes.NOT_FOUND || code === ErrorCodes.ROOM_NOT_FOUND || code === ErrorCodes.DOCUMENT_NOT_FOUND) {
    return 404;
  }
  if (code === ErrorCodes.VALIDATION_FAILED || code === ErrorCodes.DAG_SELF_REFERENCE || code === ErrorCodes.IDEMPOTENCY_KEY_REQUIRED)
    return 400;
  if (
    code === ErrorCodes.SECTION_FULL ||
    code === ErrorCodes.CONFLICT ||
    code === ErrorCodes.IDEMPOTENT_REQUEST_IN_PROGRESS ||
    code === ErrorCodes.IDEMPOTENCY_KEY_REUSED
  ) {
    return 409;
  }
  if (
    code === ErrorCodes.SCHEDULE_CONFLICT ||
    code === ErrorCodes.SCHEDULE_CONFLICT_STUDENT ||
    code === ErrorCodes.PREREQUISITE_NOT_MET ||
    code === ErrorCodes.COREQUISITE_NOT_MET ||
    code === ErrorCodes.DAG_CYCLE_DETECTED ||
    code === ErrorCodes.GRADE_STATE_INVALID ||
    code === ErrorCodes.GRADE_IMMUTABLE ||
    code === ErrorCodes.GRADE_OUT_OF_RANGE ||
    code === ErrorCodes.RECTIFICATION_REQUIRED ||
    code === ErrorCodes.RECTIFICATION_INVALID_STATE ||
    code === ErrorCodes.INC_DEADLINE_NOT_EXPIRED ||
    code === ErrorCodes.ENROLLMENT_WINDOW_CLOSED ||
    code === ErrorCodes.INVALID_TERM_STATUS ||
    code === ErrorCodes.INVALID_TERM_TRANSITION ||
    code === ErrorCodes.STUDENT_CLEARANCE_HOLD ||
    code === ErrorCodes.MAX_UNITS_EXCEEDED ||
    code === ErrorCodes.ALREADY_ENROLLED ||
    code === ErrorCodes.NOT_ENROLLED ||
    code === ErrorCodes.SECTION_NOT_OPEN ||
    code === ErrorCodes.WAITLIST_NOT_AVAILABLE ||
    code === ErrorCodes.DOCUMENT_NOT_READY ||
    code === ErrorCodes.DOCUMENT_EXPIRED ||
    code === ErrorCodes.DOCUMENT_REVOKED ||
    code === ErrorCodes.STUDENT_PROFILE_REQUIRED ||
    code === ErrorCodes.AUTH_MFA_ALREADY_ENABLED ||
    code === ErrorCodes.AUTH_MFA_NOT_SETUP ||
    code === ErrorCodes.AUTH_ACCOUNT_DISABLED
  ) {
    return 422;
  }
  if (code === ErrorCodes.RATE_LIMITED) return 429;
  return 500;
}

function defaultDetail(code: ErrorCode): string {
  return code
    .toLowerCase()
    .split('_')
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}
