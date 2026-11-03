import { expect, it, vi } from "vitest";
import { setupOidcServer } from "./fixtures/oidc-server";

vi.mock("server-only", () => ({}));

const { state, request, signIn, sessionUser, users } = setupOidcServer({
  OVERTCHAT_OIDC_ADMIN_GROUPS: "overtchat-admins, ops",
  OVERTCHAT_OIDC_PASSWORD_LOGIN: "true",
});
const alice = { sub: "alice", email: "alice@example.com", email_verified: true, name: "Alice" };

it("keeps password sign-in when asked to", async () => {
  const { GET: methods } = await import("@/app/api/sign-in-methods/route");
  expect(await (await methods()).json()).toEqual({
    password: true,
    sso: { provider: "oidc", name: "Test SSO", managesRoles: true },
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
    email: "alice@example.com",
    role: "admin",
  });
});
