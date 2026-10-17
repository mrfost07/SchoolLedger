/**
 * Prints the current TOTP code for a base32 secret (RFC 6238, 30s step, 6 digits).
 * Usage: node scripts/dev-totp.mjs <BASE32_SECRET>
 */
import { createHmac } from "node:crypto";

const secret = process.argv[2];
if (!secret) {
  console.error("usage: node scripts/dev-totp.mjs <BASE32_SECRET>");
  process.exit(1);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = "";
for (const char of secret.replace(/=+$/, "").toUpperCase()) {
  const value = ALPHABET.indexOf(char);
  if (value < 0) {
    console.error(`invalid base32 character: ${char}`);
    process.exit(1);
  }
  bits += value.toString(2).padStart(5, "0");
}

const bytes = [];
for (let index = 0; index + 8 <= bits.length; index += 8) {
  bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
}

const counter = Math.floor(Date.now() / 30_000);
const counterBuffer = Buffer.alloc(8);
counterBuffer.writeBigUInt64BE(BigInt(counter));

const hmac = createHmac("sha1", Buffer.from(bytes)).update(counterBuffer).digest();
const offset = hmac[hmac.length - 1] & 0x0f;
const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
const code = (binary % 1_000_000).toString().padStart(6, "0");

console.log(code);
