import { AppError } from "../http/error";

// ---------------------------------------------------------------------------
// GitHub App OAuth helpers (talk to GitHub on behalf of the user).
//
// The dashboard's "Connect GitHub" flow is a GitHub App user-authorization: the
// user approves in a popup, GitHub redirects back with a `code`, we exchange it
// for a user-access token, then list the App's installed repositories. The same
// user token is used to read `supabase/migrations` for deploys.
//
// Requires GITHUB_INTEGRATION_CLIENT_ID + GITHUB_INTEGRATION_CLIENT_SECRET (the
// GitHub App's credentials). Without them, the integration is unconfigured.
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

export function githubAppConfigured(): boolean {
  return !!(process.env.GITHUB_INTEGRATION_CLIENT_ID && process.env.GITHUB_INTEGRATION_CLIENT_SECRET);
}

function requireConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GITHUB_INTEGRATION_CLIENT_ID;
  const clientSecret = process.env.GITHUB_INTEGRATION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError(
      400,
      "github_not_configured",
      "GitHub App is not configured. Set GITHUB_INTEGRATION_CLIENT_ID and GITHUB_INTEGRATION_CLIENT_SECRET."
    );
  }
  return { clientId, clientSecret };
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "supabase-console",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

/** Exchange an OAuth `code` for a user-access token. */
export async function exchangeCode(code: string): Promise<string> {
  const { clientId, clientSecret } = requireConfig();
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "supabase-console" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new AppError(400, "github_oauth_failed", body.error_description ?? body.error ?? "Failed to exchange GitHub code");
  }
  return body.access_token;
}

export interface GithubIdentity {
  id: number;
  login: string;
}

/** Fetch the authenticated GitHub user. */
export async function getGithubUser(token: string): Promise<GithubIdentity> {
  const res = await fetch(`${GITHUB_API}/user`, { headers: apiHeaders(token) });
  if (!res.ok) throw new AppError(400, "github_error", `GitHub /user ${res.status}`);
  const u = (await res.json()) as { id: number; login: string };
  return { id: u.id, login: u.login };
}

export interface GithubRepo {
  id: number;
  name: string; // short name
  full_name: string; // owner/repo
  installation_id: number;
  default_branch: string;
}

/** List repositories the user can access through this App's installations. */
export async function listRepositories(token: string): Promise<GithubRepo[]> {
  const instRes = await fetch(`${GITHUB_API}/user/installations`, { headers: apiHeaders(token) });
  if (!instRes.ok) throw new AppError(400, "github_error", `GitHub /user/installations ${instRes.status}`);
  const { installations } = (await instRes.json()) as { installations: Array<{ id: number }> };

  const repos: GithubRepo[] = [];
  for (const inst of installations ?? []) {
    let page = 1;
    // Paginate this installation's repos (cap to keep it bounded).
    for (; page <= 10; page++) {
      const r = await fetch(
        `${GITHUB_API}/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
        { headers: apiHeaders(token) }
      );
      if (!r.ok) break;
      const { repositories } = (await r.json()) as {
        repositories: Array<{ id: number; name: string; full_name: string; default_branch: string }>;
      };
      for (const repo of repositories ?? []) {
        repos.push({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          installation_id: inst.id,
          default_branch: repo.default_branch ?? "main",
        });
      }
      if (!repositories || repositories.length < 100) break;
    }
  }
  return repos;
}

/** Resolve a repository's full name (owner/repo) + default branch by its id. */
export async function getRepoById(token: string, repositoryId: number): Promise<GithubRepo | null> {
  const repos = await listRepositories(token);
  return repos.find((r) => r.id === repositoryId) ?? null;
}

/** Check whether a branch exists in a repo (owner/repo). Returns the branch name or null. */
export async function checkBranch(token: string, fullName: string, branch: string): Promise<string | null> {
  const res = await fetch(`${GITHUB_API}/repos/${fullName}/branches/${encodeURIComponent(branch)}`, {
    headers: apiHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new AppError(400, "github_error", `GitHub branch check ${res.status}`);
  const b = (await res.json()) as { name: string };
  return b.name;
}
