import { cfGraphQL, fetchAppNameMap, formatCountry } from "@/lib/use-cf-data";

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

interface FailedLoginDetail {
  appId: string;
  appName: string | null;
  country: string;
  identityProvider: string;
  count: number;
}

interface AppBreakdown {
  appId: string;
  appName: string | null;
  successful: number;
  failed: number;
  total: number;
  failureRate: number;
}

export interface Anomaly {
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
}

export interface AccessAuditData {
  loginsOverTime: LoginTimeSeriesPoint[];
  accessByApplication: AccessByApp[];
  appBreakdown: AppBreakdown[];
  geographicAccess: GeoAccess[];
  identityProviders: IdentityProviderItem[];
  failedLoginCount: number;
  failedLoginDetails: FailedLoginDetail[];
  failedByApp: Array<{ appId: string; appName: string | null; count: number }>;
  failedByCountry: Array<{ country: string; count: number }>;
  anomalies: Anomaly[];
}

// --- Main fetch ---
export async function fetchAccessAuditData(
  accountTag: string,
  since: string,
  until: string
): Promise<AccessAuditData> {
  const [loginsOverTime, rawAccessByApp, geographicAccess, identityProviders, failedLoginCount, rawFailedDetails, appNameMap, rawAppBreakdown] =
    await Promise.all([
      fetchLoginsOverTime(accountTag, since, until),
      fetchAccessByApplication(accountTag, since, until),
      fetchGeographicAccess(accountTag, since, until),
      fetchIdentityProviders(accountTag, since, until),
      fetchFailedLoginCount(accountTag, since, until),
      fetchFailedLoginDetails(accountTag, since, until),
      fetchAppNameMap(accountTag),
      fetchPerAppBreakdown(accountTag, since, until),
    ]);

  const accessByApplication = rawAccessByApp.map((item) => ({
    ...item,
    appName: appNameMap.get(item.appId) || null,
  }));

  const failedLoginDetails = rawFailedDetails.map((item) => ({
    ...item,
    appName: appNameMap.get(item.appId) || null,
  }));

  // Per-app success/failure breakdown (A3)
  const appMap = new Map<string, { successful: number; failed: number }>();
  for (const r of rawAppBreakdown) {
    const existing = appMap.get(r.appId) || { successful: 0, failed: 0 };
    if (r.isSuccess) existing.successful += r.count;
    else existing.failed += r.count;
    appMap.set(r.appId, existing);
  }
  const appBreakdown: AppBreakdown[] = Array.from(appMap.entries())
    .map(([appId, stats]) => {
      const total = stats.successful + stats.failed;
      return {
        appId,
        appName: appNameMap.get(appId) || null,
        ...stats,
        total,
        failureRate: total > 0 ? (stats.failed / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.total - a.total);

  // Aggregate failed logins by app
  const failedByAppMap = new Map<string, number>();
  for (const d of failedLoginDetails) {
    failedByAppMap.set(d.appId, (failedByAppMap.get(d.appId) || 0) + d.count);
  }
  const failedByApp = Array.from(failedByAppMap.entries())
    .map(([appId, count]) => ({ appId, appName: appNameMap.get(appId) || null, count }))
    .sort((a, b) => b.count - a.count);

  // Aggregate failed logins by country
  const failedByCountryMap = new Map<string, number>();
  for (const d of failedLoginDetails) {
    failedByCountryMap.set(d.country, (failedByCountryMap.get(d.country) || 0) + d.count);
  }
  const failedByCountry = Array.from(failedByCountryMap.entries())
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count);

  // Anomaly detection (A2)
  const anomalies = detectAnomalies(loginsOverTime, appBreakdown, geographicAccess, failedByCountry, identityProviders);

  return {
    loginsOverTime,
    accessByApplication,
    appBreakdown,
    geographicAccess,
    identityProviders,
    failedLoginCount,
    failedLoginDetails,
    failedByApp,
    failedByCountry,
    anomalies,
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
    country: formatCountry(g.dimensions.country),
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

async function fetchFailedLoginDetails(
  accountTag: string,
  since: string,
  until: string
): Promise<Omit<FailedLoginDetail, "appName">[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 50
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 0
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { appId country identityProvider }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { appId: string; country: string; identityProvider: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    appId: g.dimensions.appId || "unknown",
    country: formatCountry(g.dimensions.country),
    identityProvider: g.dimensions.identityProvider || "Unknown",
    count: g.count,
  }));
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

// A3: Per-app success/failure breakdown
async function fetchPerAppBreakdown(
  accountTag: string,
  since: string,
  until: string
): Promise<Array<{ appId: string; isSuccess: boolean; count: number }>> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { appId isSuccessfulLogin }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { appId: string; isSuccessfulLogin: number };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    appId: g.dimensions.appId || "unknown",
    isSuccess: g.dimensions.isSuccessfulLogin === 1,
    count: g.count,
  }));
}

