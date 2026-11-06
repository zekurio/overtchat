"use client";

import {
  ssoAddressMatches,
  ssoAddressMessage,
  ssoErrorMessage,
  TWO_FACTOR_CLIENT_HEADER,
  type SignInMethods,
} from "@overtchat/shared";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { getApiOrigin } from "@/lib/api-url";
import { authClient } from "@/lib/auth/client";
import { desktopBridge } from "@/lib/desktop";
import { useResetAuthState } from "@/lib/queries/auth";
import { TwoFactorCodeForm } from "./TwoFactorCodeForm";

export function LoginForm({
  methods,
  ssoError,
  startSso = false,
}: {
  methods: SignInMethods;
  /** The `error` code single sign-on returned with. */
  ssoError?: string;
  /** Starts single sign-on right away, after moving to the server's public address. */
  startSso?: boolean;
}) {
  const navigate = useNavigate();
  const resetAuthState = useResetAuthState();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() =>
    ssoError ? ssoErrorMessage(ssoError) : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);

  async function finish() {
    resetAuthState();
    await navigate({ to: "/", replace: true });
  }

  async function signInWithSso(provider: string) {
    setError("");
    const origin = methods.sso?.origin;
    const desktop = desktopBridge();
    if (desktop) {
      // The provider returns to the server's public address, so the desktop
      // app has to be connected to that address.
      if (origin && !ssoAddressMatches(methods, getApiOrigin())) {
        setError(ssoAddressMessage(origin));
        return;
      }
      setSubmitting(true);
      // The bundled UI is on another origin than the server, so the desktop
      // app runs the provider's pages in its own window.
      if (!desktop.signInWithSso) {
        setError("Update the OvertChat app to use single sign-on.");
        setSubmitting(false);
        return;
      }
      const result = await desktop.signInWithSso(provider);
      if (result.ok) {
        await finish();
        return;
      }
      if (result.error) setError(ssoErrorMessage(result.error));
      setSubmitting(false);
      return;
    }
    // The sign-in's state cookie has to be on the address the provider
    // returns to. Move there once; a second mismatch means a misconfigured
    // BETTER_AUTH_URL, and moving again would loop.
    if (origin && !ssoAddressMatches(methods, window.location.origin)) {
      if (startSso) {
        setError(ssoAddressMessage(origin));
        return;
      }
      window.location.assign(new URL("/login?sso=start", origin).toString());
      return;
    }
    setSubmitting(true);
    // Leaves the app for the provider, which returns to `callbackURL`.
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: "/",
      errorCallbackURL: "/login",
    });
    if (error) {
      setError(error.message ?? "Single sign-on failed");
      setSubmitting(false);
    }
  }

  // Arriving from another address of this server with `?sso=start`.
  const started = useRef(false);
  useEffect(() => {
    if (!startSso || started.current || !methods.sso) return;
    started.current = true;
    void signInWithSso(methods.sso.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on arrival
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    const { data, error } = await authClient.signIn.email(
      { email, password },
      { headers: { [TWO_FACTOR_CLIENT_HEADER]: "1" } },
    );
    if (error) {
      setError(error.message ?? "Login failed");
      setSubmitting(false);
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setSubmitting(false);
      setNeedsCode(true);
      return;
    }
    await finish();
  }

  if (needsCode) {
    return (
      <TwoFactorCodeForm
        onVerified={finish}
        onRestart={(message) => {
          setNeedsCode(false);
          setPassword("");
          setError(message);
        }}
      />
    );
  }

  const sso = methods.sso;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          Welcome back
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to continue.
        </p>
      </header>

      {sso && (
        <Button
          type="button"
          variant={methods.password ? "outline" : "default"}
          disabled={submitting}
          className="w-full"
          onClick={() => void signInWithSso(sso.provider)}
        >
          Continue with {sso.name}
        </Button>
      )}

      {sso && methods.password && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {!methods.password && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {methods.password && (
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
          <Button
            type="button"
            variant="link"
            className="w-full"
            aria-expanded={showRecovery}
            aria-controls="password-recovery-help"
            onClick={() => setShowRecovery((shown) => !shown)}
          >
            Forgot password?
          </Button>
          {showRecovery && (
            <div id="password-recovery-help" className="space-y-2 text-sm text-muted-foreground">
              <p>
                Contact your server administrator to reset your password. Another
                administrator can also help if you are an admin.
              </p>
              <p>
                If all administrators are locked out, the server owner can run{" "}
                <code>overtchat reset-password</code> on the server, or{" "}
                <code>overtchat reset-two-factor</code> for a lost authenticator.
              </p>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
