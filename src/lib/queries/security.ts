import { cfGraphQL, fetchFirewallRuleMap, formatCountry } from "@/lib/use-cf-data";
import { formatSourceLabel } from "@/lib/source-labels";

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
  action: string;
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

interface TrafficTimeSeriesPoint {
  date: string;
  requests: number;
}

interface AttackCategory {
  category: string;
  count: number;
  sources: string[];
}

interface HttpMethodBreakdown {
  method: string;
  count: number;
}

interface RuleEffectiveness {
  ruleId: string;
  ruleName: string | null;
  description: string;
  totalHits: number;
  blocks: number;
  challenges: number;
  logs: number;
  blockRate: number;
}

export interface SecurityData {
  wafTimeSeries: WAFTimeSeriesPoint[];
  trafficTimeSeries: TrafficTimeSeriesPoint[];
  topFirewallRules: FirewallRule[];
  topSkipRules: FirewallRule[];
  sourceBreakdown: SourceBreakdown[];
  botScoreDistribution: BotScoreBucket[];
  challengeSolveRates: ChallengeSolveRates;
  topAttackingIPs: AttackingIP[];
  topAttackingCountries: AttackingCountry[];
  topAttackingASNs: AttackingASN[];
  attackCategories: AttackCategory[];
  httpMethodBreakdown: HttpMethodBreakdown[];
  ruleEffectiveness: RuleEffectiveness[];
}

// --- Main fetch ---
export async function fetchSecurityData(
  zoneTag: string,
  since: string,
  until: string
): Promise<SecurityData> {
  const [
    wafTimeSeries,
    trafficTimeSeries,
    rawBlockRules,
    rawSkipRules,
    sourceBreakdown,
    botScoreDistribution,
    challengeSolveRates,
    topAttackingIPs,
    topAttackingCountries,
    topAttackingASNs,
    ruleNameMap,
    attackClassification,
    ruleEffectivenessRaw,
  ] = await Promise.all([
    fetchWAFTimeSeries(zoneTag, since, until),
    fetchTrafficTimeSeries(zoneTag, since, until),
    fetchTopBlockRules(zoneTag, since, until),
    fetchTopSkipRules(zoneTag, since, until),
    fetchSourceBreakdown(zoneTag, since, until),
    fetchBotScoreDistribution(zoneTag, since, until).catch(() => []),
    fetchChallengeSolveRates(zoneTag, since, until),
    fetchTopAttackingIPs(zoneTag, since, until),
    fetchTopAttackingCountries(zoneTag, since, until),
    fetchTopAttackingASNs(zoneTag, since, until),
    fetchFirewallRuleMap(zoneTag),
    fetchAttackClassification(zoneTag, since, until),
    fetchRuleEffectiveness(zoneTag, since, until),
  ]);

  const enrichRule = (rule: Omit<FirewallRule, "ruleName">) => ({
    ...rule,
    ruleName: ruleNameMap.get(rule.ruleId) || null,
  });

  const ruleEffectiveness = ruleEffectivenessRaw.map((r) => ({
    ...r,
    ruleName: ruleNameMap.get(r.ruleId) || null,
  }));

  return {
    wafTimeSeries,
    trafficTimeSeries,
    topFirewallRules: rawBlockRules.map(enrichRule),
    topSkipRules: rawSkipRules.map(enrichRule),
    sourceBreakdown,
    botScoreDistribution,
    challengeSolveRates,
    topAttackingIPs,
    topAttackingCountries,
    topAttackingASNs,
    attackCategories: attackClassification.categories,
    httpMethodBreakdown: attackClassification.methods,
    ruleEffectiveness,
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

async function fetchTopBlockRules(
  zoneTag: string,
  since: string,
  until: string
): Promise<Omit<FirewallRule, "ruleName">[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action_in: ["block", "challenge", "managed_challenge", "js_challenge"] }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { ruleId description action }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { ruleId: string; description: string; action: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    ruleId: g.dimensions.ruleId || "unknown",
    description: g.dimensions.description || "No description",
    action: g.dimensions.action || "block",
    count: g.count,
  }));
}

async function fetchTopSkipRules(
  zoneTag: string,
  since: string,
  until: string
): Promise<Omit<FirewallRule, "ruleName">[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "skip" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { ruleId description action }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { ruleId: string; description: string; action: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    ruleId: g.dimensions.ruleId || "unknown",
    description: g.dimensions.description || "No description",
    action: g.dimensions.action || "skip",
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
    name: formatSourceLabel(g.dimensions.source || "unknown"),
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
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action_in: ["block", "challenge", "managed_challenge", "js_challenge"] }
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
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action_in: ["block", "challenge", "managed_challenge", "js_challenge"] }
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
    country: formatCountry(g.dimensions.clientCountryName),
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
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action_in: ["block", "challenge", "managed_challenge", "js_challenge"] }
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

