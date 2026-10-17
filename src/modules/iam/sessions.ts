import type Redis from 'ioredis';
import type { Env } from '../../config/env';
import { sha256Hex } from '../../core/crypto/hash';
import { randomToken } from '../../core/crypto/tokens';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';

interface RefreshTokenRecord {
  familyId: string;
  userId: string;
  used: boolean;
}

interface RefreshFamily {
  userId: string;
  revoked: boolean;
  currentHash: string;
}

export interface SessionIssue {
  refreshToken: string;
  familyId: string;
}

export interface SessionRotation extends SessionIssue {
  userId: string;
}

const rtKey = (hash: string) => `rt:${hash}`;
const famKey = (familyId: string) => `rtfam:${familyId}`;
const userFamiliesKey = (userId: string) => `rtuser:${userId}`;

/**
 * Atomic rotate — serialized inside Redis, so the read-verify-write sequence
 * cannot interleave. KEYS: [current rt, next rt]; ARGV: [ttl, family prefix,
 * current hash, next hash]. Returns [status, familyId?, userId?].
 */
const ROTATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'MISSING'} end
local record = cjson.decode(raw)
local famKey = ARGV[2] .. record.familyId
if record.used then
  local fam = redis.call('GET', famKey)
  if fam then
    local f = cjson.decode(fam)
    f.revoked = true
    redis.call('SET', famKey, cjson.encode(f), 'EX', ARGV[1])
  end
  return {'REUSED', record.familyId, record.userId}
end
local rawFam = redis.call('GET', famKey)
if not rawFam then return {'MISSING'} end
local family = cjson.decode(rawFam)
if family.revoked then return {'REVOKED'} end
if family.currentHash ~= ARGV[3] then
  family.revoked = true
  redis.call('SET', famKey, cjson.encode(family), 'EX', ARGV[1])
  return {'REUSED', record.familyId, record.userId}
end
record.used = true
redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ARGV[1])
redis.call('SET', KEYS[2], cjson.encode({familyId = record.familyId, userId = record.userId, used = false}), 'EX', ARGV[1])
family.currentHash = ARGV[4]
redis.call('SET', famKey, cjson.encode(family), 'EX', ARGV[1])
return {'OK', record.familyId, record.userId}
`;

/**
 * Refresh token rotation with reuse detection (BSL-003, BSL-004).
 *
 * Storage layout (Redis):
 *   rt:{sha256(token)}          → { familyId, userId, used }
 *   rtfam:{familyId}            → { userId, revoked, currentHash }
 *   rtuser:{userId}             → SET of familyIds
 *
 * Presenting a token that was already rotated (used=true) revokes the whole
 * family — the classic stolen-token response.
 */
export class SessionService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: Redis,
    private readonly config: Pick<Env, 'refreshTokenTtlDays'>,
  ) {
    this.ttlSeconds = config.refreshTokenTtlDays * 86_400;
  }

  async issue(userId: string): Promise<SessionIssue> {
    const familyId = randomToken(16);
    const refreshToken = randomToken(32);
    const tokenHash = sha256Hex(refreshToken);

    const record: RefreshTokenRecord = { familyId, userId, used: false };
    const family: RefreshFamily = { userId, revoked: false, currentHash: tokenHash };

    await this.redis
      .multi()
      .set(rtKey(tokenHash), JSON.stringify(record), 'EX', this.ttlSeconds)
      .set(famKey(familyId), JSON.stringify(family), 'EX', this.ttlSeconds)
      .sadd(userFamiliesKey(userId), familyId)
      .expire(userFamiliesKey(userId), this.ttlSeconds)
      .exec();

    return { refreshToken, familyId };
  }

  /**
   * Atomically rotates a refresh token. Runs as a single Lua script so that
   * two concurrent presentations of the same token can never both succeed:
   * the winner advances the family; the loser is treated as reuse and the
   * whole family is revoked.
   */
  async rotate(presentedToken: string): Promise<SessionRotation> {
    const tokenHash = sha256Hex(presentedToken);
    const nextToken = randomToken(32);
    const nextHash = sha256Hex(nextToken);

    const result = (await this.redis.eval(
      ROTATE_SCRIPT,
      2,
      rtKey(tokenHash),
      rtKey(nextHash),
      String(this.ttlSeconds),
      'rtfam:',
      tokenHash,
      nextHash,
    )) as [string, string?, string?];

    const status = result[0];
    if (status === 'OK') {
      return { refreshToken: nextToken, familyId: result[1]!, userId: result[2]! };
    }
    if (status === 'REUSED') {
      throw new AppError(
        ErrorCodes.REFRESH_TOKEN_REUSED,
        'Refresh token reuse detected — all sessions in this family were revoked.',
        { meta: { familyId: result[1], userId: result[2] } },
      );
    }
    if (status === 'REVOKED') {
      throw new AppError(ErrorCodes.REFRESH_TOKEN_INVALID, 'Session was revoked.');
    }
    throw new AppError(ErrorCodes.REFRESH_TOKEN_INVALID, 'Refresh token is unknown or expired.');
  }

  async revokeFamily(familyId: string): Promise<void> {
    const rawFamily = await this.redis.get(famKey(familyId));
    if (!rawFamily) return;
    const family = JSON.parse(rawFamily) as RefreshFamily;
    await this.redis.set(famKey(familyId), JSON.stringify({ ...family, revoked: true }), 'EX', this.ttlSeconds);
  }

  async revokeByToken(presentedToken: string): Promise<string | null> {
    const tokenHash = sha256Hex(presentedToken);
    const raw = await this.redis.get(rtKey(tokenHash));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshTokenRecord;
    await this.revokeFamily(record.familyId);
    return record.familyId;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const familyIds = await this.redis.smembers(userFamiliesKey(userId));
    await Promise.all(familyIds.map((familyId) => this.revokeFamily(familyId)));
    return familyIds.length;
  }
}
