import { cfRest, cfRestPaginated } from "@/lib/use-cf-data";

// --- Types ---

interface DeviceItem {
  name: string;
  user: string;
  email: string;
  os: string;
  osVersion: string;
  warpVersion: string;
  lastSeen: string;
  status: "active" | "inactive" | "stale";
}

interface UserItem {
  name: string;
  email: string;
  accessSeat: boolean;
  gatewaySeat: boolean;
  deviceCount: number;
  lastLogin: string | null;
}

interface PostureRule {
  name: string;
  type: string;
  description: string;
}

interface OsDistribution {
  name: string;
  value: number;
}

interface WarpVersionDistribution {
  name: string;
  value: number;
}

export interface DevicesUsersData {
  devices: DeviceItem[];
  users: UserItem[];
  postureRules: PostureRule[];
  postureError: string | null;
  osDistribution: OsDistribution[];
  warpVersionDistribution: WarpVersionDistribution[];
  stats: {
    totalDevices: number;
    activeDevices: number;
    inactiveDevices: number;
    staleDevices: number;
    totalUsers: number;
    accessSeats: number;
    gatewaySeats: number;
  };
}

// --- Helpers ---

function classifyDevice(lastSeenStr: string): "active" | "inactive" | "stale" {
  const lastSeen = new Date(lastSeenStr).getTime();
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;

  if (now - lastSeen < 24 * hourMs) return "active";
  if (now - lastSeen > 30 * dayMs) return "stale";
  return "inactive";
}

function formatOsName(platform: string | undefined, osVersion: string | undefined): string {
  if (!platform) return "Unknown";
  const p = platform.toLowerCase();
  if (p.includes("windows")) return "Windows";
  if (p.includes("mac") || p.includes("darwin")) return "macOS";
  if (p.includes("linux")) return "Linux";
  if (p.includes("ios")) return "iOS";
  if (p.includes("android")) return "Android";
  if (p.includes("chrome")) return "ChromeOS";
  return osVersion ? `${platform} ${osVersion}` : platform;
}

// --- API Types ---

interface CfDevice {
  id: string;
  name?: string;
  device_type?: string;
  os_version?: string;
  // The deprecated /devices endpoint returns "version" (not "client_version")
  // and "last_seen" (not "last_seen_at"). The newer /physical-devices endpoint
  // uses "client_version" and "last_seen" respectively.
  version?: string;
  last_seen?: string;
  user?: {
    name?: string;
    email?: string;
    id?: string;
  };
}

interface CfAccessUser {
  id: string;
  name?: string;
  email?: string;
  access_seat?: boolean;
  gateway_seat?: boolean;
  seat_uid?: string;
  created_at?: string;
  updated_at?: string;
}

interface CfPostureRule {
  id: string;
  name?: string;
  type?: string;
  description?: string;
}

// --- Fetchers ---

async function fetchDevices(accountId: string): Promise<CfDevice[]> {
  try {
    return await cfRestPaginated<CfDevice>(`/accounts/${accountId}/devices`);
  } catch {
    // Fall back to empty — the endpoint may require specific permissions
    return [];
  }
}

async function fetchUsers(accountId: string): Promise<CfAccessUser[]> {
  try {
    return await cfRestPaginated<CfAccessUser>(`/accounts/${accountId}/access/users`);
  } catch {
    return [];
  }
}

async function fetchPostureRules(
  accountId: string
): Promise<{ rules: CfPostureRule[]; error: string | null }> {
  try {
    const rules = await cfRest<CfPostureRule[]>(
      `/accounts/${accountId}/devices/posture`
    );
    return { rules, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to fetch posture rules";
    if (msg.includes("403") || msg.toLowerCase().includes("permission")) {
      return {
        rules: [],
        error: "Posture rules require additional permissions (Device Posture Read).",
      };
    }
    return { rules: [], error: msg };
  }
}

// --- Main fetch ---

export async function fetchDevicesUsersData(
  accountId: string
): Promise<DevicesUsersData> {
  const [rawDevices, rawUsers, postureResult] = await Promise.all([
    fetchDevices(accountId),
    fetchUsers(accountId),
    fetchPostureRules(accountId),
  ]);

  // Build user email → device count map
  const userDeviceCount = new Map<string, number>();

  // Process devices
  const devices: DeviceItem[] = rawDevices.map((d) => {
    const lastSeen = d.last_seen || new Date(0).toISOString();
    const email = d.user?.email || "";
    userDeviceCount.set(email, (userDeviceCount.get(email) || 0) + 1);

    return {
      name: d.name || d.id || "Unknown Device",
      user: d.user?.name || d.user?.email || "Unknown",
      email,
      os: formatOsName(d.device_type, d.os_version),
      osVersion: d.os_version || "",
      warpVersion: d.version || "Unknown",
      lastSeen,
      status: classifyDevice(lastSeen),
    };
  });

  // Process users
  const users: UserItem[] = rawUsers.map((u) => ({
    name: u.name || "Unknown",
    email: u.email || "",
    accessSeat: u.access_seat ?? false,
    gatewaySeat: u.gateway_seat ?? false,
    deviceCount: userDeviceCount.get(u.email || "") || 0,
    lastLogin: u.updated_at || u.created_at || null,
  }));

  // Process posture rules
  const postureRules: PostureRule[] = postureResult.rules.map((r) => ({
    name: r.name || "Unnamed Rule",
    type: r.type || "Unknown",
    description: r.description || "",
  }));

  // Aggregate OS distribution
  const osCounts = new Map<string, number>();
  for (const d of devices) {
    osCounts.set(d.os, (osCounts.get(d.os) || 0) + 1);
  }
  const osDistribution = Array.from(osCounts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Aggregate WARP version distribution
  const warpCounts = new Map<string, number>();
  for (const d of devices) {
    warpCounts.set(d.warpVersion, (warpCounts.get(d.warpVersion) || 0) + 1);
  }
  const warpVersionDistribution = Array.from(warpCounts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  // Stats
  const activeDevices = devices.filter((d) => d.status === "active").length;
  const inactiveDevices = devices.filter((d) => d.status === "inactive").length;
  const staleDevices = devices.filter((d) => d.status === "stale").length;
  const accessSeats = users.filter((u) => u.accessSeat).length;
  const gatewaySeats = users.filter((u) => u.gatewaySeat).length;

  return {
    devices,
    users,
    postureRules,
    postureError: postureResult.error,
    osDistribution,
    warpVersionDistribution,
    stats: {
      totalDevices: devices.length,
      activeDevices,
      inactiveDevices,
      staleDevices,
      totalUsers: users.length,
      accessSeats,
      gatewaySeats,
    },
  };
}
