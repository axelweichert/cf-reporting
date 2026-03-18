# Contract Usage / License Tracking

## Status: APPROVED

## Context

Cloudflare enterprise customers receive contracts with committed usage amounts for various products (CDN data transfer in TB, requests in millions, Workers invocations, R2 storage, etc.). Exceeding these commitments triggers overage billing at higher rates.

There is no native Cloudflare dashboard view that compares actual usage against contract entitlements. Customers must manually check analytics and compare to their Order Form. This feature fills that gap using data already collected by cf-reporting's existing collector infrastructure.

**Important**: Cloudflare explicitly states that GraphQL analytics should not be used as a measure for billing purposes. This tool provides usage *estimates* for proactive monitoring, not exact billing data.

## Decision

### Data Model (SQLite migration v11)

Three new tables:

1. **`contract_line_items`** – User-configured contract entitlements. Each row maps a `product_key` (e.g., `cdn-data-transfer`) to a committed amount, unit, category, and per-item warning threshold (default 80%).

2. **`contract_usage_monthly`** – Permanent historical record of calculated usage per line item per month (YYYY-MM). Each row snapshots both `usage_value` and `committed_amount` at calculation time, so historical comparisons remain accurate even if the user changes commitments later.

3. **`contract_usage_alerts`** – Tracks which alert emails have been sent per line item per period, with UNIQUE constraint to prevent duplicates.

### Product Catalog

A hardcoded catalog of ~24 known Cloudflare product keys with:
- Default display name, category, unit, description
- Data source mapping (which raw tables/metrics to query)
- Calculator function for deriving monthly usage from raw data
- Probe dataset key for auto-detection

Products map to **existing raw data** already collected by the data lake collector:
- Zone-scoped: `raw_http_hourly` (CDN/WAF/Bot/RL requests + bandwidth), `raw_dns_hourly` (DNS queries), `dns_records` (record counts)
- Account-scoped: `raw_ext_ts`/`raw_ext_dim` for Workers, R2, KV, Images, Zaraz, Stream, Gateway DNS
- Count-based: Zone discovery for domain counts, SSL certificate snapshots for ACM

### Auto-Detection

A "Detect available products" function probes **local SQLite** (not the CF API) for datasets with recent data, cross-references with the product catalog, and pre-suggests matching products. Users can add/remove suggestions and must enter committed amounts for all.

### Usage Calculation Engine

After each collector cycle, a calculation engine:
1. For each enabled line item, calls its calculator function
2. Stores results in `contract_usage_monthly` via INSERT OR REPLACE
3. Checks for threshold crossings and sends alert emails for new crossings

Recalculation rules:
- Current month: recalculated every collector run
- Past months: immutable unless explicitly recalculated by operator
- Commitment changes: only affect current + future months

### Report Type

New `"contract-usage"` report type added to `ReportType` union, `VALID_REPORT_TYPES`, and `REPORT_LABELS`. This report is cross-scope (all zones + accounts) and doesn't use zone/account selectors.

### UI

- New "License" sidebar group with "Contract Usage" page
- Report page: disclaimer banner, month selector, summary cards, per-category usage gauges (green/amber/red), detailed table, historical chart
- Settings page: new "Contract" tab with auto-detect, catalog browser, line items management, alert configuration
- Viewers can see the report (read-only); operators manage configuration

### Email

- Scheduled report template with usage bars and summary table
- Separate threshold alert emails (warning at configurable threshold, exceeded at 100%)
- Alert recipients configurable in settings

### API Routes

8 new endpoints under `/api/contract/`:
- `GET/POST/PATCH/DELETE /line-items` – CRUD (GET: operator+viewer, write: operator)
- `GET /usage` – usage data with period query param
- `POST /usage/recalculate` – trigger recalculation (operator)
- `GET /catalog` – product catalog
- `POST /detect` – auto-detect available products (operator)

## Consequences

- 14 new files, 10 modified files
- DB schema version bumps to 11
- Reuses existing chart components, email template base, scheduler, collector infrastructure
- No additional Cloudflare API calls for core functionality (only local SQLite queries)
- Disclaimer must be visible wherever usage numbers are displayed
- Historical data accurate across commitment changes due to committed_amount snapshots

## Risks

- Analytics vs billing accuracy gap (mitigated by prominent disclaimer)
- Partial data for months where collector wasn't running
- Some products share the same underlying metric (CDN/WAF/Bot/RL all = HTTP requests) – correct per billing but may confuse users (mitigated by category grouping and descriptions)
