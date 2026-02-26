import { cfGraphQL, cfRest } from "@/lib/use-cf-data";

// --- Types ---

interface TlsVersionDistribution {
  version: string;
  requests: number;
}

interface HttpProtocolDistribution {
  protocol: string;
  requests: number;
}

interface TlsProtocolMatrix {
  tlsVersion: string;
  httpProtocol: string;
  requests: number;
}

interface CertificateInfo {
  id: string;
  type: string;
  hosts: string[];
  status: string;
  authority: string;
  validityDays: number;
  expiresOn: string | null;
  signatureAlgorithms: string[];
}

interface SslSettings {
  mode: string;
  minTlsVersion: string;
  tls13: string;
  alwaysUseHttps: boolean;
  autoHttpsRewrites: boolean;
  opportunisticEncryption: boolean;
  zeroRtt: boolean;
  http2: boolean;
  http3: boolean;
}

interface EncryptionTimeSeries {
  date: string;
  encryptedRequests: number;
  totalRequests: number;
  encryptedRatio: number;
}

export interface SslData {
  tlsVersions: TlsVersionDistribution[];
  httpProtocols: HttpProtocolDistribution[];
  protocolMatrix: TlsProtocolMatrix[];
  certificates: CertificateInfo[];
  settings: SslSettings;
  encryptionTimeSeries: EncryptionTimeSeries[];
  stats: {
    totalRequests: number;
    encryptedRequests: number;
    encryptedPercent: number;
    tlsv13Percent: number;
    http3Percent: number;
    certCount: number;
  };
}

// --- Main fetch ---

export async function fetchSslData(
  zoneTag: string,
  since: string,
  until: string
): Promise<SslData> {
  const [protocolData, encryptionTs, certificates, settings] = await Promise.all([
    fetchProtocolDistribution(zoneTag, since, until),
    fetchEncryptionTimeSeries(zoneTag, since, until),
    fetchCertificates(zoneTag),
    fetchSslSettings(zoneTag),
  ]);

  const totalRequests = protocolData.matrix.reduce((sum, m) => sum + m.requests, 0);
  const encryptedRequests = protocolData.matrix
    .filter((m) => m.tlsVersion !== "none")
    .reduce((sum, m) => sum + m.requests, 0);
  const tlsv13Requests = protocolData.tlsVersions
    .filter((t) => t.version === "TLSv1.3")
    .reduce((sum, t) => sum + t.requests, 0);
  const http3Requests = protocolData.httpProtocols
    .filter((p) => p.protocol.includes("3"))
    .reduce((sum, p) => sum + p.requests, 0);

  return {
    tlsVersions: protocolData.tlsVersions,
    httpProtocols: protocolData.httpProtocols,
    protocolMatrix: protocolData.matrix,
    certificates,
    settings,
    encryptionTimeSeries: encryptionTs,
    stats: {
      totalRequests,
      encryptedRequests,
      encryptedPercent: totalRequests > 0 ? Math.round((encryptedRequests / totalRequests) * 1000) / 10 : 0,
      tlsv13Percent: totalRequests > 0 ? Math.round((tlsv13Requests / totalRequests) * 1000) / 10 : 0,
      http3Percent: totalRequests > 0 ? Math.round((http3Requests / totalRequests) * 1000) / 10 : 0,
      certCount: certificates.length,
    },
  };
}

// --- Individual queries ---

async function fetchProtocolDistribution(
  zoneTag: string,
  since: string,
  until: string
): Promise<{
  tlsVersions: TlsVersionDistribution[];
  httpProtocols: HttpProtocolDistribution[];
  matrix: TlsProtocolMatrix[];
}> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientSSLProtocol clientRequestHTTPProtocol }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientSSLProtocol: string; clientRequestHTTPProtocol: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];

  // Build matrix
  const matrix: TlsProtocolMatrix[] = groups.map((g) => ({
    tlsVersion: g.dimensions.clientSSLProtocol || "none",
    httpProtocol: g.dimensions.clientRequestHTTPProtocol || "Unknown",
    requests: g.count,
  }));

  // Aggregate TLS versions
  const tlsMap = new Map<string, number>();
  for (const g of groups) {
    const v = g.dimensions.clientSSLProtocol || "none";
    tlsMap.set(v, (tlsMap.get(v) || 0) + g.count);
  }
  const tlsVersions = Array.from(tlsMap.entries())
    .map(([version, requests]) => ({ version, requests }))
    .sort((a, b) => b.requests - a.requests);

  // Aggregate HTTP protocols
  const httpMap = new Map<string, number>();
  for (const g of groups) {
    const p = g.dimensions.clientRequestHTTPProtocol || "Unknown";
    httpMap.set(p, (httpMap.get(p) || 0) + g.count);
  }
  const httpProtocols = Array.from(httpMap.entries())
    .map(([protocol, requests]) => ({ protocol, requests }))
    .sort((a, b) => b.requests - a.requests);

  return { tlsVersions, httpProtocols, matrix };
}

async function fetchEncryptionTimeSeries(
  zoneTag: string,
  since: string,
  until: string
): Promise<EncryptionTimeSeries[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsOverviewAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          sum { requests }
          ratio { encryptedRequests }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    sum: { requests: number };
    ratio: { encryptedRequests: number };
    dimensions: { datetimeHour: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsOverviewAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsOverviewAdaptiveGroups || []).map((g) => {
    const total = g.sum.requests;
    const ratio = g.ratio.encryptedRequests || 0;
    return {
      date: g.dimensions.datetimeHour,
      totalRequests: total,
      encryptedRequests: Math.round(total * ratio),
      encryptedRatio: Math.round(ratio * 1000) / 10,
    };
  });
}

async function fetchCertificates(zoneTag: string): Promise<CertificateInfo[]> {
  try {
    const packs = await cfRest<Array<{
      id: string;
      type: string;
      hosts: string[];
      status: string;
      certificate_authority: string;
      validity_days: number;
      certificates: Array<{
        id: string;
        signature: string;
        expires_on?: string;
      }>;
    }>>(`/zones/${zoneTag}/ssl/certificate_packs`);

    return packs.map((p) => ({
      id: p.id,
      type: p.type || "unknown",
      hosts: p.hosts || [],
      status: p.status || "unknown",
      authority: p.certificate_authority || "unknown",
      validityDays: p.validity_days || 0,
      expiresOn: p.certificates?.[0]?.expires_on || null,
      signatureAlgorithms: [...new Set(p.certificates?.map((c) => c.signature) || [])],
    }));
  } catch {
    return [];
  }
}

async function fetchSslSettings(zoneTag: string): Promise<SslSettings> {
  const settingKeys = [
    "ssl", "min_tls_version", "tls_1_3", "always_use_https",
    "automatic_https_rewrites", "opportunistic_encryption", "0rtt", "http2", "http3",
  ];

  const results = await Promise.allSettled(
    settingKeys.map((key) =>
      cfRest<{ id: string; value: string }>(`/zones/${zoneTag}/settings/${key}`)
    )
  );

  const values: Record<string, string> = {};
  for (let i = 0; i < settingKeys.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      values[settingKeys[i]] = r.value.value;
    }
  }

  return {
    mode: values.ssl || "unknown",
    minTlsVersion: values.min_tls_version || "unknown",
    tls13: values.tls_1_3 || "off",
    alwaysUseHttps: values.always_use_https === "on",
    autoHttpsRewrites: values.automatic_https_rewrites === "on",
    opportunisticEncryption: values.opportunistic_encryption === "on",
    zeroRtt: values["0rtt"] === "on",
    http2: values.http2 === "on",
    http3: values.http3 === "on",
  };
}
