import {
  createRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import {
  fetchSetupRequired,
  sessionQuery,
  signInMethodsQuery,
  twoFactorQuery,
} from "@/lib/queries/auth";
import { withPages } from "@/spa/lazy";
import { authRoute } from "@/spa/routes/root";

const LoginForm = lazyRouteComponent(
  () => import("@/components/auth/LoginForm"),
  "LoginForm",
);

const RequiredTwoFactorSetup = lazyRouteComponent(
  () => import("@/components/auth/RequiredTwoFactorSetup"),
  "RequiredTwoFactorSetup",
);

export const loginRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "/login",
  // Single sign-on returns here with `?error=<code>` when it fails, and
  // another address of this server sends `?sso=start` to begin it here.
  validateSearch: (
    search: Record<string, unknown>,
  ): { error?: string; sso?: "start" } => ({
    ...(typeof search.error === "string" && search.error
      ? { error: search.error }
      : {}),
    ...(search.sso === "start" ? { sso: "start" as const } : {}),
  }),
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (session) throw redirect({ to: "/" });
    if (await fetchSetupRequired()) throw redirect({ to: "/signup" });
    const signInMethods =
      await context.queryClient.fetchQuery(signInMethodsQuery);
    return { signInMethods };
  },
  component: withPages(function LoginPage() {
    const { signInMethods } = loginRoute.useRouteContext();
    const { error, sso } = loginRoute.useSearch();
    return (
      <LoginForm
        methods={signInMethods}
        ssoError={error}
        startSso={sso === "start" && !error}
      />
    );
  }, LoginForm),
});

export const signupRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "/signup",
  beforeLoad: async () => {
    if (!(await fetchSetupRequired())) throw redirect({ to: "/login" });
  },
  component: lazyRouteComponent(
    () => import("@/components/auth/SignupForm"),
    "SignupForm",
  ),
});

/** Administrators set up two-factor here first when the server requires it. */
export const twoFactorSetupRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "/two-factor-setup",
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session) throw redirect({ to: "/login" });
    const status = await context.queryClient.fetchQuery(twoFactorQuery);
    if (!status.required || status.enabled) throw redirect({ to: "/" });
    return { email: session.user.email };
  },
  component: withPages(function TwoFactorSetupPage() {
    const { email } = twoFactorSetupRoute.useRouteContext();
    return <RequiredTwoFactorSetup email={email} />;
  }, RequiredTwoFactorSetup),
});
