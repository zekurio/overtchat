import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockProfile = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  /** Sent from userinfo only, as many providers do. */
  groups?: string[];
};

/**
 * A minimal OpenID Connect provider for tests: discovery, JWKS, a token
 * endpoint that signs RS256 ID tokens, and userinfo. `authorize` stands in for
 * the browser visit and returns the callback query.
 */
export async function startMockOidcProvider(
  clientId: string,
  /** Signs this profile in at `/authorize`, for trying the flow in a browser. */
  autoApprove?: MockProfile,
  port = 0,
) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const forger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  let forgeNext = false;
  let failUserinfo = false;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { profile: MockProfile; nonce?: string; challenge?: string }>();
  const accessTokens = new Map<string, MockProfile>();
  let issuer = "";

  function idToken(profile: MockProfile, nonce?: string) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims: Partial<MockProfile> = { ...profile };
    delete claims.groups;
    const input = `${encode({ alg: "RS256", kid: "test", typ: "JWT" })}.${encode({
      ...claims, iss: issuer, aud: clientId, iat: now, exp: now + 300, ...(nonce ? { nonce } : {}),
    })}`;
    const key = forgeNext ? forger : privateKey;
    forgeNext = false;
    return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize" && autoApprove) {
      const query = provider.authorize(url.toString(), autoApprove);
      const target = new URL(url.searchParams.get("redirect_uri")!);
      for (const [key, value] of query) target.searchParams.set(key, value);
      res.writeHead(302, { Location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!grant || grant.challenge !== challenge) return json(400, { error: "invalid_grant" });
      const accessToken = randomUUID();
      accessTokens.set(accessToken, grant.profile);
      return json(200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken(grant.profile, grant.nonce),
      });
    }
    if (url.pathname === "/userinfo") {
      if (failUserinfo) {
        failUserinfo = false;
        return json(503, { error: "temporarily_unavailable" });
      }
      const token = req.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      const profile = accessTokens.get(token);
      if (!profile) return json(401, { error: "invalid_token" });
      return json(200, profile);
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const provider = {
    issuer,
    /** Signs the profile in at the authorization URL; returns the callback query. */
    authorize(authorizationUrl: string, profile: MockProfile): URLSearchParams {
      const request = new URL(authorizationUrl);
      if (request.searchParams.get("client_id") !== clientId) throw new Error("wrong client");
      const code = randomUUID();
      codes.set(code, {
        profile,
        nonce: request.searchParams.get("nonce") ?? undefined,
        challenge: request.searchParams.get("code_challenge") ?? undefined,
      });
      return new URLSearchParams({ code, state: request.searchParams.get("state")! });
    },
    /** Signs the next ID token with a key the provider does not publish. */
    forgeNextIdToken() {
      forgeNext = true;
    },
    /** Answers the next userinfo request with an error. */
    failNextUserinfo() {
      failUserinfo = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return provider;
}
