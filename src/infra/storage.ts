import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { Env } from '../config/env';
import { hmacSha256Hex, timingSafeEqualHex } from '../core/crypto/hash';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface StoragePort {
  readonly driver: 'fs' | 's3';
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  /** Returns a time-limited download URL (S3 presigner or HMAC-signed local URL). */
  presignGet(key: string, ttlSeconds: number, downloadFilename?: string): Promise<string>;
  objectKeyHash(key: string): string;
}

export class FsStorage implements StoragePort {
  readonly driver = 'fs' as const;
  private readonly root: string;

  constructor(
    private readonly config: Pick<Env, 'storageFsDir' | 'publicBaseUrl' | 'presignSecret'>,
    rootOverride?: string,
  ) {
    this.root = resolve(rootOverride ?? config.storageFsDir);
  }

  private pathFor(key: string): string {
    const safe = normalize(key).replace(/^([/\\])+/, '');
    const full = join(this.root, safe);
    if (!full.startsWith(this.root + sep) && full !== this.root) {
      throw new Error(`storage key escapes root: ${key}`);
    }
    return full;
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  objectKeyHash(key: string): string {
    return hmacSha256Hex(this.config.presignSecret, key);
  }

  async presignGet(key: string, ttlSeconds: number, downloadFilename?: string): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = FsPresign.sign(this.config.presignSecret, key, exp);
    const query = new URLSearchParams({ exp: String(exp), sig, ...(downloadFilename ? { name: downloadFilename } : {}) });
    return `${this.config.publicBaseUrl}/api/v1/documents/blob/${encodeURIComponent(key)}?${query.toString()}`;
  }
}

/**
 * Filesystem presign format: sig = HMAC-SHA256(secret, `${key}|${exp}`).
 * Only `exp` is signed; expiry is checked separately so the error can be
 * distinguished from a forged signature.
 */
export const FsPresign = {
  sign(secret: string, key: string, expSeconds: number): string {
    return hmacSha256Hex(secret, `${key}|${expSeconds}`);
  },
  verify(
    secret: string,
    key: string,
    expSeconds: number,
    sig: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): 'ok' | 'expired' | 'invalid' {
    const expected = FsPresign.sign(secret, key, expSeconds);
    if (!timingSafeEqualHex(expected, sig)) return 'invalid';
    if (expSeconds < nowSeconds) return 'expired';
    return 'ok';
  },
};

export class S3Storage implements StoragePort {
  readonly driver = 's3' as const;

  constructor(
    private readonly client: {
      putObject: (input: {
        Bucket: string;
        Key: string;
        Body: Buffer;
        ContentType: string;
      }) => Promise<unknown>;
      getObject: (input: { Bucket: string; Key: string }) => Promise<{ Body?: unknown }>;
      presign: (key: string, ttl: number, filename?: string) => Promise<string>;
    },
    private readonly bucket: string,
  ) {}

  async putObject(input: PutObjectInput): Promise<void> {
    await this.client.putObject({ Bucket: this.bucket, Key: input.key, Body: input.body, ContentType: input.contentType });
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.getObject({ Bucket: this.bucket, Key: key });
    const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> } | Buffer | Uint8Array | undefined;
    if (Buffer.isBuffer(body)) return body;
    if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes);
    }
    if (body instanceof Uint8Array) return Buffer.from(body);
    throw new Error('unexpected S3 body type');
  }

  objectKeyHash(key: string): string {
    return createHash('sha256').update(`${this.bucket}/${key}`).digest('hex');
  }

  async presignGet(key: string, ttlSeconds: number, downloadFilename?: string): Promise<string> {
    return this.client.presign(key, ttlSeconds, downloadFilename);
  }
}

export async function createS3Storage(config: Env): Promise<StoragePort> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  });
  return new S3Storage(
    {
      putObject: (input) => client.send(new PutObjectCommand(input)),
      getObject: (input) => client.send(new GetObjectCommand(input)),
      presign: async (key, ttl, filename) =>
        getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: config.s3Bucket,
            Key: key,
            ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename}"` } : {}),
          }),
          { expiresIn: ttl },
        ),
    },
    config.s3Bucket,
  );
}

export async function createStorage(config: Env, fsRootOverride?: string): Promise<StoragePort> {
  if (config.storageDriver === 's3') return createS3Storage(config);
  return new FsStorage(config, fsRootOverride);
}
