import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---

interface PerformanceTimeSeries {
  date: string;
  avgTtfb: number;
  avgOriginTime: number;
  requests: number;
}

interface ContentTypePerformance {
  contentType: string;
  requests: number;
  avgTtfb: number;
  avgOriginTime: number;
  avgResponseBytes: number;
}

interface CountryPerformance {
  country: string;
  requests: number;
  avgTtfb: number;
  avgOriginTime: number;
}

interface ProtocolDistribution {
  protocol: string;
  requests: number;
}

interface ColoPerformance {
  colo: string;
  city: string;
  country: string;
  requests: number;
  avgTtfb: number;
}

// All 302 Cloudflare edge locations – IATA codes → city + country
// Source: https://speed.cloudflare.com/locations
const COLO_MAP: Record<string, { city: string; country: string }> = {
  AAE: { city: "Annabah", country: "Algeria" },
  ABJ: { city: "Abidjan", country: "Cote d'Ivoire" },
  ABQ: { city: "Albuquerque", country: "United States" },
  ACC: { city: "Accra", country: "Ghana" },
  ADB: { city: "Izmir", country: "Turkey" },
  ADD: { city: "Addis Ababa", country: "Ethiopia" },
  ADL: { city: "Adelaide", country: "Australia" },
  AGR: { city: "Agra", country: "India" },
  AKL: { city: "Auckland", country: "New Zealand" },
  AKX: { city: "Aktyubinsk", country: "Kazakhstan" },
  ALA: { city: "Almaty", country: "Kazakhstan" },
  ALG: { city: "Algiers", country: "Algeria" },
  AMD: { city: "Ahmedabad", country: "India" },
  AMM: { city: "Amman", country: "Jordan" },
  AMS: { city: "Amsterdam", country: "Netherlands" },
  ANC: { city: "Anchorage", country: "United States" },
  ARI: { city: "Arica", country: "Chile" },
  ARN: { city: "Stockholm", country: "Sweden" },
  ARU: { city: "Aracatuba", country: "Brazil" },
  ASK: { city: "Yamoussoukro", country: "Cote d'Ivoire" },
  ASU: { city: "Asuncion", country: "Paraguay" },
  ATH: { city: "Athens", country: "Greece" },
  ATL: { city: "Atlanta", country: "United States" },
  AUS: { city: "Austin", country: "United States" },
  BAH: { city: "Manama", country: "Bahrain" },
  BAQ: { city: "Barranquilla", country: "Colombia" },
  BCN: { city: "Barcelona", country: "Spain" },
  BEG: { city: "Belgrade", country: "Serbia" },
  BEL: { city: "Belem", country: "Brazil" },
  BEY: { city: "Beirut", country: "Lebanon" },
  BGI: { city: "Bridgetown", country: "Barbados" },
  BGR: { city: "Bangor", country: "United States" },
  BGW: { city: "Baghdad", country: "Iraq" },
  BKK: { city: "Bangkok", country: "Thailand" },
  BLR: { city: "Bangalore", country: "India" },
  BNA: { city: "Nashville", country: "United States" },
  BNE: { city: "Brisbane", country: "Australia" },
  BNU: { city: "Blumenau", country: "Brazil" },
  BOD: { city: "Bordeaux", country: "France" },
  BOG: { city: "Bogota", country: "Colombia" },
  BOM: { city: "Mumbai", country: "India" },
  BOS: { city: "Boston", country: "United States" },
  BRU: { city: "Brussels", country: "Belgium" },
  BSB: { city: "Brasilia", country: "Brazil" },
  BSR: { city: "Basrah", country: "Iraq" },
  BTS: { city: "Bratislava", country: "Slovakia" },
  BUD: { city: "Budapest", country: "Hungary" },
  BUF: { city: "Buffalo", country: "United States" },
  BWN: { city: "Bandar Seri Begawan", country: "Brunei" },
  CAI: { city: "Cairo", country: "Egypt" },
  CAW: { city: "Campos Dos Goytacazes", country: "Brazil" },
  CBR: { city: "Canberra", country: "Australia" },
  CCP: { city: "Concepcion", country: "Chile" },
  CCU: { city: "Kolkata", country: "India" },
  CDG: { city: "Paris", country: "France" },
  CEB: { city: "Lapu-Lapu City", country: "Philippines" },
  CFC: { city: "Cacador", country: "Brazil" },
  CGB: { city: "Cuiaba", country: "Brazil" },
  CGK: { city: "Jakarta", country: "Indonesia" },
  CGP: { city: "Chittagong", country: "Bangladesh" },
  CGY: { city: "Cagayan De Oro City", country: "Philippines" },
  CHC: { city: "Christchurch", country: "New Zealand" },
  CJB: { city: "Coimbatore", country: "India" },
  CLE: { city: "Cleveland", country: "United States" },
  CLO: { city: "Cali", country: "Colombia" },
  CLT: { city: "Charlotte", country: "United States" },
  CMB: { city: "Colombo", country: "Sri Lanka" },
  CMH: { city: "Columbus", country: "United States" },
  CNF: { city: "Belo Horizonte", country: "Brazil" },
  CNN: { city: "Mattanur", country: "India" },
  CNX: { city: "Chiang Mai", country: "Thailand" },
  COK: { city: "Cochin", country: "India" },
  COR: { city: "Cordoba", country: "Argentina" },
  CPH: { city: "Copenhagen", country: "Denmark" },
  CPT: { city: "Cape Town", country: "South Africa" },
  CRK: { city: "Angeles City", country: "Philippines" },
  CWB: { city: "Curitiba", country: "Brazil" },
  CZL: { city: "Constantine", country: "Algeria" },
  DAC: { city: "Dhaka", country: "Bangladesh" },
  DAD: { city: "Da Nang", country: "Vietnam" },
  DAR: { city: "Dar es Salaam", country: "Tanzania" },
  DEL: { city: "New Delhi", country: "India" },
  DEN: { city: "Denver", country: "United States" },
  DFW: { city: "Dallas-Fort Worth", country: "United States" },
  DKR: { city: "Dakar", country: "Senegal" },
  DME: { city: "Moscow", country: "Russia" },
  DMM: { city: "Ad Dammam", country: "Saudi Arabia" },
  DOH: { city: "Doha", country: "Qatar" },
  DPS: { city: "Denpasar", country: "Indonesia" },
  DTW: { city: "Detroit", country: "United States" },
  DUB: { city: "Dublin", country: "Ireland" },
  DUR: { city: "Durban", country: "South Africa" },
  DUS: { city: "Dusseldorf", country: "Germany" },
  DXB: { city: "Dubai", country: "United Arab Emirates" },
  EBB: { city: "Kampala", country: "Uganda" },
  EBL: { city: "Arbil", country: "Iraq" },
  EVN: { city: "Yerevan", country: "Armenia" },
  EWR: { city: "Newark", country: "United States" },
  EZE: { city: "Buenos Aires", country: "Argentina" },
  FCO: { city: "Rome", country: "Italy" },
  FIH: { city: "Kinshasa", country: "Democratic Republic of the Congo" },
  FLN: { city: "Florianopolis", country: "Brazil" },
  FOR: { city: "Fortaleza", country: "Brazil" },
  FRA: { city: "Frankfurt", country: "Germany" },
  FRU: { city: "Bishkek", country: "Kyrgyzstan" },
  FSD: { city: "Sioux Falls", country: "United States" },
  FUK: { city: "Fukuoka", country: "Japan" },
  GBE: { city: "Gaborone", country: "Botswana" },
  GDL: { city: "Guadalajara", country: "Mexico" },
  GEO: { city: "Georgetown", country: "Guyana" },
  GIG: { city: "Rio De Janeiro", country: "Brazil" },
  GND: { city: "Saint George's", country: "Grenada" },
  GOT: { city: "Gothenburg", country: "Sweden" },
  GRU: { city: "Sao Paulo", country: "Brazil" },
  GUA: { city: "Guatemala City", country: "Guatemala" },
  GUM: { city: "Hagatna", country: "Guam" },
  GVA: { city: "Geneva", country: "Switzerland" },
  GYD: { city: "Baku", country: "Azerbaijan" },
  GYE: { city: "Guayaquil", country: "Ecuador" },
  GYN: { city: "Goiania", country: "Brazil" },
  HAM: { city: "Hamburg", country: "Germany" },
  HAN: { city: "Hanoi", country: "Vietnam" },
  HBA: { city: "Hobart", country: "Australia" },
  HEL: { city: "Helsinki", country: "Finland" },
  HFA: { city: "Haifa", country: "Israel" },
  HKG: { city: "Hong Kong", country: "Hong Kong" },
  HND: { city: "Tokyo", country: "Japan" },
  HNL: { city: "Honolulu", country: "United States" },
  HRE: { city: "Harare", country: "Zimbabwe" },
  HYD: { city: "Hyderabad", country: "India" },
  IAD: { city: "Dulles", country: "United States" },
  IAH: { city: "Houston", country: "United States" },
  ICN: { city: "Seoul", country: "South Korea" },
  IND: { city: "Indianapolis", country: "United States" },
  ISB: { city: "Islamabad", country: "Pakistan" },
  IST: { city: "Istanbul", country: "Turkey" },
  ISU: { city: "Sulaymaniyah", country: "Iraq" },
  IXC: { city: "Chandigarh", country: "India" },
  JAX: { city: "Jacksonville", country: "United States" },
  JDO: { city: "Juazeiro Do Norte", country: "Brazil" },
  JED: { city: "Jeddah", country: "Saudi Arabia" },
  JHB: { city: "Senai", country: "Malaysia" },
  JIB: { city: "Djibouti City", country: "Djibouti" },
  JNB: { city: "Johannesburg", country: "South Africa" },
  JOG: { city: "Yogyakarta", country: "Indonesia" },
  JOI: { city: "Joinville", country: "Brazil" },
  KBP: { city: "Kiev", country: "Ukraine" },
  KCH: { city: "Kuching", country: "Malaysia" },
  KEF: { city: "Reykjavik", country: "Iceland" },
  KGL: { city: "Kigali", country: "Rwanda" },
  KHH: { city: "Kaohsiung City", country: "Taiwan" },
  KHI: { city: "Karachi", country: "Pakistan" },
  KIN: { city: "Kingston", country: "Jamaica" },
  KIX: { city: "Osaka", country: "Japan" },
  KJA: { city: "Krasnoyarsk", country: "Russia" },
  KNU: { city: "Kanpur", country: "India" },
  KTM: { city: "Kathmandu", country: "Nepal" },
  KUL: { city: "Kuala Lumpur", country: "Malaysia" },
  KWI: { city: "Kuwait City", country: "Kuwait" },
  LAD: { city: "Luanda", country: "Angola" },
  LAS: { city: "Las Vegas", country: "United States" },
  LAX: { city: "Los Angeles", country: "United States" },
  LCA: { city: "Larnaca", country: "Cyprus" },
  LED: { city: "St. Petersburg", country: "Russia" },
  LHE: { city: "Lahore", country: "Pakistan" },
  LHR: { city: "London", country: "United Kingdom" },
  LIM: { city: "Lima", country: "Peru" },
  LIS: { city: "Lisbon", country: "Portugal" },
  LLK: { city: "Lankaran", country: "Azerbaijan" },
  LLW: { city: "Lilongwe", country: "Malawi" },
  LOS: { city: "Lagos", country: "Nigeria" },
  LPB: { city: "La Paz", country: "Bolivia" },
  LUN: { city: "Lusaka", country: "Zambia" },
  LUX: { city: "Luxembourg", country: "Luxembourg" },
  LYS: { city: "Lyon", country: "France" },
  MAA: { city: "Chennai", country: "India" },
  MAD: { city: "Madrid", country: "Spain" },
  MAN: { city: "Manchester", country: "United Kingdom" },
  MAO: { city: "Manaus", country: "Brazil" },
  MBA: { city: "Mombasa", country: "Kenya" },
  MCI: { city: "Kansas City", country: "United States" },
  MCT: { city: "Muscat", country: "Oman" },
  MDE: { city: "Rionegro", country: "Colombia" },
  MEL: { city: "Melbourne", country: "Australia" },
  MEM: { city: "Memphis", country: "United States" },
  MEX: { city: "Mexico City", country: "Mexico" },
  MFM: { city: "Taipa", country: "Macau" },
  MIA: { city: "Miami", country: "United States" },
  MLA: { city: "Luqa", country: "Malta" },
  MLE: { city: "Male", country: "Maldives" },
  MLG: { city: "Malang", country: "Indonesia" },
  MNL: { city: "Manila", country: "Philippines" },
  MPM: { city: "Maputo", country: "Mozambique" },
  MRS: { city: "Marseille", country: "France" },
  MRU: { city: "Port Louis", country: "Mauritius" },
  MSP: { city: "Minneapolis", country: "United States" },
  MSQ: { city: "Minsk", country: "Belarus" },
  MUC: { city: "Munich", country: "Germany" },
  MXP: { city: "Milan", country: "Italy" },
  NAG: { city: "Nagpur", country: "India" },
  NBO: { city: "Nairobi", country: "Kenya" },
  NJF: { city: "Najaf", country: "Iraq" },
  NOU: { city: "Noumea", country: "New Caledonia" },
  NQN: { city: "Neuquen", country: "Argentina" },
  NQZ: { city: "Astana", country: "Kazakhstan" },
  NRT: { city: "Tokyo", country: "Japan" },
  NVT: { city: "Navegantes", country: "Brazil" },
  OKA: { city: "Naha", country: "Japan" },
  OKC: { city: "Oklahoma City", country: "United States" },
  OMA: { city: "Omaha", country: "United States" },
  ORD: { city: "Chicago", country: "United States" },
  ORF: { city: "Norfolk", country: "United States" },
  ORN: { city: "Oran", country: "Algeria" },
  OSL: { city: "Oslo", country: "Norway" },
  OTP: { city: "Bucharest", country: "Romania" },
  OUA: { city: "Ouagadougou", country: "Burkina Faso" },
  PAT: { city: "Patna", country: "India" },
  PBH: { city: "Paro", country: "Bhutan" },
  PBM: { city: "Zandery", country: "Suriname" },
  PDX: { city: "Portland", country: "United States" },
  PER: { city: "Perth", country: "Australia" },
  PHL: { city: "Philadelphia", country: "United States" },
  PHX: { city: "Phoenix", country: "United States" },
  PIT: { city: "Pittsburgh", country: "United States" },
  PMO: { city: "Palermo", country: "Italy" },
  PMW: { city: "Palmas", country: "Brazil" },
  PNH: { city: "Phnom Penh", country: "Cambodia" },
  POA: { city: "Porto Alegre", country: "Brazil" },
  POS: { city: "Port of Spain", country: "Trinidad and Tobago" },
  PPT: { city: "Papeete", country: "French Polynesia" },
  PRG: { city: "Prague", country: "Czech Republic" },
  PTY: { city: "Tocumen", country: "Panama" },
  QRO: { city: "Queretaro", country: "Mexico" },
  QWJ: { city: "Americana", country: "Brazil" },
  RAO: { city: "Ribeirao Preto", country: "Brazil" },
  RDU: { city: "Raleigh/Durham", country: "United States" },
  REC: { city: "Recife", country: "Brazil" },
  RIC: { city: "Richmond", country: "United States" },
  RIX: { city: "Riga", country: "Latvia" },
  RUH: { city: "Riyadh", country: "Saudi Arabia" },
  RUN: { city: "St Denis", country: "Reunion" },
  SAN: { city: "San Diego", country: "United States" },
  SAP: { city: "La Mesa", country: "Honduras" },
  SAT: { city: "San Antonio", country: "United States" },
  SCL: { city: "Santiago", country: "Chile" },
  SDQ: { city: "Santo Domingo", country: "Dominican Republic" },
  SEA: { city: "Seattle", country: "United States" },
  SFO: { city: "San Francisco", country: "United States" },
  SGN: { city: "Ho Chi Minh City", country: "Vietnam" },
  SIN: { city: "Singapore", country: "Singapore" },
  SJC: { city: "San Jose", country: "United States" },
  SJK: { city: "Sao Jose Dos Campos", country: "Brazil" },
  SJO: { city: "San Jose", country: "Costa Rica" },
  SJP: { city: "Sao Jose Do Rio Preto", country: "Brazil" },
  SJU: { city: "San Juan", country: "Puerto Rico" },
  SKG: { city: "Thessaloniki", country: "Greece" },
  SKP: { city: "Skopje", country: "North Macedonia" },
  SLC: { city: "Salt Lake City", country: "United States" },
  SMF: { city: "Sacramento", country: "United States" },
  SOD: { city: "Sorocaba", country: "Brazil" },
  SOF: { city: "Sofia", country: "Bulgaria" },
  SSA: { city: "Salvador", country: "Brazil" },
  STI: { city: "Santiago", country: "Dominican Republic" },
  STL: { city: "St Louis", country: "United States" },
  STR: { city: "Stuttgart", country: "Germany" },
  SUV: { city: "Nausori", country: "Fiji" },
  SYD: { city: "Sydney", country: "Australia" },
  TBS: { city: "Tbilisi", country: "Georgia" },
  TGU: { city: "Tegucigalpa", country: "Honduras" },
  TIA: { city: "Tirana", country: "Albania" },
  TLH: { city: "Tallahassee", country: "United States" },
  TLL: { city: "Tallinn", country: "Estonia" },
  TLV: { city: "Tel Aviv", country: "Israel" },
  TNR: { city: "Antananarivo", country: "Madagascar" },
  TPA: { city: "Tampa", country: "United States" },
  TPE: { city: "Taipei", country: "Taiwan" },
  TUN: { city: "Tunis", country: "Tunisia" },
  TXL: { city: "Berlin", country: "Germany" },
  UDI: { city: "Uberlandia", country: "Brazil" },
  UIO: { city: "Quito", country: "Ecuador" },
  ULN: { city: "Ulan Bator", country: "Mongolia" },
  URT: { city: "Surat Thani", country: "Thailand" },
  VCP: { city: "Campinas", country: "Brazil" },
  VIE: { city: "Vienna", country: "Austria" },
  VIX: { city: "Vitoria", country: "Brazil" },
  VNO: { city: "Vilnius", country: "Lithuania" },
  VTE: { city: "Vientiane", country: "Laos" },
  WAW: { city: "Warsaw", country: "Poland" },
  WDH: { city: "Windhoek", country: "Namibia" },
  WRO: { city: "Wroclaw", country: "Poland" },
  XAP: { city: "Chapeco", country: "Brazil" },
  XNH: { city: "Nasiriyah", country: "Iraq" },
  YHZ: { city: "Halifax", country: "Canada" },
  YOW: { city: "Ottawa", country: "Canada" },
  YUL: { city: "Montreal", country: "Canada" },
  YVR: { city: "Vancouver", country: "Canada" },
  YWG: { city: "Winnipeg", country: "Canada" },
  YXE: { city: "Saskatoon", country: "Canada" },
  YYC: { city: "Calgary", country: "Canada" },
  YYZ: { city: "Toronto", country: "Canada" },
  ZAG: { city: "Zagreb", country: "Croatia" },
  ZDM: { city: "Ramallah", country: "Palestine" },
  ZRH: { city: "Zurich", country: "Switzerland" },
};

