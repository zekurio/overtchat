/**
 * Single sign-on through one OpenID Connect provider, configured only by the
 * environment. When it is on, the provider creates accounts on first sign-in
 * and the setup-code flow is skipped.
 */

/** Better Auth provider ID; the callback is `/api/auth/callback/oidc`. */
export const OIDC_PROVIDER_ID = "oidc";

export interface OidcConfig {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string | undefined;
  /** Sign-in button label. */
  name: string;
  scopes: string[];
  /** Claim that lists the user's groups. */
  groupsClaim: string;
  /**
   * Members of any of these groups are administrators, everyone else a user,
   * updated at every sign-in. Empty: the first account becomes the
   * administrator and roles are managed in OvertChat.
   */
  adminGroups: string[];
  /** Whether password sign-in stays available next to single sign-on. */
  passwordLogin: boolean;
}

type Environment = Record<string, string | undefined>;

function value(env: Environment, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function list(input: string | undefined, separator: RegExp): string[] {
  return [...new Set(input?.split(separator).map((s) => s.trim()).filter(Boolean) ?? [])];
}

function flag(env: Environment, name: string): boolean {
  const raw = value(env, name);
  if (raw === undefined) return false;
  if (/^(1|true|yes|on)$/iu.test(raw)) return true;
  if (/^(0|false|no|off)$/iu.test(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

/**
 * Reads `OVERTCHAT_OIDC_*`. Returns null when single sign-on is off and throws
 * on an incomplete configuration, so a typo cannot open the setup-code flow
 * on a server meant to use single sign-on.
 */
export function readOidcConfig(env: Environment = process.env): OidcConfig | null {
  const issuer = value(env, "OVERTCHAT_OIDC_ISSUER");
  const clientId = value(env, "OVERTCHAT_OIDC_CLIENT_ID");
  const configured = Object.entries(env).some(
    ([key, v]) => key.startsWith("OVERTCHAT_OIDC_") && v?.trim(),
  );
  if (!configured) return null;
  if (!issuer || !clientId) {
    throw new Error(
      "Single sign-on needs both OVERTCHAT_OIDC_ISSUER and OVERTCHAT_OIDC_CLIENT_ID.",
    );
  }
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error("OVERTCHAT_OIDC_ISSUER must be a URL.");
  }
  if (issuerUrl.protocol !== "https:" && issuerUrl.protocol !== "http:") {
    throw new Error("OVERTCHAT_OIDC_ISSUER must be an http or https URL.");
  }
  const scopes = list(value(env, "OVERTCHAT_OIDC_SCOPES") ?? "openid profile email", /[\s,]+/u);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  return {
    issuer,
    discoveryUrl: `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
    clientId,
    clientSecret: value(env, "OVERTCHAT_OIDC_CLIENT_SECRET"),
    name: value(env, "OVERTCHAT_OIDC_NAME") ?? "SSO",
    scopes,
    groupsClaim: value(env, "OVERTCHAT_OIDC_GROUPS_CLAIM") ?? "groups",
    adminGroups: list(value(env, "OVERTCHAT_OIDC_ADMIN_GROUPS"), /,/u),
    passwordLogin: flag(env, "OVERTCHAT_OIDC_PASSWORD_LOGIN"),
  };
}

let cached: { config: OidcConfig | null } | undefined;

/** The process configuration, read once. */
export function oidcConfig(): OidcConfig | null {
  cached ??= { config: readOidcConfig() };
  return cached.config;
}

/** Whether password sign-in is available on this server. */
export function passwordLoginEnabled(): boolean {
  const config = oidcConfig();
  return !config || config.passwordLogin;
}
