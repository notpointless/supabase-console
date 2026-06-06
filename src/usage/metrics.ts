export interface UsageMetric {
  id: string;
  label: string;
  unit: string;
  limit: number | null;
}

export const USAGE_METRICS: UsageMetric[] = [
  { id: "db_size", label: "Database Size", unit: "GB", limit: 0.5 },
  { id: "egress", label: "Egress", unit: "GB", limit: 5 },
  { id: "cached_egress", label: "Cached Egress", unit: "GB", limit: 5 },
  { id: "monthly_active_users", label: "Monthly Active Users", unit: "MAU", limit: 50000 },
  { id: "monthly_active_third_party_users", label: "Monthly Active Third-Party Users", unit: "MAU", limit: 50000 },
  { id: "monthly_active_sso_users", label: "Monthly Active SSO Users", unit: "MAU", limit: 50000 },
  { id: "storage_size", label: "Storage Size", unit: "GB", limit: 1 },
  { id: "storage_image_transformations", label: "Storage Image Transformations", unit: "images", limit: 0 },
  { id: "realtime_peak_connections", label: "Realtime Concurrent Peak Connections", unit: "connections", limit: 200 },
  { id: "realtime_messages", label: "Realtime Messages", unit: "messages", limit: 2000000 },
  { id: "edge_function_invocations", label: "Edge Function Invocations", unit: "invocations", limit: 500000 },
];