function resolveColoCode(code: string): { city: string; country: string } {
  return COLO_MAP[code] || { city: code, country: "Unknown" };
}

export interface PerformanceData {
  timeSeries: PerformanceTimeSeries[];
  contentTypePerf: ContentTypePerformance[];
  countryPerf: CountryPerformance[];
  protocolDistribution: ProtocolDistribution[];
  coloPerf: ColoPerformance[];
  stats: {
    totalRequests: number;
    avgTtfb: number;
    p95Ttfb: number;
    avgOriginTime: number;
    p95OriginTime: number;
    totalBytes: number;
  };
}

// --- Main fetch ---

export async function fetchPerformanceData(
  zoneTag: string,
  since: string,
  until: string
): Promise<PerformanceData> {
  const [overview, byContentType, byCountry, byProtocol, byColo] = await Promise.all([
    fetchOverview(zoneTag, since, until),
    fetchByContentType(zoneTag, since, until),
    fetchByCountry(zoneTag, since, until),
    fetchByProtocol(zoneTag, since, until),
    fetchByColo(zoneTag, since, until),
  ]);

  return {
    timeSeries: overview.timeSeries,
    contentTypePerf: byContentType,
    countryPerf: byCountry,
    protocolDistribution: byProtocol,
    coloPerf: byColo,
    stats: overview.stats,
  };
}

