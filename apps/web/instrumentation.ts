export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runMigrations } = await import("@/lib/db/migrate");
  runMigrations();

  // Fails startup on an incomplete single sign-on configuration.
  const { oidcConfig } = await import("@/lib/auth/oidc-config");
  const oidc = oidcConfig();
  if (oidc) {
    console.log(`[auth] Single sign-on through ${oidc.issuer}; initial setup is skipped.`);
  }

  const { getSetupCode } = await import("@/lib/db/initialSetup");
  const code = getSetupCode();
  if (code) {
    console.log(`[setup] Create your administrator account with setup code ${code}.`);
  }

  const { ensureServerCapabilityConfigs } = await import(
    "@/lib/db/serverCapabilities"
  );
  ensureServerCapabilityConfigs();

  try {
    const { terminalRelay } = await import("@/lib/agents/terminal/server");
    await terminalRelay.start(Number(process.env.OVERTCHAT_TERMINAL_RELAY_PORT ?? 14717));
  } catch (error) {
    console.error("[terminal-relay] Workspace terminals unavailable:", error);
  }

  const { sweepOrphanedUploads } = await import("@/lib/db/uploads");
  sweepOrphanedUploads().catch((err) =>
    console.error("[sweep-orphan-uploads]", err),
  );
}
