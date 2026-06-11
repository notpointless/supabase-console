import {
  EC2Client,
  DescribeInstancesCommand,
  CreateVpcEndpointServiceConfigurationCommand,
  ModifyVpcEndpointServicePermissionsCommand,
  DeleteVpcEndpointServiceConfigurationsCommand,
} from "@aws-sdk/client-ec2";
import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  RegisterTargetsCommand,
  CreateListenerCommand,
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project, type Project } from "../db/schema";
import { getCredentials } from "../aws/credentials-service";
import { AppError } from "../http/error";

// [console fork] AWS PrivateLink for a dedicated (EC2) project. A VPC endpoint service must be
// fronted by a Network Load Balancer, so we stand up an internal NLB targeting the instance
// (TargetType=instance, so it survives stop/start — the instance id is stable, only health
// flaps), then a VPC endpoint service backed by it. The project's account allowlist becomes the
// service's AllowedPrincipals. Customers create an interface endpoint to `serviceName` from
// their own VPC. Provisioned lazily the first time an account is allowlisted; torn down on
// project delete.
//
// NOTE: untested against live AWS — built to mirror the existing Ec2Provisioner SDK usage.

export interface PrivatelinkMeta {
  serviceId: string;
  serviceName: string;
  nlbArn: string;
  targetGroupArns: string[];
  status: string;
}

// The project's public surface exposed privately: Kong API gateway + Postgres.
const PRIVATELINK_PORTS = [8000, 5432];

type Creds = { accessKeyId: string; secretAccessKey: string };

function clientsFor(p: Project, creds: Creds) {
  const region = p.region ?? "us-east-1";
  const credentials = { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey };
  return {
    ec2: new EC2Client({ region, credentials }),
    elbv2: new ElasticLoadBalancingV2Client({ region, credentials }),
  };
}

function instanceIdOf(p: Project): string {
  const id = (p.connection as { instanceId?: string } | null)?.instanceId;
  if (!id) throw new AppError(400, "no_instance", `Project ${p.ref} has no running instance`);
  return id;
}

function principalArn(awsAccountId: string): string {
  return `arn:aws:iam::${awsAccountId}:root`;
}

/** Provision (idempotently) the NLB + VPC endpoint service for a dedicated project. */
export async function ensurePrivatelinkService(p: Project): Promise<PrivatelinkMeta> {
  const existing = p.privatelink as PrivatelinkMeta | null;
  if (existing?.serviceId) return existing;
  if (p.infrastructureType !== "dedicated_ec2") {
    throw new AppError(
      400,
      "privatelink_unsupported_infra",
      "PrivateLink is only available on dedicated infrastructure"
    );
  }

  const creds = await getCredentials(p.organizationId);
  const { ec2, elbv2 } = clientsFor(p, creds);
  const instanceId = instanceIdOf(p);

  // 1. Resolve the instance's VPC + subnet (the NLB must live in the same VPC).
  const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const inst = desc.Reservations?.[0]?.Instances?.[0];
  if (!inst?.SubnetId || !inst.VpcId) {
    throw new AppError(502, "vpc_lookup_failed", "Could not resolve the instance's VPC/subnet");
  }

  const short = p.ref.slice(0, 20);

  // 2. Internal NLB in the instance's subnet.
  const lb = await elbv2.send(
    new CreateLoadBalancerCommand({
      Name: `sb-${short}-nlb`.slice(0, 32),
      Type: "network",
      Scheme: "internal",
      Subnets: [inst.SubnetId],
    })
  );
  const nlbArn = lb.LoadBalancers?.[0]?.LoadBalancerArn;
  if (!nlbArn) throw new AppError(502, "nlb_failed", "Failed to create the network load balancer");

  // 3. One TCP target group + listener per exposed port, targeting the instance.
  const targetGroupArns: string[] = [];
  for (const port of PRIVATELINK_PORTS) {
    const tg = await elbv2.send(
      new CreateTargetGroupCommand({
        Name: `sb-${short}-${port}`.slice(0, 32),
        Protocol: "TCP",
        Port: port,
        VpcId: inst.VpcId,
        TargetType: "instance",
      })
    );
    const tgArn = tg.TargetGroups?.[0]?.TargetGroupArn;
    if (!tgArn) throw new AppError(502, "tg_failed", `Failed to create a target group for port ${port}`);
    targetGroupArns.push(tgArn);
    await elbv2.send(
      new RegisterTargetsCommand({ TargetGroupArn: tgArn, Targets: [{ Id: instanceId, Port: port }] })
    );
    await elbv2.send(
      new CreateListenerCommand({
        LoadBalancerArn: nlbArn,
        Protocol: "TCP",
        Port: port,
        DefaultActions: [{ Type: "forward", TargetGroupArn: tgArn }],
      })
    );
  }

  // 4. VPC endpoint service backed by the NLB. The account allowlist (AllowedPrincipals) gates
  //    access, so no manual per-connection acceptance is required.
  const svc = await ec2.send(
    new CreateVpcEndpointServiceConfigurationCommand({
      NetworkLoadBalancerArns: [nlbArn],
      AcceptanceRequired: false,
    })
  );
  const serviceId = svc.ServiceConfiguration?.ServiceId;
  const serviceName = svc.ServiceConfiguration?.ServiceName;
  if (!serviceId || !serviceName) {
    throw new AppError(502, "endpoint_service_failed", "Failed to create the VPC endpoint service");
  }

  const meta: PrivatelinkMeta = { serviceId, serviceName, nlbArn, targetGroupArns, status: "active" };
  await db.update(project).set({ privatelink: meta }).where(eq(project.id, p.id));
  return meta;
}

/** Allow an AWS account to connect to the project's endpoint service. */
export async function addAllowedPrincipal(p: Project, meta: PrivatelinkMeta, awsAccountId: string): Promise<void> {
  const creds = await getCredentials(p.organizationId);
  const { ec2 } = clientsFor(p, creds);
  await ec2.send(
    new ModifyVpcEndpointServicePermissionsCommand({
      ServiceId: meta.serviceId,
      AddAllowedPrincipals: [principalArn(awsAccountId)],
    })
  );
}

/** Revoke an AWS account's access (no-op if the service was never provisioned). */
export async function removeAllowedPrincipal(p: Project, awsAccountId: string): Promise<void> {
  const meta = p.privatelink as PrivatelinkMeta | null;
  if (!meta?.serviceId) return;
  const creds = await getCredentials(p.organizationId);
  const { ec2 } = clientsFor(p, creds);
  await ec2.send(
    new ModifyVpcEndpointServicePermissionsCommand({
      ServiceId: meta.serviceId,
      RemoveAllowedPrincipals: [principalArn(awsAccountId)],
    })
  );
}

/** Tear down the endpoint service + NLB + target groups (project delete). Best-effort. */
export async function teardownPrivatelink(p: Project): Promise<void> {
  const meta = p.privatelink as PrivatelinkMeta | null;
  if (!meta?.serviceId) return;
  const creds = await getCredentials(p.organizationId);
  const { ec2, elbv2 } = clientsFor(p, creds);
  // Endpoint service first, then the NLB (which removes its listeners), then the target groups.
  await ec2
    .send(new DeleteVpcEndpointServiceConfigurationsCommand({ ServiceIds: [meta.serviceId] }))
    .catch(() => {});
  if (meta.nlbArn) {
    await elbv2.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: meta.nlbArn })).catch(() => {});
  }
  for (const tgArn of meta.targetGroupArns ?? []) {
    await elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn })).catch(() => {});
  }
}
