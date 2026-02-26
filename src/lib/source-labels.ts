/** Maps Cloudflare firewall event source identifiers to human-readable labels */
const SOURCE_LABELS: Record<string, string> = {
  firewallManaged: "Managed WAF Rules",
  firewallCustom: "Custom WAF Rules",
  ratelimit: "Rate Limiting",
  l7ddos: "L7 DDoS Mitigation",
  bic: "Browser Integrity Check",
  hot: "Hotlink Protection",
  securitylevel: "Security Level",
  validation: "Validation",
  apiShieldSchemaValidation: "API Shield",
  apiShieldTokenValidation: "API Shield Token",
  apiShieldSequenceMitigation: "API Shield Sequence",
  dlp: "Data Loss Prevention",
  firewallRules: "Firewall Rules (Legacy)",
  waf: "WAF (Legacy)",
  uaBlock: "User Agent Block",
  zoneLockdown: "Zone Lockdown",
  accessRules: "IP Access Rules",
  managedChallenge: "Managed Challenge",
  botManagement: "Bot Management",
  botFight: "Bot Fight Mode",
  sanitycheck: "Sanity Check",
  unknown: "Unknown",
};

export function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}
