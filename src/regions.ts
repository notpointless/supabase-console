export interface Region {
  id: string;
  label: string;
}

export const SHARED_REGION: Region = { id: "shared", label: "Shared Infrastructure" };

export const EC2_REGIONS: Region[] = [
  { id: "us-east-1", label: "East US (N. Virginia)" },
  { id: "us-west-2", label: "West US (Oregon)" },
  { id: "eu-west-1", label: "West EU (Ireland)" },
  { id: "eu-central-1", label: "Central EU (Frankfurt)" },
  { id: "ap-southeast-1", label: "Southeast Asia (Singapore)" },
  { id: "ap-northeast-1", label: "Northeast Asia (Tokyo)" },
];

// The dashboard offers the full AWS region catalog (shared-data); EC2_REGIONS above
// is just the curated/labelled subset. The provisioner is region-agnostic (dynamic AMI
// lookup + default-VPC auto-create per region), so accept ANY valid AWS region code —
// not only the labelled ones — so every region the UI shows actually provisions.
const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

export function isEc2Region(id: string): boolean {
  return id !== SHARED_REGION.id && AWS_REGION_RE.test(id);
}

export function isKnownRegion(id: string): boolean {
  return id === SHARED_REGION.id || isEc2Region(id);
}

export function availableRegions(hasValidCreds: boolean): Region[] {
  return hasValidCreds ? [SHARED_REGION, ...EC2_REGIONS] : [SHARED_REGION];
}
