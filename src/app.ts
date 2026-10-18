import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppContext, BackgroundDispatcher } from './context';
import type { AppServer } from './core/http/server-types';
import { registerProblemErrorHandler } from './core/errors/problem';
import { requirePermission } from './core/http/auth';
import { runWithStore, runWithTenant } from './core/tenant/context';
import { PERMISSIONS } from './modules/iam/permissions';
import { createPrismaClient } from './infra/prisma';
import { createQueues, createBullDispatcher, createInlineDispatcher, type Queues } from './infra/queues';
import { AuditService } from './modules/audit/audit.service';
import { IamService } from './modules/iam/iam.service';
import { HoldsService } from './modules/iam/holds.service';
import { SessionService } from './modules/iam/sessions';
import { registerIamRoutes } from './modules/iam/iam.routes';
import { AcademicsService } from './modules/academics/academics.service';
import { SectionAccessService } from './modules/academics/guards';
import { registerAcademicsRoutes } from './modules/academics/academics.routes';
import { GradingService } from './modules/grading/grading.service';
import { RectificationService } from './modules/grading/rectification.service';
import { IncLifecycleService } from './modules/grading/inc.worker';
import { registerGradingRoutes } from './modules/grading/grading.routes';
import { EligibilityService } from './modules/enrollment/eligibility.service';
import { EnrollmentService } from './modules/enrollment/enrollment.service';
import { FeesService } from './modules/enrollment/fees.service';
import { WaitlistPromotionService } from './modules/enrollment/waitlist.worker';
import { RedisCapacityGate, DatabaseCapacityGate, type CapacityGate } from './modules/enrollment/capacity';
import { registerEnrollmentRoutes } from './modules/enrollment/enrollment.routes';
import { DocumentsService } from './modules/documents/documents.service';
import { DocumentRenderWorker } from './modules/documents/documents.worker';
import { registerDocumentRoutes } from './modules/documents/documents.routes';

export interface ComposedServices {
  audit: AuditService;
  holds: HoldsService;
  iam: IamService;
  sectionAccess: SectionAccessService;
  academics: AcademicsService;
  grading: GradingService;
  rectifications: RectificationService;
  inc: IncLifecycleService;
  eligibility: EligibilityService;
  fees: FeesService;
  gate: CapacityGate;
  enrollment: EnrollmentService;
  waitlist: WaitlistPromotionService;
  documents: DocumentsService;
  documentWorker: DocumentRenderWorker;
  queues: Queues | null;
  dispatcher: BackgroundDispatcher;
  close(): Promise<void>;
}

export interface ComposeOptions {
  /** Force the inline dispatcher even when Redis is present (tests). */
  inlineJobs?: boolean;
}

/**
 * Service graph. The background dispatcher is BullMQ when Redis is present and
 * inline otherwise; inline handlers close over the services (defined after the
 * dispatcher, which is safe because they only run post-construction).
 */
export function composeServices(ctx: AppContext, options: ComposeOptions = {}): ComposedServices {
  const { prisma, redis, storage, clock, config, logger } = ctx;

  const audit = new AuditService(prisma);
  const holds = new HoldsService(prisma, audit);
  const sessions = redis ? new SessionService(redis, config) : null;
  const iam = new IamService(prisma, sessions, audit, config);
  const sectionAccess = new SectionAccessService(prisma, clock);
  const academics = new AcademicsService(prisma, audit);
  const grading = new GradingService(prisma, audit, sectionAccess, clock, config);
  const rectifications = new RectificationService(prisma, audit, clock, config);
  const inc = new IncLifecycleService(prisma, audit, clock, config);
  const eligibility = new EligibilityService(prisma, config);
  const fees = new FeesService(prisma, audit, config);
  const gate: CapacityGate = redis ? new RedisCapacityGate(redis) : new DatabaseCapacityGate(prisma);
  const waitlist = new WaitlistPromotionService(prisma, audit, holds, eligibility, gate, fees, clock);

  const queues = redis && !options.inlineJobs ? createQueues(redis) : null;
  const dispatcher: BackgroundDispatcher = queues
    ? createBullDispatcher(queues)
    : createInlineDispatcher({
        renderDocument: async (schoolId, documentId) => {
          await runWithTenant(schoolId, () => documentWorker.render({ schoolId, documentId }));
        },
        promoteWaitlist: async (schoolId, termId, sectionId) => {
          await runWithTenant(schoolId, () => waitlist.promote(termId, sectionId));
        },
      });

  const enrollment = new EnrollmentService(prisma, audit, holds, eligibility, gate, fees, clock, config, dispatcher);
  const documents = new DocumentsService(prisma, audit, holds, grading, storage, dispatcher, clock, config);
  const documentWorker = new DocumentRenderWorker(documents, storage, logger);

  return {
    audit,
    holds,
    iam,
    sectionAccess,
    academics,
    grading,
    rectifications,
    inc,
    eligibility,
    fees,
    gate,
    enrollment,
    waitlist,
    documents,
    documentWorker,
    queues,
    dispatcher,
    close: async () => {
      if (queues) await queues.close();
    },
  };
}

