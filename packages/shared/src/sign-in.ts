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
  } | null;
}

const SSO_ERRORS: Record<string, string> = {
  account_not_linked:
    "An account with this email already exists. Ask your identity provider to verify the email, then sign in again.",
  email_not_found: "Your identity provider didn't share an email address.",
  signup_disabled: "This server doesn't create accounts through single sign-on.",
  access_denied: "Sign-in was cancelled.",
};

/**
 * A user-facing message for the `error` code single sign-on returns with, as
 * in `/login?error=account_not_linked`.
 */
export function ssoErrorMessage(code: string): string {
  return SSO_ERRORS[code] ?? "Single sign-on didn't complete. Try again.";
}
