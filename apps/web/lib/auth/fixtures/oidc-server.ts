import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import { startMockOidcProvider, type MockProfile } from "./mock-oidc-provider";

export const baseURL = "http://localhost:4717";

/**
 * Starts a mock provider and a server configured for it. Call at the top of a
 * test file, before anything imports the auth modules.
 */
export function setupOidcServer(env: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "overtchat-oidc-"));
  const state = {} as {
    provider: Awaited<ReturnType<typeof startMockOidcProvider>>;
    auth: (typeof import("../server"))["auth"];
    db: (typeof import("@/lib/db/client"))["db"];
  };

  beforeAll(async () => {
    state.provider = await startMockOidcProvider("overtchat-test");
    vi.stubEnv("DATABASE_URL", path.join(directory, "chat.db"));
    vi.stubEnv("BETTER_AUTH_URL", baseURL);
    vi.stubEnv("BETTER_AUTH_SECRET", "oidc-test-auth-secret-12345678901234567890");
    vi.stubEnv("OVERTCHAT_MANAGEMENT_SECRET", "oidc-test-management-secret-1234567890");
    vi.stubEnv("OVERTCHAT_E2E_DISABLE_AUTH_RATE_LIMIT", "1");
    vi.stubEnv("OVERTCHAT_OIDC_ISSUER", state.provider.issuer);
    vi.stubEnv("OVERTCHAT_OIDC_CLIENT_ID", "overtchat-test");
    vi.stubEnv("OVERTCHAT_OIDC_CLIENT_SECRET", "client-secret");
    vi.stubEnv("OVERTCHAT_OIDC_NAME", "Test SSO");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    state.db = (await import("@/lib/db/client")).db;
    (await import("@/lib/db/migrate")).runMigrations();
    state.auth = (await import("../server")).auth;
  });

  beforeEach(() => {
    state.db.$client.exec(
      "DELETE FROM host_connectors; DELETE FROM user; DELETE FROM initial_setup;",
    );
  });

  afterAll(async () => {
    state.db?.$client.close();
    await state.provider?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function request(endpoint: string, data: unknown, token?: string) {
    return state.auth.handler(new Request(`${baseURL}/api/auth${endpoint}`, {
      method: "POST",
      headers: {
        Origin: baseURL,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    }));
  }

  /** Runs the browser's sign-in round trip and returns the callback response. */
  async function signIn(profile: MockProfile) {
    const start = await request("/sign-in/social", {
      provider: "oidc",
      callbackURL: "/",
      errorCallbackURL: "/login",
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const cookies = start.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    const query = state.provider.authorize(url, profile);
    const callback = await state.auth.handler(new Request(
      `${baseURL}/api/auth/callback/oidc?${query}`,
      { headers: { Cookie: cookies } },
    ));
    const location = callback.headers.get("location") ?? "";
    const token = callback.headers.get("set-auth-token");
    return { status: callback.status, location, token };
  }

  async function sessionUser(token: string | null) {
    const response = await state.auth.handler(new Request(`${baseURL}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    return ((await response.json()) as { user: { id: string; email: string; name: string; role: string } } | null)?.user;
  }

  function users() {
    return state.db.$client
      .prepare("SELECT email, name, role FROM user ORDER BY created_at, email")
      .all();
  }

  return { state, request, signIn, sessionUser, users };
}
