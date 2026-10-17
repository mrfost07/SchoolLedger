import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ErrorCodes, type ErrorCode } from './taxonomy';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ErrorCode | string;
  errors: Array<{ path: string; message: string }>;
  meta?: Record<string, unknown>;
  requestId?: string;
}

const ERROR_BASE_URI = 'https://errors.school-portal.dev';

export function toProblemDetails(error: unknown, requestId: string, instance: string): ProblemDetails {
  if (error instanceof AppError) {
    return {
      type: `${ERROR_BASE_URI}/${error.code.toLowerCase().replace(/_/g, '-')}`,
      title: httpTitle(error.status),
      status: error.status,
      detail: error.detail,
      instance,
      code: error.code,
      errors: error.errors,
      ...(Object.keys(error.meta).length > 0 ? { meta: error.meta } : {}),
      requestId,
    };
  }
  if (error instanceof Error && error.message.toLowerCase().includes('unique constraint')) {
    return {
      type: `${ERROR_BASE_URI}/conflict`,
      title: httpTitle(409),
      status: 409,
      detail: 'The resource already exists or conflicts with an existing unique constraint.',
      instance,
      code: ErrorCodes.CONFLICT,
      errors: [],
      requestId,
    };
  }
  return {
    type: `${ERROR_BASE_URI}/internal-error`,
    title: httpTitle(500),
    status: 500,
    detail: 'An unexpected internal error occurred. Contact the platform team with the request id.',
    instance,
    code: ErrorCodes.INTERNAL_ERROR,
    errors: [],
    requestId,
  };
}

function httpTitle(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    default:
      return 'Internal Server Error';
  }
}

export function registerProblemErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(function (error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
    const requestId = (request.id as string) ?? 'unknown';
    const instance = request.url;

    if (error.validation) {
      const problem: ProblemDetails = {
        type: `${ERROR_BASE_URI}/validation-failed`,
        title: httpTitle(400),
        status: 400,
        detail: 'Request validation failed.',
        instance,
        code: ErrorCodes.VALIDATION_FAILED,
        errors: (error.validation as Array<{ instancePath?: string; message?: string }>).map((issue) => ({
          path: issue.instancePath ?? '',
          message: issue.message ?? 'invalid',
        })),
        requestId,
      };
      reply.status(400).type('application/problem+json').send(problem);
      return;
    }

    if ((error as FastifyError & { statusCode?: number }).statusCode === 429) {
      const problem = toProblemDetails(new AppError(ErrorCodes.RATE_LIMITED), requestId, instance);
      reply.status(429).type('application/problem+json').send(problem);
      return;
    }

    const problem = toProblemDetails(error, requestId, instance);
    if (problem.status >= 500) {
      request.log.error({ err: error, requestId }, 'unhandled error');
    }
    reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler(function (request, reply) {
    const problem = toProblemDetails(
      new AppError(ErrorCodes.NOT_FOUND, `Route ${request.method} ${request.url} not found`),
      request.id as string,
      request.url,
    );
    reply.status(404).type('application/problem+json').send(problem);
  });
}
