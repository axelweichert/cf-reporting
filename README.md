# cf-reporting

Open-source, self-hosted reporting dashboard for Cloudflare. Authenticate with your own API token and generate reports covering web security, Zero Trust, performance, DNS, and executive summaries – with scheduled email delivery, historical data collection, and PDF export.

## Features

- **15 Report Pages** – Traffic, Security, DDoS, Bots, Performance, DNS, SSL/TLS, API Shield, Origin Health, Zero Trust Summary, Gateway DNS/HTTP, Gateway Network, Access Audit, Shadow IT, Devices & Users
- **Executive Report** – Auto-generated multi-metric summary combining key data from all reports
- **Period-over-Period Comparison** – Toggle to overlay current vs. previous period with percentage-change indicators
- **PDF Export** – Server-side rendering via Playwright/Chromium for pixel-perfect A4 output
- **Email Scheduling** – Automated report delivery (daily / weekly / monthly) to up to 10 recipients per schedule
- **Background Data Collection** – Cron-scheduled collector stores normalized snapshots in SQLite for historical analysis
- **Data History** – Browse collected data, view collection run logs, and toggle between live API data and stored history
- **Graceful Degradation** – Adapts to your token's permissions; unavailable reports show which permissions are needed
- **Privacy First** – API tokens stay server-side only, never exposed to the browser
- **Dark / Light Mode** – Dark by default (matches Cloudflare dashboard aesthetic), toggle with one click
- **Security Hardened** – CSRF protection, rate-limited login, constant-time password comparison, encrypted session cookies

## Quick Start

### Docker (recommended)

```bash
docker run -p 3000:3000 ghcr.io/gladston3/cf-reporting:latest
```

Open `http://localhost:3000` and enter your Cloudflare API token.

### Pre-configured token

Skip the browser setup by providing your token as an environment variable. **`APP_PASSWORD` is required** when using env tokens – without it, anyone who can reach the app has full access to your Cloudflare data:

```bash
docker run -p 3000:3000 \
  -e CF_API_TOKEN=your_token_here \
  -e APP_PASSWORD=your_secret_password \
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

## Reports

| Category | Report | Description |
|---|---|---|
| **Web** | Traffic Overview | Requests, bandwidth, cache hit ratio, geographic distribution |
| | Security Posture | WAF events, firewall rules, bot scores, top attackers |
| | DDoS & Rate Limiting | DDoS events, attack vectors, rate limiting triggers |
| | Bot Analysis | Bot score distribution, verified bots, top user agents |
| | Performance | TTFB, origin response time metrics |
| | DNS Analytics | Query volume, response codes, NXDOMAIN hotspots, record inventory |
| | SSL / TLS | Certificate status and expiration tracking |
| | API Shield | API endpoint protection metrics |
| | Origin Health | Origin server health check events |
| **Zero Trust** | Executive Summary | Active users, blocked requests, incidents |
| | Gateway DNS & HTTP | DNS queries, blocked domains, category breakdown |
| | Gateway Network | L4 sessions, blocked IPs, posture check failures |
| | Access Audit | Login events, app access patterns, policy denials |
| | Shadow IT | Discovered SaaS apps, unsanctioned access, usage trends |
| | Devices & Users | Device posture and user analytics |
| **Summary** | Executive Report | Combined multi-metric summary with PDF export |

## Data Collection

The built-in background collector periodically fetches data from the Cloudflare API and stores normalized snapshots in a local SQLite database. This enables historical trend analysis beyond Cloudflare's default retention.

- **Initial backfill** – On the first run, fetches historical data day-by-day based on your Cloudflare plan: 3 days (Free), 30 days (Pro/Business), 90 days (Enterprise). Override with `INITIAL_LOOKBACK_DAYS`
- **Throttled backfill** – 2-second pause between each day-slice to stay well within Cloudflare's rate limits
- **Schedule** – Configurable via `COLLECTION_SCHEDULE` (default: every 6 hours)
- **Retention** – Configurable via `DATA_RETENTION_DAYS` (default: 90 days)
- **Storage** – Mount `/app/data` as a Docker volume for persistence
- **Manual trigger** – Start a collection run on demand from the Settings page
- **Run history** – View success/error/skipped counts per scope and report type

Toggle between live API data and stored historical data on any report page.

## Email Scheduling

Send reports automatically via email on a daily, weekly, or monthly schedule.

1. Configure SMTP in the Settings page (or via environment variables)
2. Create schedules – pick a report type, time range, frequency, and up to 10 recipients
3. Reports are rendered server-side and delivered as styled HTML emails

Supported report types: Executive, Security, Traffic, DNS, Performance, SSL, DDoS, Bots. Up to 20 active schedules per instance.

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
| Zone Analytics | Zone | Yes | Traffic, Performance, DNS, SSL, Origin Health |
| Firewall Services | Zone | Yes | Security, Bots, DDoS |
| DNS Read | Zone | Yes | DNS Analytics |
| Zero Trust | Account | Optional | Zero Trust Summary, Devices & Users |
| Access: Apps and Policies | Account | Optional | Access Audit |
| Gateway | Account | Optional | Gateway DNS/HTTP, Network, Shadow IT |

Both **User API tokens** and **Account API tokens** are supported. Reports requiring permissions your token doesn't have will show a helpful message instead of failing.

## Environment Variables

### Core

| Variable | Description | Default |
|---|---|---|
| `CF_API_TOKEN` | Pre-configured Cloudflare User API token | – |
| `CF_ACCOUNT_TOKEN` | Pre-configured Cloudflare Account API token (alternative) | – |
| `APP_PASSWORD` | Site password – **required** when `CF_API_TOKEN` or `CF_ACCOUNT_TOKEN` is set | – |
| `SESSION_SECRET` | 32+ char secret for encrypting session cookies | Auto-generated dev secret |
| `TRUSTED_PROXY` | Set to `true` when behind a reverse proxy to trust `X-Forwarded-For` | `false` |
| `SECURE_COOKIES` | Set to `true` for HTTPS deployments (marks cookies as Secure) | `false` |
| `PORT` | Server port | `3000` |

### Data Collection

| Variable | Description | Default |
|---|---|---|
| `COLLECTION_SCHEDULE` | Cron expression for background collection | `0 */6 * * *` |
| `DATA_RETENTION_DAYS` | Days to keep collected snapshots | `90` |
| `INITIAL_LOOKBACK_DAYS` | Override auto-detected initial backfill depth (1–365) | Auto by plan |

### SMTP (Email)

| Variable | Description | Default |
|---|---|---|
| `SMTP_HOST` | SMTP server hostname | – |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP authentication username | – |
| `SMTP_PASS` | SMTP authentication password | – |
| `SMTP_FROM` | From address for outgoing emails | – |
| `SMTP_SECURE` | Use TLS/SSL | `true` |

SMTP can also be configured through the Settings UI at runtime.

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
- [Lucide React](https://lucide.dev/) – icons

## Architecture

```
Browser → Next.js API Routes → Cloudflare API
           (token in encrypted     (REST + GraphQL)
            httpOnly cookie)
                  ↓
            SQLite (collected data)
            node-cron (scheduler)
            Playwright (PDF export)
```

All Cloudflare API calls are proxied through server-side routes. The token never reaches client-side JavaScript. No external database – the app runs as a single container with SQLite for optional data persistence.

## License

MIT
