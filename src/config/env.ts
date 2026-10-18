import 'dotenv/config';

export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  workersEnabled: boolean;
  publicBaseUrl: string;
  corsOrigins: string[];

  databaseUrl: string;

  redisUrl: string;
  redisRequired: boolean;

  jwtAccessSecret: string;
  jwtMfaSecret: string;
  documentHmacSecret: string;
  presignSecret: string;

  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  mfaTokenTtlMinutes: number;
  stepUpTtlMinutes: number;

  passingGradeMax: string;
  incCompletionDays: number;
  incDefaultGrade: string;
  deansListerMaxGwa: string;
  honorsSummaMax: string;
  honorsMagnaMax: string;
  honorsCumLaudeMax: string;
  maxAcademicUnits: number;

  storageDriver: 'fs' | 's3';
  storageFsDir: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3ForcePathStyle: boolean;
  presignTtlSeconds: number;

  currency: string;

  rateLimitMax: number;
  rateLimitWindowMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function decimalString(name: string, fallback: string): string {
  const raw = str(name, fallback);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`Environment variable ${name} must be a non-negative decimal, got "${raw}"`);
  return raw;
}

export function loadEnv(): Env {
  const nodeEnv = str('NODE_ENV', 'development') as Env['nodeEnv'];
  return {
    nodeEnv,
    port: int('PORT', 3000),
    logLevel: str('LOG_LEVEL', 'info'),
    workersEnabled: bool('WORKERS_ENABLED', true),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    corsOrigins: str('CORS_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    databaseUrl: required('DATABASE_URL'),

    redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
    redisRequired: bool('REDIS_REQUIRED', true),

    jwtAccessSecret: required('JWT_ACCESS_SECRET'),
    jwtMfaSecret: str('JWT_MFA_SECRET', required('JWT_ACCESS_SECRET') + '-mfa'),
    documentHmacSecret: required('DOCUMENT_HMAC_SECRET'),
    presignSecret: str('PRESIGN_SECRET', required('DOCUMENT_HMAC_SECRET') + '-presign'),

    accessTokenTtlMinutes: int('ACCESS_TOKEN_TTL_MINUTES', 15),
    refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
    mfaTokenTtlMinutes: int('MFA_TOKEN_TTL_MINUTES', 5),
    stepUpTtlMinutes: int('STEP_UP_TTL_MINUTES', 5),

    passingGradeMax: decimalString('PASSING_GRADE_MAX', '3.00'),
    incCompletionDays: int('INC_COMPLETION_DAYS', 365),
    incDefaultGrade: decimalString('INC_DEFAULT_GRADE', '5.00'),
    deansListerMaxGwa: decimalString('DEANS_LISTER_MAX_GWA', '1.45'),
    honorsSummaMax: decimalString('HONORS_SUMMA_MAX', '1.20'),
    honorsMagnaMax: decimalString('HONORS_MAGNA_MAX', '1.45'),
    honorsCumLaudeMax: decimalString('HONORS_CUMLAUDE_MAX', '1.75'),
    maxAcademicUnits: int('MAX_ACADEMIC_UNITS', 30),

    storageDriver: str('STORAGE_DRIVER', 'fs') === 's3' ? 's3' : 'fs',
    storageFsDir: str('STORAGE_FS_DIR', './storage'),
    s3Endpoint: str('S3_ENDPOINT', 'http://localhost:9000'),
    s3Region: str('S3_REGION', 'us-east-1'),
    s3Bucket: str('S3_BUCKET', 'schoolledger-documents'),
    s3AccessKey: str('S3_ACCESS_KEY', 'minioadmin'),
    s3SecretKey: str('S3_SECRET_KEY', 'minioadmin'),
    s3ForcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    presignTtlSeconds: int('PRESIGN_TTL_SECONDS', 300),

    currency: str('CURRENCY', 'PHP'),

    rateLimitMax: int('RATE_LIMIT_MAX', 300),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  };
}