// --- Individual queries ---

async function fetchOverview(
  zoneTag: string,
  since: string,
  until: string
): Promise<{ timeSeries: PerformanceTimeSeries[]; stats: PerformanceData["stats"] }> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        total: httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          quantiles { edgeTimeToFirstByteMsP95 originResponseDurationMsP95 }
          sum { edgeResponseBytes }
        }
        timeSeries: httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface TotalGroup {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    quantiles: { edgeTimeToFirstByteMsP95: number; originResponseDurationMsP95: number };
    sum: { edgeResponseBytes: number };
  }

  interface TimeGroup {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    dimensions: { datetimeHour: string };
  }

  const data = await cfGraphQL<{
    viewer: {
      zones: Array<{
        total: TotalGroup[];
        timeSeries: TimeGroup[];
      }>;
    };
  }>(query);

  const zone = data.viewer.zones[0];
  const t = zone?.total[0];

  const timeSeries: PerformanceTimeSeries[] = (zone?.timeSeries || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
    avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
    requests: g.count,
  }));

  return {
    timeSeries,
    stats: {
      totalRequests: t?.count || 0,
      avgTtfb: Math.round(t?.avg.edgeTimeToFirstByteMs || 0),
      p95Ttfb: Math.round(t?.quantiles.edgeTimeToFirstByteMsP95 || 0),
      avgOriginTime: Math.round(t?.avg.originResponseDurationMs || 0),
      p95OriginTime: Math.round(t?.quantiles.originResponseDurationMsP95 || 0),
      totalBytes: t?.sum.edgeResponseBytes || 0,
    },
  };
}

