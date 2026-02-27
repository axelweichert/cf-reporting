export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
  plan: { name: string };
}

export interface TokenVerifyResult {
  id: string;
  status: string;
  not_before?: string;
  expires_on?: string;
}

export interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

export interface GraphQLResponse<T = Record<string, unknown>> {
  data: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export type Permission =
  | "zone_analytics"
  | "firewall"
  | "dns_read"
  | "account_settings"
  | "zero_trust"
  | "access"
  | "gateway";

export interface TokenCapabilities {
  permissions: Permission[];
  accounts: CloudflareAccount[];
  zones: CloudflareZone[];
}

// Lightweight version stored in the session cookie (to avoid exceeding cookie size)
export interface SessionCapabilities {
  permissions: Permission[];
  accountCount: number;
  zoneCount: number;
}

export type TokenType = "user" | "account";

export interface SessionSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

export interface SessionData {
  token?: string;
  tokenType?: TokenType;
  capabilities?: SessionCapabilities;
  tokenSource?: "env" | "browser";
  /** SMTP settings configured via the Settings UI (session-scoped) */
  smtp?: SessionSmtp;
  /** Set to true when the user has authenticated via APP_PASSWORD */
  siteAuthenticated?: boolean;
}
