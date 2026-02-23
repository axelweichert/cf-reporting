import { cfGraphQL, fetchAppNameMap } from "@/lib/use-cf-data";

// --- Types ---
interface LoginTimeSeriesPoint {
  date: string;
  successful: number;
  failed: number;
}

interface RawAccessByApp {
  appId: string;
  count: number;
}

interface AccessByApp {
  appId: string;
  appName: string | null;
  count: number;
}

interface GeoAccess {
  country: string;
  count: number;
}

interface IdentityProviderItem {
  provider: string;
  count: number;
}

export interface AccessAuditData {
  loginsOverTime: LoginTimeSeriesPoint[];
  accessByApplication: AccessByApp[];
  geographicAccess: GeoAccess[];
  identityProviders: IdentityProviderItem[];
  failedLoginCount: number;
}

// --- Main fetch ---
export async function fetchAccessAuditData(
  accountTag: string,
  since: string,
  until: string
): Promise<AccessAuditData> {
  const [loginsOverTime, rawAccessByApp, geographicAccess, identityProviders, failedLoginCount, appNameMap] =
    await Promise.all([
      fetchLoginsOverTime(accountTag, since, until),
      fetchAccessByApplication(accountTag, since, until),
      fetchGeographicAccess(accountTag, since, until),
      fetchIdentityProviders(accountTag, since, until),
      fetchFailedLoginCount(accountTag, since, until),
      fetchAppNameMap(accountTag),
    ]);

  const accessByApplication = rawAccessByApp.map((item) => ({
    ...item,
    appName: appNameMap.get(item.appId) || null,
  }));

  return {
    loginsOverTime,
    accessByApplication,
    geographicAccess,
    identityProviders,
    failedLoginCount,
  };
}

// --- Individual queries ---

async function fetchLoginsOverTime(
  accountTag: string,
  since: string,
  until: string
): Promise<LoginTimeSeriesPoint[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        successful: accessLoginRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 1
          }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date }
        }
        failed: accessLoginRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 0
          }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { date: string };
  }

  const data = await cfGraphQL<{
    viewer: {
      accounts: Array<{
        successful: Group[];
        failed: Group[];
      }>;
    };
  }>(query);

  const account = data.viewer.accounts[0];
  const byDate = new Map<string, LoginTimeSeriesPoint>();

  for (const g of account?.successful || []) {
    const date = g.dimensions.date;
    const existing = byDate.get(date) || { date, successful: 0, failed: 0 };
    existing.successful += g.count;
    byDate.set(date, existing);
  }

  for (const g of account?.failed || []) {
    const date = g.dimensions.date;
    const existing = byDate.get(date) || { date, successful: 0, failed: 0 };
    existing.failed += g.count;
    byDate.set(date, existing);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchAccessByApplication(
  accountTag: string,
  since: string,
  until: string
): Promise<RawAccessByApp[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { appId }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { appId: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    appId: g.dimensions.appId || "unknown",
    count: g.count,
  }));
}

async function fetchGeographicAccess(
  accountTag: string,
  since: string,
  until: string
): Promise<GeoAccess[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { country }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { country: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    country: g.dimensions.country || "Unknown",
    count: g.count,
  }));
}

async function fetchIdentityProviders(
  accountTag: string,
  since: string,
  until: string
): Promise<IdentityProviderItem[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { identityProvider }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { identityProvider: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const byProvider = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []) {
    const provider = g.dimensions.identityProvider || "Unknown";
    byProvider.set(provider, (byProvider.get(provider) || 0) + g.count);
  }

  return Array.from(byProvider.entries())
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count);
}

async function fetchFailedLoginCount(
  accountTag: string,
  since: string,
  until: string
): Promise<number> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 1
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 0
          }
        ) {
          count
        }
      }
    }
  }`;

  interface Group {
    count: number;
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).reduce(
    (sum, g) => sum + g.count,
    0
  );
}
