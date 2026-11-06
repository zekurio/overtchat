import { z } from "zod";
import { auth } from "@/lib/auth/server";
import { oidcConfig, passwordLoginEnabled } from "@/lib/auth/oidc-config";
import { findUserByEmail, resetUserPassword } from "@/lib/db/passwords";
import { managementRequestAuthorized } from "@/lib/management/auth";

export async function POST(request: Request) {
  if (!managementRequestAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }
  // A password would be unusable, so recovery says what to change instead.
  if (!passwordLoginEnabled()) {
    return Response.json(
      {
        error:
          "Password sign-in is off on this server. Set OVERTCHAT_OIDC_PASSWORD_LOGIN=true, restart the app, and try again.",
      },
      { status: 409 },
    );
  }
  const parsed = z
    .object({
      email: z.email().trim().toLowerCase(),
      newPassword: z.string().min(1).max(128),
    })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Enter a valid email and password." },
      { status: 400 },
    );
  }
  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;
  if (
    parsed.data.newPassword.length < minPasswordLength ||
    parsed.data.newPassword.length > maxPasswordLength
  ) {
    return Response.json(
      {
        error: `Use between ${minPasswordLength} and ${maxPasswordLength} characters.`,
      },
      { status: 400 },
    );
  }
  const target = findUserByEmail(parsed.data.email);
  if (!target)
    return Response.json({ error: "User not found." }, { status: 404 });
  const hash = await context.password.hash(parsed.data.newPassword);
  // With single sign-on, an account may have no password yet. The operator can
  // give it one, so an administrator can sign in while the provider is down.
  const result = resetUserPassword(target.id, hash, undefined, {
    addIfMissing: oidcConfig() !== null,
  });
  if (result === "not_found")
    return Response.json({ error: "User not found." }, { status: 404 });
  if (result !== "updated") {
    return Response.json(
      { error: "This account does not use a password." },
      { status: 409 },
    );
  }
  return Response.json({ status: true });
}
