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

export function isEc2Region(id: string): boolean {
  return EC2_REGIONS.some((r) => r.id === id);
}

export function isKnownRegion(id: string): boolean {
  return id === SHARED_REGION.id || isEc2Region(id);
}

export function availableRegions(hasValidCreds: boolean): Region[] {
  return hasValidCreds ? [SHARED_REGION, ...EC2_REGIONS] : [SHARED_REGION];
}
