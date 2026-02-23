# CF Reporting

Open-source, self-hosted reporting dashboard for Cloudflare. Authenticate with your own API token and generate reports covering web security, Zero Trust, DNS, and executive summaries.

## Features

- **Web Security Reports** — Traffic overview, security posture, DDoS & rate limiting, bot analysis
- **DNS Analytics** — Query volume, response codes, record inventory
- **Zero Trust Reports** — Gateway DNS/HTTP, gateway network, Access audit log, Shadow IT / SaaS discovery
- **Executive Report** — Auto-generated summary with PDF export
- **Dark / Light Mode** — Toggle between themes
- **Graceful Degradation** — Adapts to your token's permissions; shows what's available
- **Privacy First** — API tokens stay server-side only, never exposed to the browser

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
| `CF_API_TOKEN` | Pre-configured Cloudflare API token (skips browser setup) | — |
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

All Cloudflare API calls are proxied through server-side routes. The token never reaches client-side JavaScript. No external database — the app runs as a single container with in-memory caching.

## License

MIT
