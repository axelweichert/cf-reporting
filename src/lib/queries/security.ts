import { cfGraphQL, fetchFirewallRuleMap } from "@/lib/use-cf-data";

// --- Types ---
interface WAFTimeSeriesPoint {
  date: string;
  block: number;
  challenge: number;
  managed_challenge: number;
  js_challenge: number;
  log: number;
}

interface FirewallRule {
  ruleId: string;
  ruleName: string | null;
  description: string;
  count: number;
}

interface SourceBreakdown {
  name: string;
  value: number;
}

interface BotScoreBucket {
  range: string;
  count: number;
}

interface ChallengeSolveRates {
  challenged: number;
  solved: number;
  failed: number;
}

interface AttackingIP {
  ip: string;
  count: number;
}

interface AttackingCountry {
  country: string;
  count: number;
}

interface AttackingASN {
  asn: number;
  description: string;
  count: number;
}

export interface SecurityData {
  wafTimeSeries: WAFTimeSeriesPoint[];
  topFirewallRules: FirewallRule[];
  sourceBreakdown: SourceBreakdown[];
  botScoreDistribution: BotScoreBucket[];
  challengeSolveRates: ChallengeSolveRates;
  topAttackingIPs: AttackingIP[];
  topAttackingCountries: AttackingCountry[];
  topAttackingASNs: AttackingASN[];
}

// --- Main fetch ---
export async function fetchSecurityData(
  zoneTag: string,
  since: string,
  until: string
): Promise<SecurityData> {
  const [
    wafTimeSeries,
    rawFirewallRules,
    sourceBreakdown,
    botScoreDistribution,
    challengeSolveRates,
    topAttackingIPs,
    topAttackingCountries,
    topAttackingASNs,
    ruleNameMap,
  ] = await Promise.all([
    fetchWAFTimeSeries(zoneTag, since, until),
    fetchTopFirewallRules(zoneTag, since, until),
    fetchSourceBreakdown(zoneTag, since, until),
    fetchBotScoreDistribution(zoneTag, since, until).catch(() => []),
    fetchChallengeSolveRates(zoneTag, since, until),
    fetchTopAttackingIPs(zoneTag, since, until),
    fetchTopAttackingCountries(zoneTag, since, until),
    fetchTopAttackingASNs(zoneTag, since, until),
    fetchFirewallRuleMap(zoneTag),
  ]);

  const topFirewallRules = rawFirewallRules.map((rule) => ({
    ...rule,
    ruleName: ruleNameMap.get(rule.ruleId) || null,
  }));

  return {
    wafTimeSeries,
    topFirewallRules,
    sourceBreakdown,
    botScoreDistribution,
    challengeSolveRates,
    topAttackingIPs,
    topAttackingCountries,
    topAttackingASNs,
  };
}

// --- Individual queries ---

async function fetchWAFTimeSeries(
  zoneTag: string,
  since: string,
  until: string
): Promise<WAFTimeSeriesPoint[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
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
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  const byHour = new Map<string, WAFTimeSeriesPoint>();
  for (const g of data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const existing = byHour.get(hour) || {
      date: hour,
      block: 0,
      challenge: 0,
      managed_challenge: 0,
      js_challenge: 0,
      log: 0,
    };

    const action = g.dimensions.action;
    if (action === "block") {
      existing.block += g.count;
    } else if (action === "challenge") {
      existing.challenge += g.count;
    } else if (action === "managed_challenge") {
      existing.managed_challenge += g.count;
    } else if (action === "js_challenge") {
      existing.js_challenge += g.count;
    } else if (action === "log") {
      existing.log += g.count;
    }

    byHour.set(hour, existing);
  }

  return Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTopFirewallRules(
  zoneTag: string,
  since: string,
  until: string
): Promise<Omit<FirewallRule, "ruleName">[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { ruleId description }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { ruleId: string; description: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    ruleId: g.dimensions.ruleId || "unknown",
    description: g.dimensions.description || "No description",
    count: g.count,
  }));
}

async function fetchSourceBreakdown(
  zoneTag: string,
  since: string,
  until: string
): Promise<SourceBreakdown[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { source }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { source: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.source || "unknown",
    value: g.count,
  }));
}

async function fetchBotScoreDistribution(
  zoneTag: string,
  since: string,
  until: string
): Promise<BotScoreBucket[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { botScoreBucketBy10 }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { botScoreBucketBy10: number };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const bucketMap = new Map<number, number>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const bucket = g.dimensions.botScoreBucketBy10;
    bucketMap.set(bucket, (bucketMap.get(bucket) || 0) + g.count);
  }

  return Array.from(bucketMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, count]) => {
      const low = bucket;
      const high = Math.min(bucket + 9, 99);
      return { range: `${low}-${high}`, count };
    });
}

async function fetchChallengeSolveRates(
  zoneTag: string,
  since: string,
  until: string
): Promise<ChallengeSolveRates> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 100
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            action_in: ["challenge", "managed_challenge", "js_challenge"]
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { action }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { action: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  let challenged = 0;
  for (const g of data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []) {
    challenged += g.count;
  }

  // Fetch solved challenges separately (action = allow after challenge)
  const solvedQuery = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 100
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            action: "challenge_solved"
          }
        ) {
          count
        }
      }
    }
  }`;

  interface SolvedGroup {
    count: number;
  }

  const solvedData = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: SolvedGroup[] }> };
  }>(solvedQuery);

  let solved = 0;
  for (const g of solvedData.viewer.zones[0]?.firewallEventsAdaptiveGroups || []) {
    solved += g.count;
  }

  return {
    challenged,
    solved,
    failed: challenged > solved ? challenged - solved : 0,
  };
}

async function fetchTopAttackingIPs(
  zoneTag: string,
  since: string,
  until: string
): Promise<AttackingIP[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientIP }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientIP: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    ip: g.dimensions.clientIP || "unknown",
    count: g.count,
  }));
}

async function fetchTopAttackingCountries(
  zoneTag: string,
  since: string,
  until: string
): Promise<AttackingCountry[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientCountryName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientCountryName: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    country: g.dimensions.clientCountryName || "Unknown",
    count: g.count,
  }));
}

async function fetchTopAttackingASNs(
  zoneTag: string,
  since: string,
  until: string
): Promise<AttackingASN[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientAsn clientASNDescription }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientAsn: number; clientASNDescription: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    asn: g.dimensions.clientAsn,
    description: g.dimensions.clientASNDescription || "Unknown",
    count: g.count,
  }));
}
