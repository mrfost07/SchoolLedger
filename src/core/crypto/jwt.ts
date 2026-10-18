import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ErrorCodes, AppError } from '../errors/taxonomy';

export type TokenKind = 'access' | 'mfa';

export interface JwtPayload {
  sub: string;
  typ: TokenKind;
  sid?: string;
  /** School the token is scoped to (active membership at issuance). */
  schoolId?: string;
  roles?: string[];
  mfa?: boolean;
  mfaAt?: number;
  jti: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'> & { jti?: string },
  secret: string,
  ttlSeconds: number,
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const full: JwtPayload = {
    ...payload,
    jti: payload.jti ?? randomBytes(16).toString('hex'),
    iat,
    exp: iat + ttlSeconds,
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(full));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string, secret: string, now: Date): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError(ErrorCodes.TOKEN_INVALID, 'Malformed token');
  const [header, body, signature] = parts as [string, string, string];

  let headerObj: { alg?: string; typ?: string };
  try {
    headerObj = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(ErrorCodes.TOKEN_INVALID, 'Malformed token header');
  }
  if (headerObj.alg !== 'HS256') throw new AppError(ErrorCodes.TOKEN_INVALID, 'Unsupported token algorithm');

  const expected = sign(`${header}.${body}`, secret);
  const given = Buffer.from(signature, 'base64url');
  const want = Buffer.from(expected, 'base64url');
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new AppError(ErrorCodes.TOKEN_INVALID, 'Invalid token signature');
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(ErrorCodes.TOKEN_INVALID, 'Malformed token payload');
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new AppError(ErrorCodes.TOKEN_EXPIRED, 'Token has expired');
  }
  return payload;
}
