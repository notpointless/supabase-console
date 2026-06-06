export interface OAuthScopeResource {
  id: string;
  label: string;
  description: string;
}

export const OAUTH_SCOPE_RESOURCES: OAuthScopeResource[] = [
  { id: "analytics", label: "Analytics", description: "access to analytics logs." },
  {
    id: "analytics_config",
    label: "Analytics Config",
    description: "access to analytics logs configurations.",
  },
  {
    id: "auth",
    label: "Auth",
    description: "access to auth configurations and SSO providers.",
  },
  {
    id: "database",
    label: "Database",
    description:
      "access to Postgres configurations, SQL snippets, SSL enforcement, and TypeScript schema types.",
  },
  {
    id: "domains",
    label: "Domains",
    description: "access to custom domains and vanity subdomains.",
  },
  { id: "edge_functions", label: "Edge Functions", description: "access to edge functions." },
  {
    id: "environment",
    label: "Environment",
    description: "access to environments/branches.",
  },
  {
    id: "organizations",
    label: "Organizations",
    description: "access to the organization and all its members.",
  },
  {
    id: "projects",
    label: "Projects",
    description:
      "access to creation and deletion of projects, metadata, upgrade status, network restrictions and bans.",
  },
  { id: "rest", label: "REST", description: "access to PostgREST configurations." },
  {
    id: "secrets",
    label: "Secrets",
    description: "access to API keys, secrets and pgsodium configurations.",
  },
  {
    id: "storage",
    label: "Storage",
    description: "access to storage buckets and files.",
  },
];

/** Access level for a resource. `write` implies `read`. */
export type OAuthAccess = "none" | "read" | "write";

/**
 * Convert a { resourceId: access } map into scope strings.
 * "write" produces both `<res>:read` and `<res>:write`.
 * "none" is skipped. Unknown resource ids are silently ignored.
 */
export function permissionsToScopes(perms: Record<string, OAuthAccess>): string[] {
  const ids = new Set(OAUTH_SCOPE_RESOURCES.map((r) => r.id));
  const scopes: string[] = [];
  for (const [res, access] of Object.entries(perms)) {
    if (!ids.has(res) || access === "none") continue;
    scopes.push(`${res}:read`);
    if (access === "write") scopes.push(`${res}:write`);
  }
  return scopes;
}

/** Return true if the scope string is a known `<resource>:read|write` pair. */
export function isValidScope(s: string): boolean {
  const [res, action] = s.split(":");
  return (
    OAUTH_SCOPE_RESOURCES.some((r) => r.id === res) &&
    (action === "read" || action === "write")
  );
}
