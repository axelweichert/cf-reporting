# cf-reporting

Open-source, self-hosted reporting dashboard for Cloudflare. Authenticate with your own API token and generate reports covering web security, Zero Trust, performance, DNS, and executive summaries – with scheduled email delivery, historical data collection, and PDF export.

## Features

- **15 Report Pages** – Traffic, Security, DDoS, Bots, Performance, DNS, SSL/TLS, API Shield, Origin Health, Zero Trust Summary, Gateway DNS/HTTP, Gateway Network, Access Audit, Shadow IT, Devices & Users
- **Executive Report** – Auto-generated multi-metric summary combining key data from all reports
- **Period-over-Period Comparison** – Toggle to overlay current vs. previous period with percentage-change indicators
- **PDF & HTML Export** – Server-side PDF rendering via Playwright/Chromium for pixel-perfect A4 output, plus instant HTML download
- **Email Scheduling** – Automated report delivery (daily / weekly / monthly) to up to 10 recipients per schedule, persisted in SQLite across restarts
- **Background Data Collection** – Cron-scheduled collector stores normalized snapshots in SQLite for historical analysis
- **Data History** – Browse collected data, view collection run logs, and toggle between live API data and stored history with a freshness indicator
- **Backup & Restore** – Export/import schedules as JSON, download the full SQLite database, or push backups to Cloudflare R2
- **Two Operating Modes** – Explore (browser token, no persistence) and Managed (env token, persistent schedules, startup validation)
- **Graceful Degradation** – Adapts to your token's permissions; unavailable reports show which permissions are needed
- **Privacy First** – API tokens stay server-side only, never exposed to the browser
- **Dark / Light Mode** – Dark by default (matches Cloudflare dashboard aesthetic), toggle with one click
- **Security Hardened** – CSRF protection, rate-limited login, constant-time password comparison, encrypted session cookies, security headers (X-Frame-Options, HSTS, Referrer-Policy)

## Quick Start

### Docker (recommended)

```bash
docker run -p 3000:3000 ghcr.io/gladston3/cf-reporting:latest
```

Open `http://localhost:3000` and enter your Cloudflare API token. This launches in **Explore mode** – no persistence, no site password required.

### Managed mode (pre-configured token)

Skip the browser setup by providing your token as an environment variable. This enables persistent schedules, background data collection, and scheduled email delivery. **`APP_PASSWORD` and `SESSION_SECRET` are required** in managed mode:

```bash
docker run -p 3000:3000 \
  -e CF_API_TOKEN=your_token_here \
  -e APP_PASSWORD=your_secret_password \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v cf_data:/app/data \
  ghcr.io/gladston3/cf-reporting:latest
```

### Docker Compose

```bash
# Copy and edit the compose file
cp docker-compose.yml docker-compose.override.yml
# Set CF_API_TOKEN, APP_PASSWORD, SESSION_SECRET, etc. in .env
docker compose up -d
```

### Development

```bash
git clone https://github.com/gladston3/cf-reporting.git
cd cf-reporting
npm install
npm run dev
```

Open `http://localhost:3000`.

## Operating Modes

cf-reporting has two operating modes, determined automatically by whether a Cloudflare API token environment variable is set.

### Explore mode

No env token set. Users enter their own token in the browser. No persistence, no site password, no startup validation. Ideal for quick ad-hoc reporting.

### Managed mode

`CF_API_TOKEN` or `CF_ACCOUNT_TOKEN` is set. The app enforces startup validation:

- `APP_PASSWORD` is required – without it, the configured token would be accessible to anyone
- `SESSION_SECRET` must be a random string of at least 32 characters
- Partial SMTP configuration (e.g. SMTP_HOST without SMTP_PASS) is rejected at startup
- `SECURE_COOKIES=true` logs a reminder to serve over HTTPS

Managed mode enables persistent email schedules, background data collection, and scheduled report delivery.

## Reports

| Category | Report | Permission | Description |
|---|---|---|---|
| **Web** | Traffic Overview | Zone Analytics | Requests, bandwidth, cache hit ratio, geographic distribution |
| | Security Posture | Firewall Services | WAF events, firewall rules, top attackers |
| | DDoS & Rate Limiting | Zone Analytics | DDoS events, attack vectors, rate limiting triggers |
| | Bot Analysis | Firewall Services | Bot score distribution, verified bots, top user agents |
| | Performance | Zone Analytics | TTFB, origin response time metrics |
| | SSL / TLS | Zone Analytics | TLS versions, HTTP protocols, certificate status |
| | API Shield | Zone Analytics | API endpoint protection metrics |
| | Origin Health | Zone Analytics | Origin server health check events |
| **DNS** | DNS Analytics | DNS Read | Query volume, response codes, NXDOMAIN hotspots, record inventory |
| **Zero Trust** | ZT Summary | Zero Trust | Active users, blocked requests, compliance |
| | Gateway DNS & HTTP | Gateway | DNS queries, blocked domains, category breakdown |
| | Gateway Network | Gateway | L4 sessions, blocked IPs, protocol distribution |
| | Access Audit | Access | Login events, app access patterns, policy denials |
| | Shadow IT | Gateway | Discovered SaaS apps, unsanctioned access, usage trends |
| | Devices & Users | Zero Trust | Device posture and user analytics |
| **Summary** | Executive Report | – | Combined multi-metric summary with PDF export |

