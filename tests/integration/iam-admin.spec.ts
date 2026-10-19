import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { createUser, TEST_SCHOOL2_ID, TEST_SCHOOL_ID } from '../helpers/fixtures';

describe('IAM lifecycle & role-template overrides (Phase 2)', () => {
  let test: TestApp;
  let adminId: string;
  let admin2Id: string;
  let registrarId: string;
  let instructorId: string;
  let outsiderId: string;
  let cashierId: string;
  let cashier2Id: string;
  let multiId: string;
  let clockAtStart: Date;

  beforeAll(async () => {
    test = await createTestApp();
    clockAtStart = test.clock.now();
    adminId = (await createUser(test.prisma, { email: 'iam.admin@test.dev', roles: ['ADMIN'] })).id;
    admin2Id = (await createUser(test.prisma, { email: 'iam.admin2@test.dev', roles: ['ADMIN'], schoolId: TEST_SCHOOL2_ID })).id;
    registrarId = (await createUser(test.prisma, { email: 'iam.registrar@test.dev', roles: ['REGISTRAR'] })).id;
    instructorId = (await createUser(test.prisma, { email: 'iam.inst@test.dev', roles: ['INSTRUCTOR'] })).id;
    cashierId = (await createUser(test.prisma, { email: 'iam.cashier@test.dev', roles: ['CASHIER'] })).id;
    outsiderId = (await createUser(test.prisma, { email: 'iam.outsider@test.dev', roles: ['INSTRUCTOR'], schoolId: TEST_SCHOOL2_ID })).id;
    cashier2Id = (await createUser(test.prisma, { email: 'iam.cashier2@test.dev', roles: ['CASHIER'], schoolId: TEST_SCHOOL2_ID })).id;
    multiId = (await createUser(test.prisma, { email: 'iam.multi@test.dev', roles: ['INSTRUCTOR'] })).id;
    const secondMembership = await test.prisma.membership.create({
      data: { schoolId: TEST_SCHOOL2_ID, userId: multiId, status: 'ACTIVE' },
    });
    await test.prisma.roleAssignment.create({
      data: { schoolId: TEST_SCHOOL2_ID, membershipId: secondMembership.id, roleCode: 'INSTRUCTOR' },
    });
  });

  afterAll(async () => {
    await test.close();
  });

  const adminToken = () => test.auth(test.mintToken(adminId, ['ADMIN']));
  const registrarToken = () => test.auth(test.mintToken(registrarId, ['REGISTRAR']));
  const cashierToken = () => test.auth(test.mintToken(cashierId, ['CASHIER']));
  const cashier2Token = () => test.auth(test.mintToken(cashier2Id, ['CASHIER'], { schoolId: TEST_SCHOOL2_ID }));

  const createInvitation = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    test.app.inject({ method: 'POST', url: '/api/v1/iam/invitations', headers, payload });
  const accept = (token: string, password = 'InvitedPass123!') =>
    test.app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token, password } });
  const login = (email: string, password: string) =>
    test.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  const setTemplate = (headers: Record<string, string>, roleCode: string, permissions: string[]) =>
    test.app.inject({ method: 'PUT', url: `/api/v1/iam/role-templates/${roleCode}`, headers, payload: { permissions } });
  const getSchool = (headers: Record<string, string>) =>
    test.app.inject({ method: 'GET', url: '/api/v1/school', headers });

  it('exposes the 53-code permission registry to admins only', async () => {
    const denied = await test.app.inject({ method: 'GET', url: '/api/v1/iam/permissions', headers: registrarToken() });
    expect(denied.statusCode).toBe(403);

    const res = await test.app.inject({ method: 'GET', url: '/api/v1/iam/permissions', headers: adminToken() });
    expect(res.statusCode).toBe(200);
    const codes = res.json().map((permission: { code: string }) => permission.code);
    expect(codes).toHaveLength(53);
    expect(codes).toContain('iam.memberships.manage');
    expect(codes).toContain('iam.invitations.manage');
    expect(codes).toContain('iam.templates.manage');
  });

  it('invitation acceptance provisions the account, roles and a first session', async () => {
    const created = await createInvitation(adminToken(), {
      email: 'new.instructor@test.dev',
      firstName: 'New',
      lastName: 'Instructor',
      roles: ['INSTRUCTOR'],
    });
    expect(created.statusCode).toBe(201);
    const invitation = created.json();
    expect(invitation.status).toBe('PENDING');
    expect(typeof invitation.token).toBe('string');

    const accepted = await accept(invitation.token);
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json();
    expect(body.user.email).toBe('new.instructor@test.dev');
    expect(body.user.roles).toEqual(['INSTRUCTOR']);
    expect(body.tokens.tokenType).toBe('Bearer');

    const me = await test.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: test.auth(body.tokens.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('new.instructor@test.dev');
    expect(me.json().roles).toContain('INSTRUCTOR');

    const relogin = await login('new.instructor@test.dev', 'InvitedPass123!');
    expect(relogin.statusCode).toBe(200);

    const again = await accept(invitation.token);
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('INVITATION_INVALID');

    const audits = await test.prisma.auditLog.findMany({
      where: { schoolId: TEST_SCHOOL_ID, action: { in: ['iam.invitation.created', 'iam.invitation.accepted'] } },
    });
    expect(audits.map((entry) => entry.action).sort()).toEqual(['iam.invitation.accepted', 'iam.invitation.created']);
  });

  it('rejects invitations for existing users and duplicate pending invites', async () => {
    const existing = await createInvitation(adminToken(), {
      email: 'iam.inst@test.dev',
      firstName: 'Dup',
      lastName: 'User',
      roles: ['INSTRUCTOR'],
    });
    expect(existing.statusCode).toBe(409);

    const first = await createInvitation(adminToken(), {
      email: 'pending.one@test.dev',
      firstName: 'Pending',
      lastName: 'One',
      roles: ['STUDENT'],
    });
    expect(first.statusCode).toBe(201);
    const second = await createInvitation(adminToken(), {
      email: 'pending.one@test.dev',
      firstName: 'Pending',
      lastName: 'One',
      roles: ['STUDENT'],
    });
    expect(second.statusCode).toBe(409);
  });

  it('revoked invitations can no longer be accepted', async () => {
    const created = await createInvitation(adminToken(), {
      email: 'revoked.user@test.dev',
      firstName: 'Revoked',
      lastName: 'User',
      roles: ['CASHIER'],
    });
    const invitation = created.json();

    const listed = await test.app.inject({ method: 'GET', url: '/api/v1/iam/invitations?status=PENDING', headers: adminToken() });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().some((row: { id: string }) => row.id === invitation.id)).toBe(true);

    const revoked = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/invitations/${invitation.id}/revoke`,
      headers: adminToken(),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('REVOKED');

    const again = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/invitations/${invitation.id}/revoke`,
      headers: adminToken(),
    });
    expect(again.statusCode).toBe(409);

    const attempt = await accept(invitation.token);
    expect(attempt.statusCode).toBe(404);
    expect(attempt.json().code).toBe('INVITATION_INVALID');
  });

  it('expired invitations are rejected', async () => {
    const created = await createInvitation(adminToken(), {
      email: 'expired.user@test.dev',
      firstName: 'Expired',
      lastName: 'User',
      roles: ['CASHIER'],
    });
    const invitation = created.json();

    test.clock.advanceMs(8 * 86_400_000);
    const attempt = await accept(invitation.token);
    expect(attempt.statusCode).toBe(422);
    expect(attempt.json().code).toBe('INVITATION_EXPIRED');
    test.clock.set(clockAtStart);
  });

  it('rejects short passwords without consuming the invitation', async () => {
    const created = await createInvitation(adminToken(), {
      email: 'weak.pass@test.dev',
      firstName: 'Weak',
      lastName: 'Pass',
      roles: ['CASHIER'],
    });
    expect(created.statusCode).toBe(201);

    const rejected = await accept(created.json().token, 'short');
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe('VALIDATION_FAILED');

    const row = await test.prisma.invitation.findUnique({ where: { id: created.json().id } });
    expect(row!.status).toBe('PENDING');

    const ok = await accept(created.json().token);
    expect(ok.statusCode).toBe(200);
  });

  it('invitations are isolated per school', async () => {
    const list2 = await test.app.inject({
      method: 'GET',
      url: '/api/v1/iam/invitations',
      headers: test.auth(test.mintToken(admin2Id, ['ADMIN'], { schoolId: TEST_SCHOOL2_ID })),
    });
    expect(list2.statusCode).toBe(200);
    expect(list2.json()).toHaveLength(0);

    const list1 = await test.app.inject({ method: 'GET', url: '/api/v1/iam/invitations', headers: adminToken() });
    expect(list1.statusCode).toBe(200);
    expect(list1.json().length).toBeGreaterThan(0);
  });

  it('membership suspension blocks login and activation restores it', async () => {
    const pre = await login('iam.inst@test.dev', 'Password123!');
    expect(pre.statusCode).toBe(200);

    const suspended = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/users/${instructorId}/suspend`,
      headers: adminToken(),
      payload: { reason: 'Investigation' },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe('SUSPENDED');

    const blocked = await login('iam.inst@test.dev', 'Password123!');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('AUTH_NO_MEMBERSHIP');

    const refreshBlocked = await test.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: pre.json().refreshToken },
    });
    expect(refreshBlocked.statusCode).toBe(403);
    expect(refreshBlocked.json().code).toBe('AUTH_NO_MEMBERSHIP');

    const double = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/users/${instructorId}/suspend`,
      headers: adminToken(),
      payload: {},
    });
    expect(double.statusCode).toBe(409);

    const activated = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/users/${instructorId}/activate`,
      headers: adminToken(),
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().status).toBe('ACTIVE');

    const restored = await login('iam.inst@test.dev', 'Password123!');
    expect(restored.statusCode).toBe(200);

    const self = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/users/${adminId}/suspend`,
      headers: adminToken(),
      payload: {},
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe('VALIDATION_FAILED');

    const outsider = await test.app.inject({
      method: 'POST',
      url: `/api/v1/iam/users/${outsiderId}/suspend`,
      headers: adminToken(),
      payload: {},
    });
    expect(outsider.statusCode).toBe(404);

    const audits = await test.prisma.auditLog.findMany({
      where: { schoolId: TEST_SCHOOL_ID, action: { in: ['iam.membership.suspended', 'iam.membership.activated'] } },
    });
    expect(audits).toHaveLength(2);
  });

  it('role assignment updates take effect on the next login', async () => {
    const changed = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/iam/users/${instructorId}/roles`,
      headers: adminToken(),
      payload: { roles: ['REGISTRAR'] },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().roles).toEqual(['REGISTRAR']);

    const assignments = await test.prisma.roleAssignment.findMany({ where: { schoolId: TEST_SCHOOL_ID, membership: { userId: instructorId } } });
    expect(assignments.map((row) => row.roleCode)).toEqual(['REGISTRAR']);

    const mirrored = await test.prisma.user.findUnique({ where: { id: instructorId } });
    expect(mirrored!.roles).toEqual(['REGISTRAR']);

    const relogin = await login('iam.inst@test.dev', 'Password123!');
    expect(relogin.statusCode).toBe(200);
    const me = await test.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: test.auth(relogin.json().accessToken),
    });
    expect(me.json().roles).toEqual(['REGISTRAR']);

    const missing = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/iam/users/${outsiderId}/roles`,
      headers: adminToken(),
      payload: { roles: ['REGISTRAR'] },
    });
    expect(missing.statusCode).toBe(404);

    const audits = await test.prisma.auditLog.findMany({ where: { schoolId: TEST_SCHOOL_ID, action: 'iam.user.roles_updated' } });
    expect(audits).toHaveLength(1);
  });

  it('role updates leave the User.roles mirror alone for multi-school users', async () => {
    const changed = await test.app.inject({
      method: 'PUT',
      url: `/api/v1/iam/users/${multiId}/roles`,
      headers: adminToken(),
      payload: { roles: ['PROGRAM_CHAIR'] },
    });
    expect(changed.statusCode).toBe(200);

    const schoolOne = await test.prisma.roleAssignment.findMany({
      where: { membership: { userId: multiId, schoolId: TEST_SCHOOL_ID } },
    });
    expect(schoolOne.map((row) => row.roleCode)).toEqual(['PROGRAM_CHAIR']);

    const schoolTwo = await test.prisma.roleAssignment.findMany({
      where: { membership: { userId: multiId, schoolId: TEST_SCHOOL2_ID } },
    });
    expect(schoolTwo.map((row) => row.roleCode)).toEqual(['INSTRUCTOR']);

    const user = await test.prisma.user.findUnique({ where: { id: multiId } });
    expect(user!.roles).toEqual(['INSTRUCTOR']);
  });

  it('school template overrides change enforcement and revert cleanly', async () => {
    const baseline = await getSchool(cashierToken());
    expect(baseline.statusCode).toBe(200);

    const templates = await test.app.inject({ method: 'GET', url: '/api/v1/iam/role-templates', headers: adminToken() });
    expect(templates.statusCode).toBe(200);
    const body = templates.json();
    expect(body.mode).toBe('HE');
    const cashier = body.templates.find((template: { roleCode: string }) => template.roleCode === 'CASHIER');
    expect(cashier.source).toBe('builtin');
    expect(cashier.permissions).toContain('school.view.self');

    const reduced = cashier.permissions.filter((code: string) => code !== 'school.view.self');
    const override = await setTemplate(adminToken(), 'CASHIER', reduced);
    expect(override.statusCode).toBe(200);
    expect(override.json().source).toBe('school');

    const denied = await getSchool(cashierToken());
    expect(denied.statusCode).toBe(403);

    const school2 = await getSchool(cashier2Token());
    expect(school2.statusCode).toBe(200);

    const stillAllPowerful = await getSchool(adminToken());
    expect(stillAllPowerful.statusCode).toBe(200);

    const templatesDenied = await test.app.inject({ method: 'GET', url: '/api/v1/iam/role-templates', headers: cashierToken() });
    expect(templatesDenied.statusCode).toBe(403);

    const granted = await setTemplate(adminToken(), 'CASHIER', [...reduced, 'iam.templates.manage']);
    expect(granted.statusCode).toBe(200);
    const templatesAllowed = await test.app.inject({ method: 'GET', url: '/api/v1/iam/role-templates', headers: cashierToken() });
    expect(templatesAllowed.statusCode).toBe(200);

    const reverted = await test.app.inject({ method: 'DELETE', url: '/api/v1/iam/role-templates/CASHIER', headers: adminToken() });
    expect(reverted.statusCode).toBe(204);

    const restored = await getSchool(cashierToken());
    expect(restored.statusCode).toBe(200);
    const templatesDeniedAgain = await test.app.inject({ method: 'GET', url: '/api/v1/iam/role-templates', headers: cashierToken() });
    expect(templatesDeniedAgain.statusCode).toBe(403);

    const revertAgain = await test.app.inject({ method: 'DELETE', url: '/api/v1/iam/role-templates/CASHIER', headers: adminToken() });
    expect(revertAgain.statusCode).toBe(404);

    const audits = await test.prisma.auditLog.findMany({
      where: { schoolId: TEST_SCHOOL_ID, action: { in: ['iam.template.updated', 'iam.template.reverted'] } },
    });
    expect(audits.filter((entry) => entry.action === 'iam.template.updated')).toHaveLength(2);
    expect(audits.filter((entry) => entry.action === 'iam.template.reverted')).toHaveLength(1);
  });

  it('rejects invalid template payloads and the ADMIN template', async () => {
    const unknown = await setTemplate(adminToken(), 'CASHIER', ['school.view.self', 'not.a.permission']);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('VALIDATION_FAILED');
    expect(unknown.json().meta.invalidCodes).toEqual(['not.a.permission']);

    const adminTemplate = await setTemplate(adminToken(), 'ADMIN', []);
    expect(adminTemplate.statusCode).toBe(400);

    const adminRevert = await test.app.inject({ method: 'DELETE', url: '/api/v1/iam/role-templates/ADMIN', headers: adminToken() });
    expect(adminRevert.statusCode).toBe(400);

    const denial = await setTemplate(registrarToken(), 'CASHIER', []);
    expect(denial.statusCode).toBe(403);
  });
});
