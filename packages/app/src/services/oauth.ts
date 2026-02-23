// ── GitHub OAuth Client ────────────────────────────────
// Opens the OAuth flow in the system browser and handles
// the deep-link callback to extract the JWT token.

import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

export interface OAuthResult {
  token: string;
  userId: string;
  githubLogin: string;
  avatarUrl: string;
}

/**
 * Start the GitHub OAuth flow.
 * Opens the system browser to `serverBaseUrl/oauth/github/start`,
 * then listens for the `pocket-code://oauth?token=xxx` deep link.
 */
export async function startGitHubOAuth(
  serverBaseUrl: string
): Promise<OAuthResult | null> {
  // Convert ws:// to http:// for OAuth endpoint
  const httpBase = serverBaseUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://");

  const startUrl = `${httpBase}/oauth/github/start`;
  const redirectUrl = Linking.createURL("oauth");

  try {
    const result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUrl);

    if (result.type === "success" && result.url) {
      return parseOAuthCallback(result.url);
    }

    return null;
  } catch (err) {
    console.error("[OAuth] Error:", err);
    return null;
  }
}

/** Parse the OAuth callback URL parameters */
function parseOAuthCallback(url: string): OAuthResult | null {
  try {
    const parsed = Linking.parse(url);
    const params = parsed.queryParams || {};

    if (!params.token) return null;

    return {
      token: params.token as string,
      userId: (params.userId as string) || "",
      githubLogin: (params.githubLogin as string) || "",
      avatarUrl: (params.avatarUrl as string) || "",
    };
  } catch {
    return null;
  }
}