// --- S1: Traffic timeline for correlation ---
async function fetchTrafficTimeSeries(
  zoneTag: string,
  since: string,
  until: string
): Promise<TrafficTimeSeriesPoint[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const byHour = new Map<string, number>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    byHour.set(hour, (byHour.get(hour) || 0) + g.count);
  }

  return Array.from(byHour.entries())
    .map(([date, requests]) => ({ date, requests }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- S5: Attack classification ---
const ATTACK_CATEGORIES: Array<{ category: string; patterns: RegExp[] }> = [
  { category: "SQL Injection", patterns: [/sql/i, /sqli/i] },
  { category: "XSS", patterns: [/xss/i, /cross.?site/i, /html injection/i] },
  { category: "Path Traversal", patterns: [/traversal/i, /directory/i, /relative path/i, /multiple slash/i] },
  { category: "CVE Exploits", patterns: [/cve[:-]/i] },
  { category: "Vulnerability Scanning", patterns: [/scanner/i, /probe/i, /vulnerability/i] },
  { category: "Bot / Fake Crawler", patterns: [/fake.*bot/i, /fake.*google/i, /fake.*baidu/i, /fake.*bing/i] },
  { category: "Header Anomalies", patterns: [/anomaly:header/i, /missing or empty/i] },
  { category: "File Inclusion", patterns: [/file inclusion/i, /dangerous file/i] },
  { category: "Command Injection", patterns: [/command injection/i, /rce/i, /code injection/i] },
  { category: "Rate Limiting", patterns: [/rate limit/i] },
  { category: "API Protection", patterns: [/schema validation/i, /api shield/i] },
  { category: "Custom Rules", patterns: [/block unknown/i, /global restriction/i] },
];

function classifyAttack(description: string, source: string): string {
  if (source === "l7ddos") return "L7 DDoS";
  if (source === "ratelimit") return "Rate Limiting";
  if (source === "bic") return "Browser Integrity Check";
  if (source === "apiShieldSchemaValidation") return "API Protection";

  for (const { category, patterns } of ATTACK_CATEGORIES) {
    if (patterns.some((p) => p.test(description))) return category;
  }

  return "Other";
}

async function fetchAttackClassification(
  zoneTag: string,
  since: string,
  until: string
): Promise<{ categories: AttackCategory[]; methods: HttpMethodBreakdown[] }> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        byDescription: firewallEventsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { description source }
        }
        byMethod: firewallEventsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientRequestHTTPMethodName }
        }
      }
    }
  }`;

  interface DescGroup { count: number; dimensions: { description: string; source: string } }
  interface MethodGroup { count: number; dimensions: { clientRequestHTTPMethodName: string } }

  const data = await cfGraphQL<{
    viewer: {
      zones: Array<{
        byDescription: DescGroup[];
        byMethod: MethodGroup[];
      }>;
    };
  }>(query);

  const zone = data.viewer.zones[0];

  // Classify and aggregate
  const categoryMap = new Map<string, { count: number; sources: Set<string> }>();
  for (const g of zone?.byDescription || []) {
    const cat = classifyAttack(g.dimensions.description, g.dimensions.source);
    const existing = categoryMap.get(cat) || { count: 0, sources: new Set<string>() };
    existing.count += g.count;
    existing.sources.add(formatSourceLabel(g.dimensions.source));
    categoryMap.set(cat, existing);
  }

  const categories = Array.from(categoryMap.entries())
    .map(([category, { count, sources }]) => ({
      category,
      count,
      sources: Array.from(sources),
    }))
    .sort((a, b) => b.count - a.count);

  const methods = (zone?.byMethod || []).map((g) => ({
    method: g.dimensions.clientRequestHTTPMethodName || "UNKNOWN",
    count: g.count,
  }));

  return { categories, methods };
}

// --- S2: Rule effectiveness ---
async function fetchRuleEffectiveness(
  zoneTag: string,
  since: string,
  until: string
): Promise<Omit<RuleEffectiveness, "ruleName">[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { ruleId description action }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { ruleId: string; description: string; action: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  // Aggregate per rule across all actions
  const ruleMap = new Map<string, {
    description: string;
    blocks: number;
    challenges: number;
    logs: number;
    skips: number;
    total: number;
  }>();

  for (const g of data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []) {
    const id = g.dimensions.ruleId || "unknown";
    const existing = ruleMap.get(id) || {
      description: g.dimensions.description || "No description",
      blocks: 0, challenges: 0, logs: 0, skips: 0, total: 0,
    };
    existing.total += g.count;
    const action = g.dimensions.action;
    if (action === "block") existing.blocks += g.count;
    else if (action === "challenge" || action === "managed_challenge" || action === "js_challenge") existing.challenges += g.count;
    else if (action === "log") existing.logs += g.count;
    else if (action === "skip") existing.skips += g.count;
    ruleMap.set(id, existing);
  }

  return Array.from(ruleMap.entries())
    .filter(([, v]) => v.blocks + v.challenges > 0) // Only rules that actually block/challenge
    .map(([ruleId, v]) => ({
      ruleId,
      description: v.description,
      totalHits: v.total,
      blocks: v.blocks,
      challenges: v.challenges,
      logs: v.logs,
      blockRate: v.total > 0 ? (v.blocks / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.totalHits - a.totalHits)
    .slice(0, 15);
}
