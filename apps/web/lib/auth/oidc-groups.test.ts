import { expect, it, vi } from "vitest";
import { baseURL, setupOidcServer } from "./fixtures/oidc-server";

const mocks = vi.hoisted(() => ({ stopUserAgents: vi.fn(async () => {}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agents/connector/stopUserAgents", () => ({
  stopUserAgents: mocks.stopUserAgents,
}));

const { state, request, signIn, sessionUser, users } = setupOidcServer({
  OVERTCHAT_OIDC_ADMIN_GROUPS: "overtchat-admins, ops",
  OVERTCHAT_OIDC_PASSWORD_LOGIN: "true",
});
const alice = { sub: "alice", email: "alice@example.com", email_verified: true, name: "Alice" };
const managementSecret = "oidc-test-management-secret-1234567890";

function userId(email: string) {
  return (state.db.$client.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string }).id;
}

async function recoverPassword(email: string, newPassword: string) {
  const { POST } = await import("@/app/api/internal/management/password-reset/route");
  return POST(new Request(`${baseURL}/api/internal/management/password-reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${managementSecret}` },
    body: JSON.stringify({ email, newPassword }),
  }));
}

it("keeps password sign-in when asked to", async () => {
  const { GET: methods } = await import("@/app/api/sign-in-methods/route");
  expect(await (await methods()).json()).toEqual({
    password: true,
    sso: { provider: "oidc", name: "Test SSO", managesRoles: true, origin: baseURL },
  });
});

it("gives roles from the provider's groups at every sign-in", async () => {
  // Not the first account: groups decide, not order.
  const first = await signIn({ ...alice, groups: ["staff"] });
  expect(await sessionUser(first.token)).toMatchObject({ role: "user" });

  const promoted = await signIn({ ...alice, groups: ["staff", "ops"] });
  expect(await sessionUser(promoted.token)).toMatchObject({ role: "admin" });
  // The earlier session sees the role too.
  expect(await sessionUser(first.token)).toMatchObject({ role: "admin" });

  const demoted = await signIn({ ...alice, groups: [] });
  expect(await sessionUser(demoted.token)).toMatchObject({ role: "user" });
  expect(users()).toEqual([{ email: "alice@example.com", name: "Alice", role: "user" }]);
});

it("lets administrators add password accounts when password sign-in is on", async () => {
  const { token } = await signIn({ ...alice, groups: ["overtchat-admins"] });
  const created = await request("/admin/create-user", {
    name: "Bob", email: "bob@example.com", password: "test-password-123", role: "user",
  }, token!);
  expect(created.status).toBe(200);
  const signedIn = await request("/sign-in/email", {
    email: "bob@example.com", password: "test-password-123",
  });
  expect(signedIn.status).toBe(200);
  expect(state.db.$client.prepare("SELECT count(*) AS n FROM user").get()).toEqual({ n: 2 });
});

it("finds the user by the provider's subject after their email changed", async () => {
  const first = await signIn({ ...alice, groups: [] });
  expect(await sessionUser(first.token)).toMatchObject({ role: "user" });
  // The provider now reports another address than the one OvertChat saved.
  const promoted = await signIn({ ...alice, email: "alice@new.example.com", groups: ["ops"] });
  expect(await sessionUser(promoted.token)).toMatchObject({
    email: "alice@new.example.com",
    role: "admin",
  });
});

it("takes a changed email only when it is verified and free", async () => {
  await signIn({ ...alice, groups: [] });
  await signIn({ ...alice, email: "alice@unverified.example.com", email_verified: false });
  await signIn({ sub: "bob", email: "bob@example.com", email_verified: true, name: "Bob" });
  await signIn({ ...alice, email: "bob@example.com" });
  expect(users()).toEqual([
    { email: "alice@example.com", name: "Alice", role: "user" },
    { email: "bob@example.com", name: "Bob", role: "user" },
  ]);
});

it("keeps the role when userinfo, which has the groups, fails", async () => {
  const first = await signIn({ ...alice, groups: ["ops"] });
  expect(await sessionUser(first.token)).toMatchObject({ role: "admin" });
  state.provider.failNextUserinfo();
  const failed = await signIn({ ...alice, groups: ["ops"] });
  expect(failed.token).toBeNull();
  expect(failed.location).toContain("/login?error=unable_to_get_user_info");
  expect(users()).toEqual([{ email: "alice@example.com", name: "Alice", role: "admin" }]);
});

it("stops a demoted administrator's agents", async () => {
  await signIn({ ...alice, groups: ["ops"] });
  const id = userId("alice@example.com");
  state.db.$client.prepare(
    "INSERT INTO host_connectors (id, name, token_hash, managed, user_id, created_at, updated_at) VALUES ('laptop', 'Laptop', 'hash', 0, ?, 1, 1)",
  ).run(id);
  mocks.stopUserAgents.mockClear();
  await signIn({ ...alice, groups: ["ops"] });
  expect(mocks.stopUserAgents).not.toHaveBeenCalled();
  await signIn({ ...alice, groups: [] });
  await vi.waitFor(() => expect(mocks.stopUserAgents).toHaveBeenCalledWith(id));
});

it("lets operator recovery give a single sign-on account a password", async () => {
  await signIn({ ...alice, groups: ["ops"] });
  expect((await request("/sign-in/email", {
    email: "alice@example.com", password: "test-password-123",
  })).status).toBe(401);
  const recovered = await recoverPassword("alice@example.com", "test-password-123");
  expect(recovered.status).toBe(200);
  const signedIn = await request("/sign-in/email", {
    email: "alice@example.com", password: "test-password-123",
  });
  expect(signedIn.status).toBe(200);
  expect(await sessionUser(signedIn.headers.get("set-auth-token"))).toMatchObject({ role: "admin" });
});

it("tells administrators without a password why they can't reset others", async () => {
  const { token } = await signIn({ ...alice, groups: ["ops"] });
  await signIn({ sub: "bob", email: "bob@example.com", email_verified: true, name: "Bob" });
  const response = await request("/admin/reset-user-password", {
    userId: userId("bob@example.com"),
    currentPassword: "anything",
    newPassword: "test-password-123",
  }, token!);
  expect(response.status).toBe(400);
  expect(((await response.json()) as { message: string }).message).toContain("single sign-on");
});