export function buildApp(ctx: AppContext, services: ComposedServices): AppServer {
  const app = Fastify({
    loggerInstance: ctx.logger,
    trustProxy: true,
  }).withTypeProvider<TypeBoxTypeProvider>() as unknown as AppServer;

  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'SchoolLedger API',
        description:
          'Headless Student Information & Academic Management System. Concurrency-safe enrollment, immutable grade ledger, signed document issuance.',
        version: '1.0.0',
        license: { name: 'Proprietary' },
      },
      servers: [{ url: ctx.config.publicBaseUrl, description: 'Primary' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      tags: [
        { name: 'Auth', description: 'Authentication, sessions, MFA' },
        { name: 'IAM', description: 'Users and holds' },
        { name: 'Academics', description: 'Curricula, terms, sections, schedules' },
        { name: 'Enrollment', description: 'Eligibility, reservation, waitlists, fees' },
        { name: 'Grading', description: 'Grade sheets, immutable ledger, GWA, rectification, INC' },
        { name: 'Documents', description: 'Document issuance, signed PDFs, verification' },
      ],
    },
  });

  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cors, {
    origin: ctx.config.corsOrigins.length > 0 ? ctx.config.corsOrigins : false,
    credentials: true,
  });
  app.register(rateLimit, {
    global: false,
    max: ctx.config.rateLimitMax,
    timeWindow: ctx.config.rateLimitWindowMs,
  });

  registerProblemErrorHandler(app);

  // Policy coverage (ADR-0004): every authenticated route must declare
  // `config.permission` with codes from the registry, and the check is
  // enforced as a preHandler. Unknown/absent declarations fail app startup.
  const permissionCodes = new Set(PERMISSIONS.map((permission) => permission.code));
  app.addHook('onRoute', (routeOptions) => {
    const security = routeOptions.schema?.security;
    const authenticated = Array.isArray(security) && security.length > 0;
    const declared = (routeOptions.config as { permission?: string | string[] } | undefined)?.permission;
    const label = `${routeOptions.method} ${routeOptions.url}`;
    if (!authenticated) {
      if (declared !== undefined) {
        throw new Error(`Policy coverage: public route ${label} must not declare config.permission.`);
      }
      return;
    }
    if (declared === undefined) {
      throw new Error(`Policy coverage: authenticated route ${label} declares no config.permission.`);
    }
    const codes = Array.isArray(declared) ? declared : [declared];
    if (codes.length === 0) {
      throw new Error(`Policy coverage: authenticated route ${label} declares an empty permission list.`);
    }
    for (const code of codes) {
      if (!permissionCodes.has(code)) {
        throw new Error(`Policy coverage: route ${label} declares unknown permission '${code}'.`);
      }
    }
    const existing = routeOptions.preHandler;
    const handlers = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    routeOptions.preHandler = [
      ...handlers,
      async (request) => {
        requirePermission(request, ctx.config, codes);
      },
    ];
  });

  // Tenant context frame (ADR-0001): every request starts with an unbound
  // store; the auth layer binds the school once the JWT is verified. The
  // callback-style hook is required so the AsyncLocalStorage frame covers the
  // rest of the request pipeline (handler + services).
  app.addHook('onRequest', (_request, _reply, done) => {
    runWithStore({ schoolId: null, system: false }, () => done());
  });

  // Routes live inside a plugin registered after @fastify/swagger: avvio defers
  // plugin loading until ready(), so root-level routes added synchronously here
  // would be missed by swagger's onRoute hook (and by any later-registered
  // plugin hook in general).
  app.register(async (instance) => {
    const routes = instance as unknown as AppServer;

    routes.get(
      '/healthz',
      {
        schema: {
          tags: ['Ops'],
          summary: 'Liveness probe.',
          response: {
            200: Type.Object({ status: Type.Literal('ok'), uptimeSeconds: Type.Number() }),
          },
        },
      },
      async () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }),
    );

    routes.get(
      '/readyz',
      {
        schema: {
          tags: ['Ops'],
          summary: 'Readiness probe: database round-trip + Redis presence.',
          response: {
            200: Type.Object({
              status: Type.Literal('ok'),
              database: Type.Literal('up'),
              redis: Type.Union([Type.Literal('up'), Type.Literal('degraded')]),
            }),
            503: Type.Object({ status: Type.Literal('degraded'), database: Type.String(), redis: Type.String() }),
          },
        },
      },
      async (_request, reply) => {
        try {
          await ctx.prisma.$queryRaw`SELECT 1`;
        } catch {
          return reply.status(503).send({ status: 'degraded' as const, database: 'down', redis: ctx.redis ? 'up' : 'degraded' });
        }
        return { status: 'ok' as const, database: 'up' as const, redis: ctx.redis ? ('up' as const) : ('degraded' as const) };
      },
    );

    registerIamRoutes(routes, ctx, { iam: services.iam, holds: services.holds });

    // Live OpenAPI document (v9 of @fastify/swagger delegates UI/route serving
    // to @fastify/swagger-ui, which we do not ship). Hidden from its own spec.
    routes.get('/api/docs/json', { schema: { hide: true } }, async () => routes.swagger());
    registerAcademicsRoutes(routes, ctx, services.academics);
    registerEnrollmentRoutes(routes, ctx, {
      eligibility: services.eligibility,
      enrollments: services.enrollment,
      fees: services.fees,
      waitlist: services.waitlist,
    });
    registerGradingRoutes(routes, ctx, {
      grading: services.grading,
      rectifications: services.rectifications,
      inc: services.inc,
      sectionAccess: services.sectionAccess,
    });
    registerDocumentRoutes(routes, ctx, services.documents);
  });

  return app;
}

export { createPrismaClient };
