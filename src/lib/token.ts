import { CloudflareClient } from "./cf-client";
import type {
  TokenVerifyResult,
  CloudflareAccount,
  CloudflareZone,
  Permission,
  TokenCapabilities,
} from "@/types/cloudflare";

export async function verifyToken(token: string): Promise<TokenVerifyResult> {
  const client = new CloudflareClient(token);
  const response = await client.rest<TokenVerifyResult>("/user/tokens/verify");

  if (!response.success) {
    throw new Error(
      response.errors.map((e) => e.message).join(", ") || "Token verification failed"
    );
  }

  if (response.result.status !== "active") {
    throw new Error(`Token is ${response.result.status}`);
  }

  return response.result;
}

export async function discoverAccounts(
  client: CloudflareClient
): Promise<CloudflareAccount[]> {
  const response = await client.restPaginated<CloudflareAccount>("/accounts");
  return response;
}

export async function discoverZones(
  client: CloudflareClient
): Promise<CloudflareZone[]> {
  const response = await client.restPaginated<CloudflareZone>("/zones");
  return response;
}

async function probeRest(
  client: CloudflareClient,
  path: string
): Promise<boolean> {
  try {
    const response = await client.rest(path, { useCache: false });
    return response.success;
  } catch {
    return false;
  }
}

async function probeGraphQL(
  client: CloudflareClient,
  zoneId: string
): Promise<boolean> {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const query = `query { viewer { zones(filter: { zoneTag: "${zoneId}" }) { httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_gt: "${yesterday.toISOString()}", datetime_lt: "${now.toISOString()}" }) { count } } } }`;
    const response = await client.graphql(query);
    return !response.errors?.length;
  } catch {
    return false;
  }
}

export async function detectCapabilities(
  token: string
): Promise<TokenCapabilities> {
  const client = new CloudflareClient(token);

  const [accounts, zones] = await Promise.all([
    discoverAccounts(client),
    discoverZones(client),
  ]);

  const permissions: Permission[] = [];

  // Probe permissions in parallel
  type Probe = { permission: Permission; check: () => Promise<boolean> };
  const probes: Probe[] = [];

  if (zones.length > 0) {
    const zoneId = zones[0].id;
    probes.push(
      { permission: "zone_analytics", check: () => probeGraphQL(client, zoneId) },
      { permission: "firewall", check: () => probeRest(client, `/zones/${zoneId}/firewall/rules`) },
      { permission: "dns_read", check: () => probeRest(client, `/zones/${zoneId}/dns_records`) }
    );
  }

  if (accounts.length > 0) {
    const accountId = accounts[0].id;
    probes.push(
      { permission: "account_settings", check: () => probeRest(client, `/accounts/${accountId}`) },
      { permission: "gateway", check: () => probeRest(client, `/accounts/${accountId}/gateway/rules`) },
      { permission: "access", check: () => probeRest(client, `/accounts/${accountId}/access/apps`) }
    );
  }

  const results = await Promise.all(
    probes.map(async (probe) => ({
      permission: probe.permission,
      ok: await probe.check(),
    }))
  );

  for (const result of results) {
    if (result.ok) {
      permissions.push(result.permission);
    }
  }

  // If gateway or access works, also mark zero_trust
  if (permissions.includes("gateway") || permissions.includes("access")) {
    permissions.push("zero_trust");
  }

  return { permissions, accounts, zones };
}
