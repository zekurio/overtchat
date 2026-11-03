import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/users", () => ({}));
import { readOidcConfig } from "./oidc-config";
import { providerRole } from "./oidc";

const base = {
  OVERTCHAT_OIDC_ISSUER: "https://id.example.com/application/o/overtchat/",
  OVERTCHAT_OIDC_CLIENT_ID: "overtchat",
};

describe("readOidcConfig", () => {
  it("is off without OVERTCHAT_OIDC_* variables", () => {
    expect(readOidcConfig({})).toBeNull();
    expect(readOidcConfig({ OVERTCHAT_OIDC_ISSUER: " " })).toBeNull();
  });

  it("applies defaults", () => {
    expect(readOidcConfig(base)).toEqual({
      issuer: base.OVERTCHAT_OIDC_ISSUER,
      discoveryUrl:
        "https://id.example.com/application/o/overtchat/.well-known/openid-configuration",
      clientId: "overtchat",
      clientSecret: undefined,
      name: "SSO",
      scopes: ["openid", "profile", "email"],
      groupsClaim: "groups",
      adminGroups: [],
      passwordLogin: false,
    });
  });

  it("parses lists and flags", () => {
    const config = readOidcConfig({
      ...base,
      OVERTCHAT_OIDC_SCOPES: "profile,email groups",
      OVERTCHAT_OIDC_ADMIN_GROUPS: "admins, ops,,admins",
      OVERTCHAT_OIDC_PASSWORD_LOGIN: "yes",
    });
    expect(config?.scopes).toEqual(["openid", "profile", "email", "groups"]);
    expect(config?.adminGroups).toEqual(["admins", "ops"]);
    expect(config?.passwordLogin).toBe(true);
  });

  it("refuses an incomplete or invalid configuration", () => {
    expect(() => readOidcConfig({ OVERTCHAT_OIDC_CLIENT_ID: "x" })).toThrow(/ISSUER/);
    expect(() => readOidcConfig({ OVERTCHAT_OIDC_ISSUER: base.OVERTCHAT_OIDC_ISSUER })).toThrow(/CLIENT_ID/);
    expect(() => readOidcConfig({ ...base, OVERTCHAT_OIDC_ISSUER: "id.example.com" })).toThrow(/URL/);
    expect(() => readOidcConfig({ ...base, OVERTCHAT_OIDC_PASSWORD_LOGIN: "maybe" })).toThrow(/true or false/);
  });
});

describe("providerRole", () => {
  const config = readOidcConfig({ ...base, OVERTCHAT_OIDC_ADMIN_GROUPS: "admins" })!;

  it("leaves roles to OvertChat without admin groups", () => {
    expect(providerRole(readOidcConfig(base)!, { groups: ["admins"] })).toBeNull();
  });

  it("reads a list, a single group, or a nested claim", () => {
    expect(providerRole(config, { groups: ["staff", "admins"] })).toBe("admin");
    expect(providerRole(config, { groups: "admins" })).toBe("admin");
    expect(providerRole(config, { groups: ["staff"] })).toBe("user");
    expect(providerRole(config, {})).toBe("user");
    const keycloak = { ...config, groupsClaim: "realm_access.roles" };
    expect(providerRole(keycloak, { realm_access: { roles: ["admins"] } })).toBe("admin");
  });
});
