/**
 * A local OpenID Connect provider for trying single sign-on in development. It
 * signs one user in without a login page. See docs/development.md.
 */
import { startMockOidcProvider } from "../lib/auth/fixtures/mock-oidc-provider";

const port = Number(process.env.MOCK_OIDC_PORT ?? 47999);
const email = process.env.MOCK_OIDC_EMAIL ?? "dev@example.com";
const groups = (process.env.MOCK_OIDC_GROUPS ?? "admins").split(",").filter(Boolean);

startMockOidcProvider(
  "overtchat-dev",
  {
    sub: `mock-${email}`,
    email,
    email_verified: true,
    name: process.env.MOCK_OIDC_NAME ?? "Dev User",
    groups,
  },
  port,
).then((provider) => {
  console.log(`Mock OpenID Connect provider at ${provider.issuer}`);
  console.log(`Signs in ${email} with groups [${groups.join(", ")}].`);
});
