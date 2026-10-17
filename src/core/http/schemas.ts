import { Type, type Static } from '@sinclair/typebox';

export const ProblemDetailsSchema = Type.Object(
  {
    type: Type.String({ format: 'uri' }),
    title: Type.String(),
    status: Type.Integer(),
    detail: Type.String(),
    instance: Type.String(),
    code: Type.String(),
    errors: Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
    meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    requestId: Type.Optional(Type.String()),
  },
  { $id: 'ProblemDetails', description: 'RFC 7807 problem details' },
);

export const errorResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
} as const;

export const IdempotencyKeyHeader = Type.Optional(
  Type.String({
    description: 'Idempotency key for safely retrying writes (required on flagged endpoints).',
    maxLength: 200,
  }),
);

export const Uuid = Type.String({ format: 'uuid' });

/**
 * Wire-format helpers. Prisma returns `Date` (serialized to ISO-8601 by
 * JSON.stringify) and `Decimal` (serialized to string via toJSON). The schemas
 * below accept the runtime types at the handler boundary while still emitting
 * precise OpenAPI 3.1 (type arrays) definitions.
 */
export const DateTime = Type.Unsafe<Date | string>({ type: ['string'], format: 'date-time' });
export const NullableDateTime = Type.Unsafe<Date | string | null>({ type: ['string', 'null'], format: 'date-time' });
export const DecimalString = Type.Unsafe<{ toString(): string }>({ type: ['string'] });
export const NullableDecimalString = Type.Unsafe<{ toString(): string } | null>({ type: ['string', 'null'] });

export type ProblemDetailsDto = Static<typeof ProblemDetailsSchema>;
