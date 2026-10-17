import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';

describe('ops surface: probes and the live OpenAPI document', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });

  afterAll(async () => {
    await test.close();
  });

  it('serves liveness and readiness probes', async () => {
    const health = await test.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const ready = await test.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().database).toBe('up');
  });

  it('serves the live OpenAPI document and keeps it out of itself', async () => {
    const spec = await test.app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(spec.statusCode).toBe(200);
    const document = spec.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi.startsWith('3.1')).toBe(true);
    expect(Object.keys(document.paths).length).toBeGreaterThan(50);
    expect(document.paths).toHaveProperty('/api/v1/auth/login');
    expect(document.paths).not.toHaveProperty('/api/docs/json');
  });
});
