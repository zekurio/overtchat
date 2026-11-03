import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, genericOAuth, twoFactor } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { APIError } from "better-auth/api";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { claimManagedHostConnector } from "@/lib/db/hostConnectors";
import { passwordRecovery } from "./password-recovery";
import { initialSetup } from "./initial-setup";
import { twoFactorRecovery } from "./two-factor";
import { applySignInRole, isOidcCallback, oidcProvider, peekProviderRole } from "./oidc";
import { OIDC_PROVIDER_ID, oidcConfig } from "./oidc-config";

const extraTrustedOrigins =
  process.env.EXTRA_TRUSTED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:4717";
const oidc = oidcConfig();
const passwordLogin = !oidc || oidc.passwordLogin;

export const auth = betterAuth({
  baseURL,
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  trustedOrigins: ["overtchat://", ...extraTrustedOrigins],
  // The stock endpoint skips password confirmation and leaves sessions active.
  disabledPaths: ["/admin/set-user-password"],
  rateLimit: {
    customRules: {
      "/admin/reset-user-password": { window: 60, max: 5 },
      "/setup-admin": { window: 60, max: 5 },
    },
    // E2E signs up from one address in parallel workers. Everywhere else,
    // Better Auth's default applies: limits are on in production.
    enabled:
      process.env.OVERTCHAT_E2E_DISABLE_AUTH_RATE_LIMIT === "1" ? false : undefined,
  },
  emailAndPassword: {
    enabled: passwordLogin,
    minPasswordLength: 8,
    autoSignIn: true,
  },
  plugins: [
    admin({ defaultRole: "user", adminRole: "admin" }),
    // Clients on other origins, like the desktop app, send the session token
    // as `Authorization: Bearer` and receive it in `set-auth-token`.
    bearer(),
    expo(),
    // Authenticator apps list the server, so several servers stay apart.
    twoFactor({ issuer: `OvertChat (${new URL(baseURL).host})` }),
    twoFactorRecovery(),
    passwordRecovery(),
    initialSetup(),
    ...(oidc ? [genericOAuth({ config: [oidcProvider(oidc)] })] : []),
  ],
  ...(oidc && {
    account: {
      accountLinking: {
        // Accounts here are created by an administrator or the provider, never
        // by self-signup, so their emails are trusted once the provider has
        // verified the same address. This lets existing accounts move to
        // single sign-on.
        requireLocalEmailVerified: false,
      },
    },
  }),
  databaseHooks: {
    user: {
      create: {
        before: async (data, ctx) => {
          // With single sign-on, the provider creates accounts on first
          // sign-in, with the role its groups give.
          if (oidc && isOidcCallback(ctx)) {
            const role = peekProviderRole(data.email) ?? "user";
            return { data: { ...data, role } };
          }
          // Initial setup uses its own atomic claim. Only admins may create
          // subsequent users via the admin plugin, which sets
          // ctx.context.session. Public signup is closed.
          const sessionUser = ctx?.context?.session?.user;
          if (sessionUser?.role === "admin" && passwordLogin) return { data };
          throw new APIError("BAD_REQUEST", {
            message: passwordLogin
              ? "Signup is closed."
              : "Accounts are created by signing in with single sign-on.",
          });
        },
        after: async (createdUser) => {
          if (createdUser.role === "admin") {
            claimManagedHostConnector(createdUser.id);
          }
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          // Users take the role the provider's groups give at every sign-in.
          // Without admin groups, the first one becomes the administrator.
          if (!oidc || !isOidcCallback(ctx)) return;
          const adapter = ctx!.context.internalAdapter;
          const user = await adapter.findUserById(session.userId);
          if (!user) return;
          const account = (await adapter.findAccounts(user.id)).find(
            (a) => a.providerId === OIDC_PROVIDER_ID,
          );
          const role = applySignInRole(
            oidc,
            user as typeof user & { role?: string | null },
            account?.accountId,
          );
          if (role === "admin") claimManagedHostConnector(user.id);
        },
      },
    },
  },
});
