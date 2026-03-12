#!/bin/bash
# cf-reporting – Development Environment Setup
# Run this on your headless Ubuntu 24.04 before starting Claude Code

set -e

echo "=== cf-reporting Development Setup ==="

# 1. Ensure Node.js 20+ is installed
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "✓ Node.js $(node -v)"

# 2. Ensure npm is up to date
npm install -g npm@latest 2>/dev/null
echo "✓ npm $(npm -v)"

# 3. Install Claude Code if not present
if ! command -v claude &> /dev/null; then
    echo "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code
fi
echo "✓ Claude Code installed"

# 4. Install Playwright browsers (headless)
echo "Installing Playwright Chromium (headless)..."
npx playwright install chromium --with-deps 2>/dev/null
echo "✓ Playwright Chromium installed"

# 5. Configure MCP servers for Claude Code
echo ""
echo "=== Configuring MCP Servers ==="

# Cloudflare Code Mode MCP (development-time API discovery)
claude mcp add cloudflare-api --transport http https://mcp.cloudflare.com/mcp 2>/dev/null || true
echo "✓ Cloudflare Code Mode MCP added"

# Playwright MCP (headless browser testing)
claude mcp add playwright -- npx @playwright/mcp@latest --headless 2>/dev/null || true
echo "✓ Playwright MCP added (headless mode)"

# Context7 MCP (up-to-date library documentation)
claude mcp add context7 -- npx -y @upstash/context7-mcp 2>/dev/null || true
echo "✓ Context7 MCP added"

echo ""
echo "=== Verifying MCP Configuration ==="
claude mcp list 2>/dev/null || echo "(run 'claude' and type /mcp to verify)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. cd into your cf-reporting project directory"
echo "  2. Run: claude --dangerously-skip-permissions"
echo "  3. Paste the initial prompt from INITIAL_PROMPT.md"
echo "  4. Walk away and let it build"
echo ""
echo "Or for a safer approach:"
echo "  1. cd into your cf-reporting project directory"
echo "  2. Run: claude"
echo "  3. Use shift+tab for auto-accept mode"
echo "  4. Paste the initial prompt and monitor progress"
