import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---
interface BlockedByPolicy {
  name: string;
  value: number;
}

interface BlockedCategory {
  name: string;
  value: number;
}

interface AccessLoginSummary {
  total: number;
  successful: number;
}

export interface ZtSummaryData {
  totalDnsQueries: number;
  blockedByPolicy: BlockedByPolicy[];
  topBlockedCategories: BlockedCategory[];
  accessLogins: AccessLoginSummary;
}

// --- Main fetch ---
export async function fetchZtSummaryData(
  accountTag: string,
  since: string,
  until: string
): Promise<ZtSummaryData> {
  const [totalDnsQueries, blockedByPolicy, topBlockedCategories, accessLogins] = await Promise.all([
    fetchTotalDnsQueries(accountTag, since, until),
    fetchBlockedByPolicy(accountTag, since, until),
    fetchTopBlockedCategories(accountTag, since, until),
    fetchAccessLogins(accountTag, since, until),
  ]);

  return {
    totalDnsQueries,
    blockedByPolicy,
    topBlockedCategories,
    accessLogins,
  };
}

// --- Individual queries ---

async function fetchTotalDnsQueries(
  accountTag: string,
  since: string,
  until: string
): Promise<number> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
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
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  const groups = data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || [];
  return groups.reduce((sum, g) => sum + g.count, 0);
}

async function fetchBlockedByPolicy(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedByPolicy[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            resolverDecision: 9
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { policyName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { policyName: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.policyName || "Unknown Policy",
    value: g.count,
  }));
}

async function fetchTopBlockedCategories(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedCategory[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverByCategoryAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            resolverDecision: 9
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { categoryId }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { categoryId: number };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverByCategoryAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverByCategoryAdaptiveGroups || []).map((g) => ({
    name: String(g.dimensions.categoryId),
    value: g.count,
  }));
}

async function fetchAccessLogins(
  accountTag: string,
  since: string,
  until: string
): Promise<AccessLoginSummary> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        total: accessLoginRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
        }
        successful: accessLoginRequestsAdaptiveGroups(
          limit: 1
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 1
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
    viewer: {
      accounts: Array<{
        total: Group[];
        successful: Group[];
      }>;
    };
  }>(query);

  const account = data.viewer.accounts[0];
  const total = (account?.total || []).reduce((sum, g) => sum + g.count, 0);
  const successful = (account?.successful || []).reduce((sum, g) => sum + g.count, 0);

  return { total, successful };
}
