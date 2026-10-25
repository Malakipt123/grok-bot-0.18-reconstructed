import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { safeText } from "./grok.js";

// OAuth 2.0 for installed apps: the browser signs in, Google redirects to a
// one-shot loopback server on 127.0.0.1, and the code is exchanged with PKCE.
// Only the refresh token is persisted, in a 0600 file next to ASSISTANT.md.

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Read-only: Jarvis can search and read email, never send, change or delete it. */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const REQUESTED_SCOPES = `${GOOGLE_CALENDAR_SCOPE} ${GMAIL_READONLY_SCOPE}`;
export const GOOGLE_TOKEN_FILENAME = "google-token.json";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export class GoogleNotConnectedError extends Error {
  override readonly name = "GoogleNotConnectedError";
  constructor() {
    super("Google is not connected");
  }
}

export interface GoogleOAuthOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenPath: string;
  readonly openUrl: (url: string) => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly loginTimeoutMs?: number;
}

interface StoredToken {
  readonly schemaVersion: 1;
  readonly refreshToken: string;
  readonly scope: string;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const DONE_PAGE = (message: string) => `<!doctype html><meta charset="utf-8"><title>Jarvis</title>
<body style="font:16px -apple-system,system-ui,sans-serif;background:#07131d;color:#e8fbff;display:grid;place-items:center;height:100vh;margin:0">
<p>${message}</p></body>`;

export class GoogleOAuth {
  readonly #options: GoogleOAuthOptions;
  readonly #fetch: typeof fetch;
  #refreshToken: string | null | undefined;
  #scopes: readonly string[] = [];
  #access: { token: string; expiresAt: number } | null = null;
  #login: Promise<void> | null = null;

  constructor(options: GoogleOAuthOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async isConnected(): Promise<boolean> {
    return (await this.#loadRefreshToken()) !== null;
  }

  /**
   * Whether the saved consent includes `scope`. Google lets the user untick
   * permissions, and connections made before Gmail support only have Calendar.
   */
  async hasScope(scope: string): Promise<boolean> {
    return (await this.#loadRefreshToken()) !== null && this.#scopes.includes(scope);
  }

  /** Opens the browser for consent and resolves once the refresh token is saved. */
  connect(): Promise<void> {
    this.#login ??= this.#runLogin().finally(() => {
      this.#login = null;
    });
    return this.#login;
  }

  async disconnect(): Promise<void> {
    const token = await this.#loadRefreshToken();
    this.#refreshToken = null;
    this.#scopes = [];
    this.#access = null;
    await rm(this.#options.tokenPath, { force: true });
    if (token) {
      // Best effort: the local token is already gone even if Google is unreachable.
      await this.#fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
    }
  }

  async accessToken(): Promise<string> {
    const now = this.#now();
    if (this.#access && this.#access.expiresAt - 60_000 > now) return this.#access.token;
    const refreshToken = await this.#loadRefreshToken();
    if (!refreshToken) throw new GoogleNotConnectedError();
    const body = await this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (body.status === 400 || body.status === 401) {
      // Revoked or expired consent: forget it so the user is asked to connect again.
      await this.disconnect();
      throw new GoogleNotConnectedError();
    }
    if (!body.json.access_token) throw new Error(`Google token refresh failed (${body.status})`);
    this.#access = { token: body.json.access_token, expiresAt: now + (body.json.expires_in ?? 3600) * 1000 };
    return this.#access.token;
  }

  async #runLogin(): Promise<void> {
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not open a loopback port for Google sign-in");
    const redirectUri = `http://127.0.0.1:${address.port}`;
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Google sign-in timed out")), this.#options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
        server.on("request", (request, response) => {
          const url = new URL(request.url ?? "/", redirectUri);
          if (url.pathname !== "/" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) {
            response.writeHead(404).end();
            return;
          }
          const finish = (status: number, message: string, outcome: () => void) => {
            response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE(message));
            clearTimeout(timer);
            outcome();
          };
          if (url.searchParams.get("state") !== state) {
            finish(400, "Pedido inválido. Volte a tentar a partir do Jarvis.", () => reject(new Error("Google sign-in state mismatch")));
          } else if (url.searchParams.has("error")) {
            finish(400, "Ligação cancelada.", () => reject(new Error(`Google sign-in was cancelled (${url.searchParams.get("error")})`)));
          } else {
            finish(200, "Conta Google ligada ao Jarvis. Pode fechar esta janela.", () => resolve(url.searchParams.get("code")!));
          }
        });
        const authUrl = new URL(AUTH_URL);
        authUrl.search = new URLSearchParams({
          client_id: this.#options.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: REQUESTED_SCOPES,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        }).toString();
        this.#options.openUrl(authUrl.toString()).catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const exchanged = await this.#token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
      if (!exchanged.json.refresh_token) throw new Error(`Google did not return a refresh token (${exchanged.status})`);
      await this.#saveRefreshToken(exchanged.json.refresh_token, exchanged.json.scope ?? REQUESTED_SCOPES);
      if (exchanged.json.access_token) {
        this.#access = { token: exchanged.json.access_token, expiresAt: this.#now() + (exchanged.json.expires_in ?? 3600) * 1000 };
      }
    } finally {
      server.close();
    }
  }

  async #token(params: Record<string, string>): Promise<{ status: number; json: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } }> {
    const form = new URLSearchParams({ client_id: this.#options.clientId, ...params });
    if (this.#options.clientSecret) form.set("client_secret", this.#options.clientSecret);
    const response = await this.#fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    if (!response.ok && response.status !== 400 && response.status !== 401) {
      throw new Error(`Google token request failed (${response.status}): ${await safeText(response)}`);
    }
    return { status: response.status, json: (await response.json().catch(() => ({}))) as { access_token?: string } };
  }

  async #loadRefreshToken(): Promise<string | null> {
    if (this.#refreshToken !== undefined) return this.#refreshToken;
    try {
      const stored = JSON.parse(await readFile(this.#options.tokenPath, "utf8")) as Partial<StoredToken>;
      this.#refreshToken = stored.schemaVersion === 1 && typeof stored.refreshToken === "string" ? stored.refreshToken : null;
      this.#scopes = this.#refreshToken && typeof stored.scope === "string" ? stored.scope.split(" ") : [];
    } catch {
      this.#refreshToken = null;
    }
    return this.#refreshToken;
  }

  async #saveRefreshToken(refreshToken: string, scope: string): Promise<void> {
    const stored: StoredToken = { schemaVersion: 1, refreshToken, scope };
    await mkdir(path.dirname(this.#options.tokenPath), { recursive: true });
    const temporary = `${this.#options.tokenPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#options.tokenPath);
    this.#refreshToken = refreshToken;
    this.#scopes = scope.split(" ");
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
