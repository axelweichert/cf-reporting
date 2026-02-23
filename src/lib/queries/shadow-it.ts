import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---
interface DiscoveredApp {
  name: string;
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
  const top5Apps = discoveredApplications.slice(0, 5).map((a) => a.name);
  const usageTrendsResult = await fetchUsageTrends(accountTag, since, until, top5Apps);

  return {
    discoveredApplications,
    categoryBreakdown,
    usageTrends: usageTrendsResult,
    trendAppNames: top5Apps,
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
          dimensions { matchedApplicationName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { matchedApplicationName: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.matchedApplicationName || "Unknown",
    count: g.count,
  }));
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
          limit: 15
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
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
    dimensions: { categoryNames: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  const byCategory = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const category = g.dimensions.categoryNames || "Uncategorized";
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
  appNames: string[]
): Promise<AppUsageTrend[]> {
  if (appNames.length === 0) {
    return [];
  }

  // Fetch hourly data for each top app in parallel
  const appQueries = appNames.map((appName) => {
    const query = `{
      viewer {
        accounts(filter: { accountTag: "${accountTag}" }) {
          gatewayResolverQueriesAdaptiveGroups(
            limit: 500
            filter: {
              datetime_geq: "${since}"
              datetime_lt: "${until}"
              matchedApplicationName: "${appName}"
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
      appName,
      groups: data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || [],
    }));
  });

  const results = await Promise.all(appQueries);

  // Merge all app data into a single time series
  const byHour = new Map<string, AppUsageTrend>();

  for (const { appName, groups } of results) {
    for (const g of groups) {
      const hour = g.dimensions.datetimeHour;
      const existing = byHour.get(hour) || { date: hour };
      existing[appName] = ((existing[appName] as number) || 0) + g.count;
      byHour.set(hour, existing);
    }
  }

  // Ensure every time point has a value for each app (default to 0)
  const allPoints = Array.from(byHour.values());
  for (const point of allPoints) {
    for (const appName of appNames) {
      if (!(appName in point)) {
        point[appName] = 0;
      }
    }
  }

  return allPoints.sort((a, b) => (a.date as string).localeCompare(b.date as string));
}
