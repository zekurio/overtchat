import type { SignInMethods } from "@overtchat/shared";
import { OIDC_PROVIDER_ID, oidcConfig } from "@/lib/auth/oidc-config";

/** Public: which sign-in methods the login screen offers. */
export function GET() {
  const oidc = oidcConfig();
  return Response.json(
    {
      password: !oidc || oidc.passwordLogin,
      sso: oidc
        ? {
            provider: OIDC_PROVIDER_ID,
            name: oidc.name,
            managesRoles: oidc.adminGroups.length > 0,
          }
        : null,
    } satisfies SignInMethods,
    { headers: { "Cache-Control": "no-store" } },
  );
}
