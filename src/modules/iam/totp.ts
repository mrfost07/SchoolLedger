import { authenticator } from 'otplib';

authenticator.options = { window: 1, step: 30 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function totpKeyUri(accountName: string, issuer: string, secret: string): string {
  return authenticator.keyuri(accountName, issuer, secret);
}

export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

/** Test/demo helper — production never exposes this. */
export function currentTotpCode(secret: string): string {
  return authenticator.generate(secret);
}
