/** How users sign in to a server (`GET /api/sign-in-methods`). */
export interface SignInMethods {
  /** Email and password sign-in. */
  password: boolean;
  /** Single sign-on through the server's OpenID Connect provider. */
  sso: {
    /** Better Auth provider ID for `signIn.social`. */
    provider: string;
    /** Button label, such as the provider's name. */
    name: string;
    /** The provider's groups set every user's role at sign-in. */
    managesRoles: boolean;
    /**
     * The server's public origin, `BETTER_AUTH_URL`. The provider returns
     * there, so single sign-on has to start there too. Absent on servers from
     * before it was reported.
     */
    origin?: string;
  } | null;
}

const SSO_ERRORS: Record<string, string> = {
  account_not_linked:
    "An account with this email already exists. Ask your identity provider to verify the email, then sign in again.",
  email_not_found: "Your identity provider didn't share an email address.",
  signup_disabled: "This server doesn't create accounts through single sign-on.",
  access_denied: "Sign-in was cancelled.",
  unable_to_get_user_info:
    "Your identity provider didn't send your profile. Try again, or ask your administrator to check the server's log.",
  state_mismatch:
    "Sign-in has to start at this server's public address. Open OvertChat there and try again.",
  state_not_found: "Sign-in took too long. Try again.",
};

/**
 * A user-facing message for the `error` code single sign-on returns with, as
 * in `/login?error=account_not_linked`.
 */
export function ssoErrorMessage(code: string): string {
  return SSO_ERRORS[code] ?? "Single sign-on didn't complete. Try again.";
}

/**
 * Whether a client connected to `serverUrl` can run single sign-on. Its
 * cookies and the provider's return have to share the server's public origin.
 */
export function ssoAddressMatches(methods: SignInMethods, serverUrl: string): boolean {
  const origin = methods.sso?.origin;
  if (!origin) return true;
  try {
    return new URL(serverUrl).origin === new URL(origin).origin;
  } catch {
    return true;
  }
}

/** Why single sign-on is unavailable at another address than `origin`. */
export function ssoAddressMessage(origin: string): string {
  return `Single sign-on works only at ${origin}. Connect to that address to use it.`;
}
