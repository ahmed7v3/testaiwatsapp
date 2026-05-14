#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# WhatsApp AI Bot — One-Command Server Bootstrap
# Run this on a fresh Ubuntu 22.04 / 24.04 EC2 instance.
# It installs everything, clones the repo, and starts the bot.
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/ahmed7v3/testaiwatsapp/main/bootstrap.sh | bash
#
# Or download + run:
#   wget -O bootstrap.sh https://git.io/xxx
#   chmod +x bootstrap.sh && ./bootstrap.sh
# =============================================================================

REPO_URL="https://github.com/ahmed7v3/testaiwatsapp.git"
INSTALL_DIR="/home/ubuntu/whatsapp-ai-bot"
NODE_MAJOR=20

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

cleanup() { echo; info "Bootstrap incomplete — see errors above."; }
trap cleanup ERR

clear
echo -e "${GREEN}"
echo " ╔══════════════════════════════════════════════╗"
echo " ║     WhatsApp AI Bot — Server Bootstrap       ║"
echo " ╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo " This script will:"
echo "   1. Install system packages (Chrome, Node.js, Nginx, ...)"
echo "   2. Clone the bot repository"
echo "   3. Install npm dependencies"
echo "   4. Create configuration (.env)"
echo "   5. Set up Nginx reverse proxy"
echo "   6. Start the bot with PM2 (auto-restart)"
echo "   7. Open firewall ports"
echo ""
echo -e "${YELLOW}Estimated time: 3-5 minutes${NC}"
echo ""

# --------------------------------------------------
# Root check
# --------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (use sudo)."
  exit 1
fi

# --------------------------------------------------
# 1. System updates + base packages
# --------------------------------------------------
info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
ok "System packages updated"

info "Installing base dependencies..."
apt-get install -y -qq \
    curl wget git build-essential \
    nginx certbot python3-certbot-nginx \
    xvfb libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libdrm2 libdbus-1-3 libexpat1 \
    libxcb1 libxkbcommon0 libxdamage1 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 \
    libatspi2.0-0 unzip
ok "Base dependencies installed"

# --------------------------------------------------
# 2. Node.js
# --------------------------------------------------
info "Installing Node.js ${NODE_MAJOR}.x..."
if ! command -v node &>/dev/null; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
ok "Node.js $(node --version) installed"

# --------------------------------------------------
# 3. Google Chrome
# --------------------------------------------------
info "Installing Google Chrome..."
if ! command -v google-chrome &>/dev/null; then
  wget -q -O /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  dpkg -i /tmp/chrome.deb 2>/dev/null || true
  apt-get --fix-broken install -y -qq
  rm -f /tmp/chrome.deb
fi
ok "Google Chrome $(google-chrome --version 2>/dev/null || echo 'installed')"

# --------------------------------------------------
# 4. Clone repository
# --------------------------------------------------
info "Cloning repository..."
if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  warn "Directory $INSTALL_DIR already exists — pulling latest..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin master 2>/dev/null || true
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
ok "Repository cloned to $INSTALL_DIR"

# --------------------------------------------------
# 5. Create necessary directories
# --------------------------------------------------
mkdir -p data sessions logs

# --------------------------------------------------
# 6. Environment configuration (interactive)
# --------------------------------------------------
echo ""
info "=== AI Provider Configuration ==="
echo "Supported providers: gemini, openai, groq, ollama, custom"
echo ""

if [ ! -f .env ]; then
  cp .env.example .env
fi

source_env() {
  if [ -f .env ]; then
    set -a; source .env; set +a 2>/dev/null || true
  fi
}

prompt_with_default() {
  local prompt="$1" var="$2" default="$3"
  local cur="${!var:-$default}"
  read -r -p "$prompt [$cur]: " input
  echo "${input:-$cur}"
}

AI_PROVIDER=$(prompt_with_default "AI Provider" AI_PROVIDER "gemini")
AI_MODEL=$(prompt_with_default "AI Model" AI_MODEL "gemini-2.0-flash")
AI_API_KEY=$(prompt_with_default "API Key" AI_API_KEY "")
ADMIN_PASSWORD=$(prompt_with_default "Admin Password (web dashboard + !auth)" ADMIN_PASSWORD "changeme123")

cat > .env << EOF
AI_PROVIDER=$AI_PROVIDER
AI_MODEL=$AI_MODEL
AI_API_KEY=$AI_API_KEY
AI_BASE_URL=
ADMIN_PASSWORD=$ADMIN_PASSWORD
NODE_ENV=production
EOF

ok ".env file created"

# --------------------------------------------------
# 7. Install npm dependencies
# --------------------------------------------------
info "Installing npm dependencies (this may take a minute)..."
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1
ok "npm dependencies installed"

# --------------------------------------------------
# 8. Install PM2 globally
# --------------------------------------------------
info "Installing PM2 process manager..."
npm install -g pm2 2>&1 | tail -1
ok "PM2 $(pm2 --version) installed"

# --------------------------------------------------
# 9. Configure Nginx
# --------------------------------------------------
info "Configuring Nginx reverse proxy..."
if [ -f deploy/nginx.conf ]; then
  cp deploy/nginx.conf /etc/nginx/sites-available/whatsapp-bot
else
  cat > /etc/nginx/sites-available/whatsapp-bot << 'NGX'
upstream whatsapp_bot { server 127.0.0.1:3000; keepalive 64; }
server {
    listen 80; server_name _; client_max_body_size 50m;
    location / {
        proxy_pass http://whatsapp_bot;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location /api/ {
        proxy_pass http://whatsapp_bot;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGX
fi

ln -sf /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
ok "Nginx configured (port 80 → 3000)"

# --------------------------------------------------
# 10. Set up PM2 startup
# --------------------------------------------------
info "Setting up PM2 auto-start on boot..."
if [ -f ecosystem.config.js ]; then
  pm2 start ecosystem.config.js --env production 2>/dev/null
  pm2 save 2>/dev/null
fi

pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true
ok "PM2 startup configured"

# --------------------------------------------------
# 11. Firewall
# --------------------------------------------------
info "Configuring firewall..."
ufw --force reset 2>/dev/null || true
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ok "Firewall active (SSH, HTTP, HTTPS)"

# --------------------------------------------------
# 12. Status check
# --------------------------------------------------
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           BOOTSTRAP COMPLETE!                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""

IP=$(curl -s http://checkip.amazonaws.com 2>/dev/null || echo "<server-ip>")
echo -e "  ${CYAN}Web Dashboard:${NC}  http://$IP"
echo -e "  ${CYAN}Login password:${NC} $ADMIN_PASSWORD"
echo -e "  ${CYAN}Bot directory:${NC}  $INSTALL_DIR"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo "    1. Open http://$IP in your browser"
echo "    2. Login with the admin password above"
echo "    3. Go to الأرقام tab → wait for QR code"
echo "    4. Open WhatsApp → Linked Devices → Scan QR"
echo ""
echo -e "  ${YELLOW}Manage the bot:${NC}"
echo "    pm2 status               — check if running"
echo "    pm2 logs whatsapp-ai-bot — live logs"
echo "    pm2 monit                — memory / CPU"
echo "    cd $INSTALL_DIR && git pull && npm install && pm2 restart whatsapp-ai-bot  — update"
echo ""
echo -e "  ${YELLOW}For HTTPS (domain required):${NC}"
echo "    sudo certbot --nginx -d yourdomain.com"
echo ""

# Give PM2 a moment to start, then show status
sleep 2
pm2 status 2>/dev/null || true