async function fetchByContentType(
  zoneTag: string,
  since: string,
  until: string
): Promise<ContentTypePerformance[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          sum { edgeResponseBytes }
          dimensions { edgeResponseContentTypeName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    sum: { edgeResponseBytes: number };
    dimensions: { edgeResponseContentTypeName: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.edgeResponseContentTypeName)
    .map((g) => ({
      contentType: g.dimensions.edgeResponseContentTypeName || "Unknown",
      requests: g.count,
      avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
      avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
      avgResponseBytes: g.count > 0 ? Math.round(g.sum.edgeResponseBytes / g.count) : 0,
    }))
    .slice(0, 15);
}

async function fetchByCountry(
  zoneTag: string,
  since: string,
  until: string
): Promise<CountryPerformance[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          dimensions { clientCountryName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    dimensions: { clientCountryName: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.clientCountryName)
    .map((g) => {
      const code = g.dimensions.clientCountryName;
      let name = code;
      try {
        const resolved = countryNames.of(code);
        if (resolved && resolved !== code) name = resolved;
      } catch { /* ignore */ }

      return {
        country: `${name} (${code})`,
        requests: g.count,
        avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
        avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
      };
    })
    .slice(0, 10);
}

async function fetchByProtocol(
  zoneTag: string,
  since: string,
  until: string
): Promise<ProtocolDistribution[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientRequestHTTPProtocol }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientRequestHTTPProtocol: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    protocol: g.dimensions.clientRequestHTTPProtocol || "Unknown",
    requests: g.count,
  }));
}

async function fetchByColo(
  zoneTag: string,
  since: string,
  until: string
): Promise<ColoPerformance[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { edgeTimeToFirstByteMs }
          dimensions { coloCode }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    avg: { edgeTimeToFirstByteMs: number };
    dimensions: { coloCode: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.coloCode)
    .map((g) => {
      const code = g.dimensions.coloCode;
      const info = resolveColoCode(code);
      return {
        colo: `${info.city} (${code})`,
        city: info.city,
        country: info.country,
        requests: g.count,
        avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
      };
    })
    .slice(0, 15);
}
