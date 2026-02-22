// ── GitHub OAuth ─────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from "http";
import { signToken, type AuthPayload } from "./auth.js";
import { getUserByGithubId, upsertUser } from "./db.js";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const OAUTH_CALLBACK_URL = process.env.OAUTH_CALLBACK_URL || "";
const APP_SCHEME = process.env.APP_SCHEME || "pocket-code";

// CSRF state store with expiry
const stateStore = new Map<string, number>();

// Cleanup old states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, ts] of stateStore) {
    if (now - ts > 10 * 60 * 1000) stateStore.delete(state);
  }
}, 5 * 60 * 1000);

export function isOAuthConfigured(): boolean {
  return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!isOAuthConfigured()) return false;

  // Start OAuth flow
  if (url.pathname === "/oauth/github/start") {
    const state = crypto.randomUUID();
    stateStore.set(state, Date.now());

    const callbackUrl = OAUTH_CALLBACK_URL || `${url.origin}/oauth/github/callback`;
    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
    githubUrl.searchParams.set("redirect_uri", callbackUrl);
    githubUrl.searchParams.set("scope", "user,repo");
    githubUrl.searchParams.set("state", state);

    res.writeHead(302, { Location: githubUrl.toString() });
    res.end();
    return true;
  }

  // OAuth callback
  if (url.pathname === "/oauth/github/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code or state parameter");
      return true;
    }

    // Verify CSRF state
    if (!stateStore.has(state)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid or expired state");
      return true;
    }
    stateStore.delete(state);

    try {
      // Exchange code for access token
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

      if (!tokenData.access_token) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`OAuth error: ${tokenData.error || "Failed to get access token"}`);
        return true;
      }

      // Fetch GitHub user info
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json",
        },
      });
      const ghUser = await userRes.json() as {
        id: number;
        login: string;
        name?: string;
        avatar_url?: string;
      };

      // Find or create user
      let user = getUserByGithubId(ghUser.id);
      const userId = user?.userId || `gh_${ghUser.id}`;

      upsertUser({
        userId,
        githubId: ghUser.id,
        githubLogin: ghUser.login,
        githubToken: tokenData.access_token,
        displayName: ghUser.name || ghUser.login,
        avatarUrl: ghUser.avatar_url || null,
      });

      // Sign JWT
      const payload: AuthPayload = {
        userId,
        deviceId: "",
        githubId: ghUser.id,
        githubLogin: ghUser.login,
      };
      const token = signToken(payload);

      // Redirect back to app via deep link
      const redirectUrl = `${APP_SCHEME}://oauth?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId)}&githubLogin=${encodeURIComponent(ghUser.login)}&avatarUrl=${encodeURIComponent(ghUser.avatar_url || "")}`;

      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return true;
    } catch (err: any) {
      console.error("[OAuth] Error:", err.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`OAuth error: ${err.message}`);
      return true;
    }
  }

  return false;
}
