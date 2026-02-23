#!/bin/sh
set -e

CADDYFILE_DIR="/etc/caddy"

if [ "$ACME_CHALLENGE" = "dns" ]; then
    # DNS-01 challenge via Cloudflare
    # Allow a dedicated CF_DNS_TOKEN, falling back to the shared CF_API_TOKEN
    export CF_DNS_TOKEN="${CF_DNS_TOKEN:-$CF_API_TOKEN}"

    if [ -z "$CF_DNS_TOKEN" ]; then
        echo "Error: ACME_CHALLENGE=dns requires CF_DNS_TOKEN or CF_API_TOKEN to be set" >&2
        echo "The token needs Zone > DNS > Edit permission for the certificate domain." >&2
        exit 1
    fi

    echo "Using DNS-01 challenge via Cloudflare API"
    cp "$CADDYFILE_DIR/Caddyfile.dns01" "$CADDYFILE_DIR/Caddyfile"
else
    echo "Using HTTP-01 challenge (ensure port 80 is accessible from the internet)"
    cp "$CADDYFILE_DIR/Caddyfile.http01" "$CADDYFILE_DIR/Caddyfile"
fi

if [ -z "$SSL_DOMAIN" ]; then
    echo "Error: SSL_DOMAIN must be set (e.g., reports.example.com)" >&2
    exit 1
fi

if [ -z "$ACME_EMAIL" ]; then
    echo "Error: ACME_EMAIL must be set for Let's Encrypt notifications" >&2
    exit 1
fi

echo "Starting Caddy for ${SSL_DOMAIN}..."
exec caddy run --config "$CADDYFILE_DIR/Caddyfile" --adapter caddyfile