## Data Collection

The built-in background collector periodically fetches data from the Cloudflare API and stores normalized snapshots in a local SQLite database. This enables historical trend analysis beyond Cloudflare's default retention.

- **Initial backfill** – On the first run, attempts to fetch up to 365 days of historical data in 7-day slices. The Cloudflare API enforces plan-based retention limits automatically (Free gets ~3 days, Pro/Business ~30 days, Enterprise ~90 days). Override with `INITIAL_LOOKBACK_DAYS`
- **Throttled backfill** – 1-second pause between slices to stay well within Cloudflare's rate limits
- **Schedule** – Configurable via `COLLECTION_SCHEDULE` (default: every 6 hours)
- **Retention** – Configurable via `DATA_RETENTION_DAYS` (default: 365 days)
- **Storage** – Mount `/app/data` as a Docker volume for persistence
- **Manual trigger** – Start a collection run on demand from the Settings page
- **Run history** – View success/error/skipped counts per scope and report type
- **Data freshness** – When viewing historic data, the filter bar shows how recently data was collected (e.g. "Updated 5m ago")

Toggle between live API data and stored historical data on any report page.

## Email Scheduling

Send reports automatically via email on a daily, weekly, or monthly schedule.

1. Configure SMTP via environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS)
2. Create schedules in the Settings page – pick a report type, time range, frequency, and up to 10 recipients
3. Reports are rendered server-side and delivered as styled HTML emails
4. Schedules are persisted in SQLite and survive container restarts

The Settings UI supports one-shot SMTP testing but scheduled delivery always uses the SMTP_* env vars. Both `CF_API_TOKEN` and `CF_ACCOUNT_TOKEN` are supported for scheduled delivery.

All 16 report types are supported for email scheduling, including zone-scoped reports (Traffic, Security, DDoS, Bots, Performance, DNS, SSL/TLS, API Shield, Origin Health, Executive) and account-scoped Zero Trust reports (ZT Summary, Gateway DNS & HTTP, Gateway Network, Access Audit, Shadow IT, Devices & Users). Up to 20 active schedules per instance.

## Backup & Restore

Export and restore your configuration from the Settings page:

- **Config export** – Download schedules and metadata as a JSON file
- **Database export** – Download the full SQLite database (includes collected data)
- **Config restore** – Upload a previously exported JSON file to restore schedules
- **R2 backup** – Push config or database backups directly to a Cloudflare R2 bucket (requires R2_* env vars)

## Security Headers

All responses include the following headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