// A2: Anomaly detection
function detectAnomalies(
  loginTimeSeries: LoginTimeSeriesPoint[],
  appBreakdown: AppBreakdown[],
  geoAccess: GeoAccess[],
  failedByCountry: Array<{ country: string; count: number }>,
  idpBreakdown: IdentityProviderItem[],
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // 1. Apps with high failure rate (>30% and at least 5 failures)
  for (const app of appBreakdown) {
    if (app.failureRate > 50 && app.failed >= 5) {
      anomalies.push({
        severity: "critical",
        title: `High failure rate on ${app.appName || app.appId}`,
        description: `${app.failureRate.toFixed(0)}% of login attempts failed (${app.failed} of ${app.total}). This could indicate a misconfigured identity provider, expired credentials, or a brute-force attack.`,
      });
    } else if (app.failureRate > 30 && app.failed >= 3) {
      anomalies.push({
        severity: "warning",
        title: `Elevated failure rate on ${app.appName || app.appId}`,
        description: `${app.failureRate.toFixed(0)}% of login attempts failed (${app.failed} of ${app.total}).`,
      });
    }
  }

  // 2. Countries with only failed logins (not in successful geo list)
  const successfulCountries = new Set(geoAccess.map((g) => g.country));
  for (const fc of failedByCountry) {
    if (!successfulCountries.has(fc.country) && fc.count >= 2) {
      anomalies.push({
        severity: "warning",
        title: `Suspicious country: ${fc.country}`,
        description: `${fc.count} failed login attempts from ${fc.country} with zero successful logins. This country has no legitimate access in the period.`,
      });
    }
  }

  // 3. Overall failure rate
  const totalSuccess = loginTimeSeries.reduce((s, p) => s + p.successful, 0);
  const totalFailed = loginTimeSeries.reduce((s, p) => s + p.failed, 0);
  const totalAll = totalSuccess + totalFailed;
  if (totalAll > 10 && totalFailed / totalAll > 0.2) {
    anomalies.push({
      severity: totalFailed / totalAll > 0.4 ? "critical" : "warning",
      title: "High overall failure rate",
      description: `${((totalFailed / totalAll) * 100).toFixed(1)}% of all login attempts failed (${totalFailed} of ${totalAll}). Investigate whether this is caused by misconfiguration or unauthorized access attempts.`,
    });
  }

  // 4. Spike detection – days with failed logins > 3× the average
  const failedByDay = loginTimeSeries.filter((p) => p.failed > 0);
  if (failedByDay.length >= 3) {
    const avgFailed = failedByDay.reduce((s, p) => s + p.failed, 0) / failedByDay.length;
    for (const day of failedByDay) {
      if (day.failed > avgFailed * 3 && day.failed >= 5) {
        anomalies.push({
          severity: "warning",
          title: `Failure spike on ${day.date}`,
          description: `${day.failed} failed logins on this day, which is ${(day.failed / avgFailed).toFixed(1)}× the average (${avgFailed.toFixed(0)}).`,
        });
      }
    }
  }

  // 5. Identity provider with disproportionate failures
  // Check if a single IdP accounts for most failures (via failed login details)
  if (idpBreakdown.length > 1) {
    const totalIdpLogins = idpBreakdown.reduce((s, p) => s + p.count, 0);
    for (const idp of idpBreakdown) {
      const share = idp.count / totalIdpLogins;
      if (share < 0.05 && idp.count >= 3) {
        anomalies.push({
          severity: "info",
          title: `Uncommon identity provider: ${idp.provider}`,
          description: `${idp.count} logins via ${idp.provider} (${(share * 100).toFixed(1)}% of total). Verify this provider is expected.`,
        });
      }
    }
  }

  return anomalies;
}
