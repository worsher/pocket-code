import { writeFile } from "fs/promises";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface GitCredential {
  platform: string;
  host: string;
  username?: string;
  token: string;
}

/**
 * Write git credentials to workspace/.git-credentials and configure
 * git to use the store credential helper.
 *
 * Since runCommand sets HOME=workspace, git config --global writes to
 * workspace/.gitconfig and ~/.git-credentials resolves to workspace/.git-credentials,
 * ensuring per-session credential isolation.
 */
export async function setupGitCredentials(
  workspace: string,
  credentials: GitCredential[]
): Promise<void> {
  const lines = credentials
    .filter((c) => c.token)
    .map((c) => {
      const username = c.username || "oauth2";
      return `https://${username}:${c.token}@${c.host}`;
    });

  if (lines.length === 0) return;

  const credPath = join(workspace, ".git-credentials");
  await writeFile(credPath, lines.join("\n") + "\n", "utf-8");

  // Configure git to use the store credential helper
  await execAsync(
    `git config --global credential.helper 'store --file=${credPath}'`,
    {
      cwd: workspace,
      env: { ...process.env, HOME: workspace },
      timeout: 5000,
    }
  );

  console.log(
    `[Git] Configured ${lines.length} credential(s) for workspace: ${workspace}`
  );
}