When `SECURE_COOKIES=true`, responses also include `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

## SSL / HTTPS Deployment

cf-reporting supports automatic Let's Encrypt SSL via a Caddy reverse proxy with Mozilla Intermediate cipher configuration.

### HTTP-01 Challenge (default)

Best for servers with port 80 accessible from the internet.

```bash
cp .env.ssl.example .env
# Edit .env – set SSL_DOMAIN, ACME_EMAIL, SESSION_SECRET
docker compose -f docker-compose.ssl.yml up -d
```

### DNS-01 Challenge (via Cloudflare)

Best when port 80 is blocked or for internal networks. Uses the Cloudflare API to create DNS TXT records for certificate validation.

Your token needs **Zone > DNS > Edit** permission in addition to the reporting permissions listed below.

```bash
cp .env.ssl.example .env
# Edit .env – set ACME_CHALLENGE=dns, SSL_DOMAIN, ACME_EMAIL, CF_API_TOKEN
docker compose -f docker-compose.ssl.yml up -d
```

### Multiple Domains & Wildcards

`SSL_DOMAIN` supports comma-separated multiple domains:

```bash
SSL_DOMAIN=reports.example.com, dashboard.example.com
```

Wildcard certificates are supported with DNS-01 challenge only:

```bash
SSL_DOMAIN=*.example.com
ACME_CHALLENGE=dns
```

A wildcard covers subdomains but not the bare domain – use both if needed:

```bash
SSL_DOMAIN=example.com, *.example.com
ACME_CHALLENGE=dns
```

Certificates are stored in the `caddy_data` Docker volume and persist across restarts. Caddy handles renewal automatically with zero downtime.

## API Token Permissions

Create a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with these permissions:

| Permission | Scope | Required | Reports |
|---|---|---|---|
| Account Settings | Account | Yes | Account/zone listing |
| Zone Analytics | Zone | Yes | Traffic, DDoS, Performance, SSL/TLS, API Shield, Origin Health |
| Firewall Services | Zone | Yes | Security Posture, Bot Analysis |
| DNS Read | Zone | Yes | DNS Analytics |
| Zero Trust | Account | Optional | ZT Summary, Devices & Users |
| Access: Apps and Policies | Account | Optional | Access Audit |
| Gateway | Account | Optional | Gateway DNS/HTTP, Gateway Network, Shadow IT |

The Executive Report has no permission gate – it aggregates data from available zone-scoped permissions.

Both **User API tokens** (`CF_API_TOKEN`) and **Account API tokens** (`CF_ACCOUNT_TOKEN`) are supported. Reports requiring permissions your token doesn't have will show a helpful message instead of failing.

## Environment Variables

### Core

| Variable | Description | Default |
|---|---|---|
| `CF_API_TOKEN` | Pre-configured Cloudflare User API token | – |
| `CF_ACCOUNT_TOKEN` | Pre-configured Cloudflare Account API token (alternative) | – |
| `APP_PASSWORD` | Site password – **required** in managed mode (when either token env var is set) | – |
| `SESSION_SECRET` | 32+ char secret for encrypting session cookies – **required** in managed mode | Auto-generated dev secret |
| `TRUSTED_PROXY` | Set to `true` when behind a reverse proxy to trust `X-Forwarded-For` | `false` |
| `SECURE_COOKIES` | Set to `true` for HTTPS deployments (marks cookies as Secure, enables HSTS) | `false` |
| `PORT` | Server port | `3000` |

### Data Collection

| Variable | Description | Default |
|---|---|---|
| `COLLECTION_SCHEDULE` | Cron expression for background collection | `0 */6 * * *` |
| `DATA_RETENTION_DAYS` | Days to keep collected snapshots | `365` |
| `INITIAL_LOOKBACK_DAYS` | Override initial backfill depth (1–365) | `365` |

### SMTP (Email)

| Variable | Description | Default |
|---|---|---|
| `SMTP_HOST` | SMTP server hostname | – |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP authentication username | – |
| `SMTP_PASS` | SMTP authentication password | – |
| `SMTP_FROM` | From address for outgoing emails | – |
| `SMTP_SECURE` | Use TLS/SSL | `true` |

The Settings UI supports one-shot SMTP testing but scheduled delivery always uses the SMTP_* env vars.

### Backup (R2)

| Variable | Description | Default |
|---|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID for R2 | – |
| `R2_ACCESS_KEY_ID` | R2 API token access key ID | – |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret access key | – |
| `R2_BUCKET_NAME` | R2 bucket name for backup storage | – |

### SSL (docker-compose.ssl.yml)

| Variable | Description | Default |
|---|---|---|
| `SSL_DOMAIN` | Domain(s) for the certificate – supports comma-separated and wildcards | Required |
| `ACME_EMAIL` | Email for Let's Encrypt notifications | Required |
| `ACME_CHALLENGE` | `http` for HTTP-01 or `dns` for DNS-01 via Cloudflare | `http` |
| `CF_DNS_TOKEN` | Separate token for DNS-01 only (falls back to `CF_API_TOKEN`) | – |

## Tech Stack

- [Next.js 16](https://nextjs.org/) (App Router)
- [React 19](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [Recharts 3](https://recharts.org/) – time-series, donut, bar charts
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) – local data storage
- [iron-session](https://github.com/vvo/iron-session) – encrypted session cookies
- [Playwright](https://playwright.dev/) – server-side PDF rendering
- [nodemailer](https://nodemailer.com/) – email delivery
- [node-cron](https://github.com/node-cron/node-cron) – scheduled collection & email
- [@aws-sdk/client-s3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/) – R2 backup (S3-compatible)
- [Lucide React](https://lucide.dev/) – icons

## Architecture

```
Browser → Next.js API Routes → Cloudflare API
           (token in encrypted     (REST + GraphQL)
            httpOnly cookie)
                  ↓
            SQLite (collected data + schedules)
            node-cron (scheduler)
            Playwright (PDF export)
            R2 (optional backup)
```

All Cloudflare API calls are proxied through server-side routes. The token never reaches client-side JavaScript. No external database – the app runs as a single container with SQLite for optional data persistence.

## License

MIT
