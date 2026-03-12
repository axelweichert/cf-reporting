# cf-reporting

Open-source, self-hosted reporting dashboard for Cloudflare. Authenticate with your own API token and generate reports covering web security, Zero Trust, DNS, and executive summaries.

## Features

- **Web Security Reports** – Traffic overview, security posture, DDoS & rate limiting, bot analysis
- **DNS Analytics** – Query volume, response codes, record inventory
- **Zero Trust Reports** – Gateway DNS/HTTP, gateway network, Access audit log, Shadow IT / SaaS discovery
- **Executive Report** – Auto-generated summary with PDF export
- **Dark / Light Mode** – Toggle between themes
- **Graceful Degradation** – Adapts to your token's permissions; shows what's available
- **Privacy First** – API tokens stay server-side only, never exposed to the browser

## Quick Start

### Docker (recommended)

```bash
docker run -p 3000:3000 ghcr.io/your-org/cf-reporting:latest
```

Open `http://localhost:3000` and enter your Cloudflare API token.

### Pre-configured token

Skip the browser setup by providing your token as an environment variable:

```bash
docker run -p 3000:3000 -e CF_API_TOKEN=your_token_here ghcr.io/your-org/cf-reporting:latest
```

### Docker Compose

```bash
# Copy and edit the compose file
cp docker-compose.yml docker-compose.override.yml
# Set CF_API_TOKEN or SESSION_SECRET in .env if desired
docker compose up -d
```

### Development

```bash
git clone https://github.com/your-org/cf-reporting.git
cd cf-reporting
npm install
npm run dev
```

Open `http://localhost:3000`.

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

### SSL Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SSL_DOMAIN` | Domain(s) for the certificate – supports comma-separated multiple domains and wildcards (see below) | Required |
| `ACME_EMAIL` | Email for Let's Encrypt notifications | Required |
| `ACME_CHALLENGE` | `http` for HTTP-01 or `dns` for DNS-01 via Cloudflare | `http` |
| `CF_DNS_TOKEN` | Separate token for DNS-01 only (falls back to `CF_API_TOKEN`) | – |

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
| Zone Analytics | Zone | Yes | Traffic, Performance, Cache |
| Firewall Services | Zone | Yes | Security, Bots |
| DNS Read | Zone | Yes | DNS Analytics |
| Zero Trust | Account | Optional | Zero Trust Summary |
| Access: Apps and Policies | Account | Optional | Access Audit |
| Gateway | Account | Optional | Gateway DNS/HTTP, Network, Shadow IT |

Reports requiring permissions your token doesn't have will show a helpful message instead of failing.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CF_API_TOKEN` | Pre-configured Cloudflare API token (skips browser setup) | – |
| `SESSION_SECRET` | 32+ char secret for encrypting session cookies | Auto-generated dev secret |
| `PORT` | Server port | `3000` |

## Tech Stack

- [Next.js 16](https://nextjs.org/) (App Router)
- [React 19](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [Recharts 3](https://recharts.org/)
- [iron-session](https://github.com/vvo/iron-session) (encrypted cookies)
- [Lucide React](https://lucide.dev/) (icons)

## Architecture

```
Browser → Next.js API Routes → Cloudflare API
           (token in encrypted     (REST + GraphQL)
            httpOnly cookie)
```

All Cloudflare API calls are proxied through server-side routes. The token never reaches client-side JavaScript. No external database – the app runs as a single container with in-memory caching.

## License

MIT
