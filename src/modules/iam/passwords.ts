import { hash, verify } from '@node-rs/argon2';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';

const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const PASSWORD_MIN_LENGTH = 10;

/** OWASP-recommended Argon2id parameters; @node-rs/argon2 uses argon2id by default. */
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * Login-time verification that does not leak account existence through timing:
 * when the account (or hash) is missing we still pay one full Argon2id
 * verification against a throwaway hash before failing.
 */
export async function verifyPasswordTimingSafe(storedHash: string | null, plain: string): Promise<boolean> {
  if (storedHash) return verifyPassword(storedHash, plain);
  dummyHashPromise ??= hash('timing-equalization-placeholder-value', ARGON2_OPTIONS);
  await verifyPassword(await dummyHashPromise, plain);
  return false;
}
