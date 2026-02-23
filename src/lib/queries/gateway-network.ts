import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---
interface L4SessionTimeSeriesPoint {
  date: string;
  allowed: number;
  blocked: number;
}

interface BlockedDestination {
  ip: string;
  count: number;
}

interface SourceCountry {
  country: string;
  count: number;
}

interface TransportProtocol {
  protocol: string;
  count: number;
}

export interface GatewayNetworkData {
  sessionsOverTime: L4SessionTimeSeriesPoint[];
  blockedDestinations: BlockedDestination[];
  topSourceCountries: SourceCountry[];
  transportProtocols: TransportProtocol[];
}

// --- Main fetch ---
export async function fetchGatewayNetworkData(
  accountTag: string,
  since: string,
  until: string
): Promise<GatewayNetworkData> {
  const [sessionsOverTime, blockedDestinations, topSourceCountries, transportProtocols] =
    await Promise.all([
      fetchSessionsOverTime(accountTag, since, until),
      fetchBlockedDestinations(accountTag, since, until),
      fetchTopSourceCountries(accountTag, since, until),
      fetchTransportProtocols(accountTag, since, until),
    ]);

  return {
    sessionsOverTime,
    blockedDestinations,
    topSourceCountries,
    transportProtocols,
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
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            action: "block"
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { destinationIp }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { destinationIp: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []).map((g) => ({
    ip: g.dimensions.destinationIp || "unknown",
    count: g.count,
  }));
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
    .map(([country, count]) => ({ country, count }))
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
    const protocol = g.dimensions.transport || "unknown";
    byProtocol.set(protocol, (byProtocol.get(protocol) || 0) + g.count);
  }

  return Array.from(byProtocol.entries())
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => b.count - a.count);
}
