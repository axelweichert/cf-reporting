# Build Caddy with Cloudflare DNS plugin for DNS-01 ACME challenge
FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile.http01 /etc/caddy/Caddyfile.http01
COPY Caddyfile.dns01 /etc/caddy/Caddyfile.dns01
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
