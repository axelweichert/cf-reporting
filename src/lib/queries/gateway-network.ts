import { cfGraphQL, formatCountry } from "@/lib/use-cf-data";

// --- Types ---
interface L4SessionTimeSeriesPoint {
  date: string;
  allowed: number;
  blocked: number;
}

interface BlockedDestination {
  ip: string;
  count: number;
  country: string;
  port: number | null;
  protocol: string;
}

interface SourceCountry {
  country: string;
  count: number;
}

interface TransportProtocol {
  protocol: string;
  count: number;
}

interface PortServiceItem {
  port: number;
  service: string;
  count: number;
}

export interface GatewayNetworkData {
  sessionsOverTime: L4SessionTimeSeriesPoint[];
  blockedDestinations: BlockedDestination[];
  topSourceCountries: SourceCountry[];
  transportProtocols: TransportProtocol[];
  portBreakdown: PortServiceItem[];
}

// --- Transport protocol mapping ---
const TRANSPORT_NAMES: Record<string, string> = {
  "0": "TCP",
  "1": "ICMP",
  "2": "UDP",
  "6": "TCP",
  "17": "UDP",
};

// --- Main fetch ---
export async function fetchGatewayNetworkData(
  accountTag: string,
  since: string,
  until: string
): Promise<GatewayNetworkData> {
  const [sessionsOverTime, blockedDestinations, topSourceCountries, transportProtocols, portBreakdown] =
    await Promise.all([
      fetchSessionsOverTime(accountTag, since, until),
      fetchBlockedDestinations(accountTag, since, until),
      fetchTopSourceCountries(accountTag, since, until),
      fetchTransportProtocols(accountTag, since, until),
      fetchPortBreakdown(accountTag, since, until),
    ]);

  return {
    sessionsOverTime,
    blockedDestinations,
    topSourceCountries,
    transportProtocols,
    portBreakdown,
  };
}

// --- Individual queries ---

async function fetchSessionsOverTime(
  accountTag: string,
  since: string,
  until: string
): Promise<L4SessionTimeSeriesPoint[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour action }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string; action: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(query);

  const byHour = new Map<string, L4SessionTimeSeriesPoint>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const existing = byHour.get(hour) || { date: hour, allowed: 0, blocked: 0 };

    if (g.dimensions.action === "block") {
      existing.blocked += g.count;
    } else {
      existing.allowed += g.count;
    }

    byHour.set(hour, existing);
  }

  return Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchBlockedDestinations(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedDestination[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 20
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            action: "block"
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { destinationIp dstIpCountry destinationPort transport }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { destinationIp: string; dstIpCountry: string; destinationPort: number; transport: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(query);

  // Aggregate by IP, keeping the most common port/protocol/country
  const byIp = new Map<string, { count: number; country: string; port: number | null; protocol: string }>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const ip = g.dimensions.destinationIp || "unknown";
    const existing = byIp.get(ip);
    if (!existing || g.count > existing.count) {
      const raw = g.dimensions.transport != null ? String(g.dimensions.transport) : "";
      byIp.set(ip, {
        count: (existing?.count || 0) + g.count,
        country: formatCountry(g.dimensions.dstIpCountry || ""),
        port: g.dimensions.destinationPort || null,
        protocol: TRANSPORT_NAMES[raw] || raw || "unknown",
      });
    } else {
      existing.count += g.count;
    }
  }

  return Array.from(byIp.entries())
    .map(([ip, data]) => ({ ip, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function fetchTopSourceCountries(
  accountTag: string,
  since: string,
  until: string
): Promise<SourceCountry[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { srcIpCountry }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { srcIpCountry: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(query);

  const byCountry = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const country = g.dimensions.srcIpCountry || "Unknown";
    byCountry.set(country, (byCountry.get(country) || 0) + g.count);
  }

  return Array.from(byCountry.entries())
    .map(([country, count]) => ({ country: formatCountry(country), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function fetchTransportProtocols(
  accountTag: string,
  since: string,
  until: string
): Promise<TransportProtocol[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { transport }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { transport: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(query);

  const byProtocol = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const raw = g.dimensions.transport != null ? String(g.dimensions.transport) : "unknown";
    const protocol = TRANSPORT_NAMES[raw] || raw;
    byProtocol.set(protocol, (byProtocol.get(protocol) || 0) + g.count);
  }

  return Array.from(byProtocol.entries())
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => b.count - a.count);
}

// Well-known port → service name mapping
const PORT_SERVICES: Record<number, string> = {
  22: "SSH", 25: "SMTP", 53: "DNS", 80: "HTTP", 110: "POP3",
  143: "IMAP", 443: "HTTPS", 445: "SMB", 993: "IMAPS", 995: "POP3S",
  1433: "MSSQL", 1521: "Oracle", 3306: "MySQL", 3389: "RDP",
  5432: "PostgreSQL", 5900: "VNC", 6379: "Redis", 8080: "HTTP-Alt",
  8443: "HTTPS-Alt", 27017: "MongoDB",
};

async function fetchPortBreakdown(
  accountTag: string,
  since: string,
  until: string
): Promise<PortServiceItem[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 30
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { destinationPort }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { destinationPort: number };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(query);

  const byPort = new Map<number, number>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const port = g.dimensions.destinationPort;
    if (port != null) {
      byPort.set(port, (byPort.get(port) || 0) + g.count);
    }
  }

  return Array.from(byPort.entries())
    .map(([port, count]) => ({
      port,
      service: PORT_SERVICES[port] || (port < 1024 ? "System" : "Custom"),
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}
