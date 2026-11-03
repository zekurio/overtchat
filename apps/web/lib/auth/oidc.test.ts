import { expect, it, vi } from "vitest";
import { baseURL, setupOidcServer } from "./fixtures/oidc-server";

vi.mock("server-only", () => ({}));

const { state, request, signIn, sessionUser, users } = setupOidcServer();
const owner = { sub: "owner-sub", email: "Owner@Example.com", email_verified: true, name: "Owner" };
const member = { sub: "member-sub", email: "member@example.com", email_verified: true, preferred_username: "member" };

it("offers only single sign-on and skips initial setup", async () => {
  const { GET: methods } = await import("@/app/api/sign-in-methods/route");
  expect(await (await methods()).json()).toEqual({
    password: false,
    sso: { provider: "oidc", name: "Test SSO", managesRoles: false },
  });
  const { GET: publicSetup } = await import("@/app/api/setup/route");
  expect(await (await publicSetup()).json()).toEqual({ required: false });
  const { GET: management } = await import("@/app/api/internal/management/setup/route");
  const response = await management(new Request(`${baseURL}/api/internal/management/setup`, {
    headers: { Authorization: "Bearer oidc-test-management-secret-1234567890" },
  }));
  expect(await response.json()).toEqual({ required: false, code: null });
  const account = { name: "Owner", email: "owner@example.com", password: "test-password-123" };
  expect((await request("/setup-admin", { ...account, code: "AAAA-BBBB-CCCC" })).status).toBe(400);
  expect((await request("/sign-up/email", account)).status).toBe(400);
  expect((await request("/sign-in/email", account)).status).toBe(400);
  expect(users()).toEqual([]);
});

it("provisions the first account as the administrator and later ones as users", async () => {
  state.db.$client.prepare(
    "INSERT INTO host_connectors (id, name, token_hash, managed, created_at, updated_at) VALUES ('managed', 'Host', 'hash', 1, 1, 1)",
  ).run();
  const first = await signIn(owner);
  expect(first.status).toBe(302);
  expect(first.location).toBe("/");
  expect(await sessionUser(first.token)).toMatchObject({
    email: "owner@example.com",
    name: "Owner",
    role: "admin",
  });
  const { id } = (await sessionUser(first.token))!;
  expect(state.db.$client.prepare("SELECT user_id FROM host_connectors").get()).toEqual({ user_id: id });

  const second = await signIn(member);
  expect(await sessionUser(second.token)).toMatchObject({ name: "member", role: "user" });
  // Signing in again reuses the account.
  const again = await signIn(owner);
  expect(await sessionUser(again.token)).toMatchObject({ id, role: "admin" });
  expect(users()).toEqual([
    { email: "owner@example.com", name: "Owner", role: "admin" },
    { email: "member@example.com", name: "member", role: "user" },
  ]);
});

it("makes only one of two concurrent first accounts the administrator", async () => {
  const results = await Promise.all([signIn(owner), signIn(member)]);
  const roles = await Promise.all(results.map(async (r) => (await sessionUser(r.token))?.role));
  expect(roles.sort()).toEqual(["admin", "user"]);
});

it("does not let administrators create password accounts", async () => {
  const { token } = await signIn(owner);
  const response = await request("/admin/create-user", {
    name: "Member", email: "new@example.com", password: "test-password-123", role: "user",
  }, token!);
  expect(response.status).toBe(400);
  expect(users()).toHaveLength(1);
});

it("links an existing account only when the provider verified its email", async () => {
  state.db.$client.prepare(
    "INSERT INTO user (id, name, email, role, email_verified) VALUES ('old', 'Old Admin', 'owner@example.com', 'admin', 0)",
  ).run();
  const unverified = await signIn({ ...owner, email_verified: false });
  expect(unverified.token).toBeNull();
  expect(unverified.location).toContain("/login?error=account_not_linked");
  const verified = await signIn(owner);
  expect(await sessionUser(verified.token)).toMatchObject({ id: "old", name: "Old Admin", role: "admin" });
  expect(users()).toHaveLength(1);
});

it("rejects a callback with a forged state", async () => {
  const response = await state.auth.handler(new Request(
    `${baseURL}/api/auth/callback/oidc?code=forged&state=forged`,
  ));
  expect(response.headers.get("set-auth-token")).toBeNull();
  expect(users()).toEqual([]);
});

it("rejects an ID token the provider did not sign", async () => {
  state.provider.forgeNextIdToken();
  const result = await signIn(owner);
  expect(result.token).toBeNull();
  expect(result.location).toContain("/login?error=");
  expect(users()).toEqual([]);
});
