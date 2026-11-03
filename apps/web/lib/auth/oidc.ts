import "server-only";
import type { GenericOAuthConfig, GenericOAuthUserInfo } from "better-auth/plugins";
import { promoteFirstAdmin, setUserRole } from "@/lib/db/users";
import { OIDC_PROVIDER_ID, type OidcConfig } from "./oidc-config";

type Profile = Record<string, unknown>;
type Role = "admin" | "user";

/** Reads a claim by name, or a nested one by dotted path like `realm_access.roles`. */
export function claimValue(profile: Profile, claim: string): unknown {
  if (claim in profile) return profile[claim];
  let current: unknown = profile;
  for (const key of claim.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Profile)[key];
  }
  return current;
}

export function profileGroups(profile: Profile, claim: string): string[] {
  const groups = claimValue(profile, claim);
  if (typeof groups === "string") return [groups];
  if (!Array.isArray(groups)) return [];
  return groups.filter((group): group is string => typeof group === "string");
}

/** The role the provider assigns, or null when OvertChat manages roles. */
export function providerRole(config: OidcConfig, profile: Profile): Role | null {
  if (config.adminGroups.length === 0) return null;
  const groups = profileGroups(profile, config.groupsClaim);
  return groups.some((group) => config.adminGroups.includes(group)) ? "admin" : "user";
}

/**
 * Roles from profiles mapped during an OIDC callback, waiting for the user and
 * session hooks of the same request, because Better Auth does not pass the
 * profile to those hooks. Each entry is under the provider's subject and the
 * email: a new user is known only by email, and an existing user's email can
 * differ from the provider's.
 */
type PendingRole = { role: Role; expires: number; keys: string[] };
const pendingRoles = new Map<string, PendingRole>();
const PENDING_ROLE_TTL_MS = 60_000;
const subjectKey = (subject: string) => `sub:${subject}`;
const emailKey = (email: string) => `email:${email.toLowerCase()}`;

function rememberRole(subject: string, email: string, role: Role) {
  const now = Date.now();
  for (const [key, entry] of pendingRoles) {
    if (entry.expires <= now) pendingRoles.delete(key);
  }
  const entry = {
    role,
    expires: now + PENDING_ROLE_TTL_MS,
    keys: [subjectKey(subject), emailKey(email)],
  };
  for (const key of entry.keys) pendingRoles.set(key, entry);
}

function pendingRole(key: string): PendingRole | null {
  const entry = pendingRoles.get(key);
  return entry && entry.expires > Date.now() ? entry : null;
}

/** The role mapped for this email in the current callback. */
export function peekProviderRole(email: string): Role | null {
  return pendingRole(emailKey(email))?.role ?? null;
}

function takeProviderRole(subject: string | undefined, email: string): Role | null {
  const entry =
    (subject !== undefined ? pendingRole(subjectKey(subject)) : null) ??
    pendingRole(emailKey(email));
  if (!entry) return null;
  for (const key of entry.keys) pendingRoles.delete(key);
  return entry.role;
}

/** Whether a Better Auth endpoint context is this provider's sign-in callback. */
export function isOidcCallback(ctx: { path?: string; params?: unknown } | null | undefined) {
  if (!ctx?.path?.startsWith("/callback/")) return false;
  const params = ctx.params as { id?: unknown } | undefined;
  return params?.id === OIDC_PROVIDER_ID;
}

/**
 * When the provider signs a user in, before the session is created: applies
 * the role the provider's groups give, or, without admin groups, makes the
 * first account the administrator. Returns the user's role when it changed.
 */
export function applySignInRole(
  config: OidcConfig,
  user: { id: string; email: string; role?: string | null },
  /** The provider's subject for this user, from their linked account. */
  subject?: string,
): Role | null {
  const role = takeProviderRole(subject, user.email);
  if (role) {
    if (user.role === role) return null;
    setUserRole(user.id, role);
    return role;
  }
  if (config.adminGroups.length === 0 && user.role !== "admin" && promoteFirstAdmin(user.id)) {
    return "admin";
  }
  return null;
}

/** The payload of an ID token Better Auth has already verified. */
function jwtClaims(token: string): Profile {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Profile) : {};
  } catch {
    return {};
  }
}

let discovery: Promise<{ userinfo_endpoint?: string }> | undefined;

async function userInfoEndpoint(config: OidcConfig): Promise<string | undefined> {
  discovery ??= fetch(config.discoveryUrl, { signal: AbortSignal.timeout(10_000) })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<{ userinfo_endpoint?: string }>;
    })
    .catch((error: unknown) => {
      discovery = undefined;
      throw error;
    });
  return (await discovery).userinfo_endpoint;
}

/**
 * Merges the verified ID token's claims with the userinfo response. Better
 * Auth's default skips userinfo when the ID token names an email, but many
 * providers send groups only from userinfo.
 */
async function fetchProfile(
  config: OidcConfig,
  tokens: { idToken?: string; accessToken?: string },
): Promise<GenericOAuthUserInfo | null> {
  const claims = tokens.idToken ? jwtClaims(tokens.idToken) : {};
  let userinfo: Profile = {};
  const endpoint = tokens.accessToken ? await userInfoEndpoint(config) : undefined;
  if (endpoint) {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) userinfo = (await response.json()) as Profile;
  }
  // OIDC Core 5.3.2: userinfo for another subject must be discarded.
  if (claims.sub !== undefined && userinfo.sub !== undefined && userinfo.sub !== claims.sub) {
    userinfo = {};
  }
  const profile = { ...claims, ...userinfo };
  if (profile.sub === undefined || typeof profile.email !== "string") return null;
  return {
    ...profile,
    id: String(profile.sub),
    email: profile.email,
    emailVerified: profile.email_verified === true || profile.email_verified === "true",
  };
}

function displayName(profile: Profile, email: string): string {
  for (const key of ["name", "preferred_username", "nickname"]) {
    const name = profile[key];
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  const given = [profile.given_name, profile.family_name]
    .filter((part): part is string => typeof part === "string" && !!part.trim())
    .join(" ");
  return given || email.split("@")[0]!;
}

export function oidcProvider(config: OidcConfig): GenericOAuthConfig {
  return {
    providerId: OIDC_PROVIDER_ID,
    name: config.name,
    discoveryUrl: config.discoveryUrl,
    // Account identity is the ID token's subject, so never accept it unverified.
    requireIdTokenVerification: true,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(config.clientSecret ? {} : { tokenEndpointAuth: { method: "none" } as const }),
    scopes: config.scopes,
    pkce: true,
    // Signing out of OvertChat leaves the provider's session alone.
    disableProviderLogout: true,
    getUserInfo: (tokens) => fetchProfile(config, tokens),
    mapProfileToUser: (profile) => {
      const email = String(profile.email).toLowerCase();
      const role = providerRole(config, profile);
      if (role) rememberRole(String(profile.sub ?? profile.id), email, role);
      const picture = typeof profile.picture === "string" ? profile.picture : undefined;
      return { email, name: displayName(profile, email), image: picture };
    },
  };
}
