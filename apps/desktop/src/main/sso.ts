import { BrowserWindow, net } from "electron";
import { getServerOrigin, getSessionToken } from "./settings";
import { getMainWindow } from "./window";

export interface SsoResult {
  ok: boolean;
  /** The provider's error code; absent when the user closed the window. */
  error?: string;
}

/** Where the server sends the window back; never loaded, only recognized. */
const DONE_PATH = "/";
const ERROR_PATH = "/login";

let active: Promise<SsoResult> | null = null;

/**
 * Signs in through the server's single sign-on provider. The UI runs at
 * `overtchat://app`, where the server's cookies are third-party, so the
 * provider's pages run in a window of their own on the server's origin. The
 * server's callback answers with `set-auth-token`, which `configureServerAuth`
 * keeps as the session, like a password sign-in.
 */
export function signInWithSso(provider: unknown): Promise<SsoResult> {
  if (typeof provider !== "string" || !provider) return Promise.resolve({ ok: false });
  active ??= run(provider).finally(() => {
    active = null;
  });
  return active;
}

async function run(provider: string): Promise<SsoResult> {
  const origin = getServerOrigin();
  if (!origin) return { ok: false };
  const response = await net.fetch(`${origin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      provider,
      callbackURL: `${origin}${DONE_PATH}`,
      errorCallbackURL: `${origin}${ERROR_PATH}`,
    }),
  });
  if (!response.ok) return { ok: false, error: "sign_in_unavailable" };
  const { url } = (await response.json()) as { url?: string };
  if (!url) return { ok: false, error: "sign_in_unavailable" };
  // Sets the sign-in's state cookie on the server's origin in this window,
  // then continues to the provider. The mobile app uses the same endpoint.
  const start = new URL("/api/auth/expo-authorization-proxy", origin);
  start.searchParams.set("authorizationURL", url);

  const tokenBefore = getSessionToken();
  const parent = getMainWindow() ?? undefined;
  const win = new BrowserWindow({
    parent,
    modal: !!parent,
    width: 520,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise<SsoResult>((resolve) => {
    let settled = false;
    const finish = (result: SsoResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!win.isDestroyed()) win.close();
    };
    // The callback's redirect back to the server's app ends the sign-in. Its
    // response headers, with the session token, were read before this.
    const onRedirect = (event: Electron.Event, target: string) => {
      let next: URL;
      try {
        next = new URL(target);
      } catch {
        return;
      }
      if (next.origin !== origin || next.pathname.startsWith("/api/")) return;
      event.preventDefault();
      const error = next.pathname === ERROR_PATH ? next.searchParams.get("error") : null;
      const signedIn = !error && getSessionToken() !== null && getSessionToken() !== tokenBefore;
      finish(signedIn ? { ok: true } : { ok: false, error: error ?? "sign_in_failed" });
    };
    win.webContents.on("will-redirect", onRedirect);
    win.webContents.on("will-navigate", onRedirect);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => finish({ ok: false }));
    win.loadURL(start.toString()).catch(() => {
      // A redirect this window stops also rejects the load.
      if (!settled) finish({ ok: false, error: "sign_in_unavailable" });
    });
  });
}
