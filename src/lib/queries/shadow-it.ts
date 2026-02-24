import { cfGraphQL } from "@/lib/use-cf-data";

// --- Helpers ---
// matchedApplicationName returns JSON-array strings like '["Amazon Web Services"]'
function parseAppName(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.join(", ");
  } catch { /* not JSON */ }
  return raw;
}

// --- Types ---
interface DiscoveredApp {
  name: string;
  rawName: string; // original value for GraphQL filtering
  category: string;
  count: number;
}

interface CategoryBreakdownItem {
  category: string;
  count: number;
}

interface AppUsageTrend {
  date: string;
  [appName: string]: string | number;
}

export interface ShadowItData {
  discoveredApplications: DiscoveredApp[];
  categoryBreakdown: CategoryBreakdownItem[];
  usageTrends: AppUsageTrend[];
  trendAppNames: string[];
}

// --- Main fetch ---
export async function fetchShadowItData(
  accountTag: string,
  since: string,
  until: string
): Promise<ShadowItData> {
  const [discoveredApplications, categoryBreakdown] = await Promise.all([
    fetchDiscoveredApplications(accountTag, since, until),
    fetchCategoryBreakdown(accountTag, since, until),
  ]);

  // Fetch usage trends for the top 5 discovered apps
  const top5 = discoveredApplications.slice(0, 5);
  const top5DisplayNames = top5.map((a) => a.name);
  const top5RawNames = top5.map((a) => a.rawName);
  const usageTrendsResult = await fetchUsageTrends(accountTag, since, until, top5RawNames, top5DisplayNames);

  return {
    discoveredApplications,
    categoryBreakdown,
    usageTrends: usageTrendsResult,
    trendAppNames: top5DisplayNames,
  };
}

// --- Individual queries ---

async function fetchDiscoveredApplications(
  accountTag: string,
  since: string,
  until: string
): Promise<DiscoveredApp[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 30
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            matchedApplicationName_neq: ""
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { matchedApplicationName categoryNames }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { matchedApplicationName: string; categoryNames: string[] };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  // Multiple groups may exist for the same app (different category combos).
  // Merge them, keeping the most common category.
  const appMap = new Map<string, { rawName: string; count: number; categories: Map<string, number> }>();

  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const raw = g.dimensions.matchedApplicationName;
    const name = parseAppName(raw) || "Unknown";
    const cats = Array.isArray(g.dimensions.categoryNames) && g.dimensions.categoryNames.length > 0
      ? g.dimensions.categoryNames
      : ["Uncategorized"];

    const existing = appMap.get(name) || { rawName: raw, count: 0, categories: new Map() };
    existing.count += g.count;
    const catKey = cats.join(", ");
    existing.categories.set(catKey, (existing.categories.get(catKey) || 0) + g.count);
    appMap.set(name, existing);
  }

  return Array.from(appMap.entries())
    .map(([name, { rawName, count, categories }]) => {
      // Pick the category with the most requests
      let topCategory = "Uncategorized";
      let topCount = 0;
      for (const [cat, c] of categories) {
        if (c > topCount) { topCategory = cat; topCount = c; }
      }
      return { name, rawName, category: topCategory, count };
    })
    .sort((a, b) => b.count - a.count);
}

async function fetchCategoryBreakdown(
  accountTag: string,
  since: string,
  until: string
): Promise<CategoryBreakdownItem[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 50
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            matchedApplicationName: ""
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { categoryNames }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { categoryNames: string[] };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  const byCategory = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const names = g.dimensions.categoryNames;
    const category = Array.isArray(names) && names.length > 0 ? names.join(", ") : "Uncategorized";
    byCategory.set(category, (byCategory.get(category) || 0) + g.count);
  }

  return Array.from(byCategory.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

async function fetchUsageTrends(
  accountTag: string,
  since: string,
  until: string,
  rawNames: string[],
  displayNames: string[]
): Promise<AppUsageTrend[]> {
  if (rawNames.length === 0) {
    return [];
  }

  // Fetch hourly data for each top app in parallel
  const appQueries = rawNames.map((rawName, i) => {
    const escapedName = rawName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const query = `{
      viewer {
        accounts(filter: { accountTag: "${accountTag}" }) {
          gatewayResolverQueriesAdaptiveGroups(
            limit: 500
            filter: {
              datetime_geq: "${since}"
              datetime_lt: "${until}"
              matchedApplicationName: "${escapedName}"
            }
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

    return cfGraphQL<{
      viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
    }>(query).then((data) => ({
      displayName: displayNames[i],
      groups: data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || [],
    }));
  });

  const results = await Promise.all(appQueries);

  // Merge all app data into a single time series
  const byHour = new Map<string, AppUsageTrend>();

  for (const { displayName, groups } of results) {
    for (const g of groups) {
      const hour = g.dimensions.datetimeHour;
      const existing = byHour.get(hour) || { date: hour };
      existing[displayName] = ((existing[displayName] as number) || 0) + g.count;
      byHour.set(hour, existing);
    }
  }

  // Ensure every time point has a value for each app (default to 0)
  const allPoints = Array.from(byHour.values());
  for (const point of allPoints) {
    for (const name of displayNames) {
      if (!(name in point)) {
        point[name] = 0;
      }
    }
  }

  return allPoints.sort((a, b) => (a.date as string).localeCompare(b.date as string));
}
