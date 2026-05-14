#!/bin/bash
set -e

# ============================================================
# WhatsApp AI Bot - AWS EC2 Setup Script
# Tested on: Ubuntu 22.04 LTS (t3.medium or larger recommended)
# ============================================================

# Configuration - CHANGE THESE
BOT_DIR="/home/ubuntu/whatsapp-ai-bot"
DOMAIN=""  # Optional: set to your domain for HTTPS, leave empty for IP-only
ADMIN_PASSWORD="changeme123"  # CHANGE THIS
AI_API_KEY=""  # Your Gemini/OpenAI API key
AI_PROVIDER="gemini"
AI_MODEL="gemini-3-flash-preview"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  WhatsApp AI Bot - EC2 Deployment${NC}"
echo -e "${GREEN}========================================${NC}"

# --- 1. System Updates & Dependencies ---
echo -e "${YELLOW}[1/8] Updating system packages...${NC}"
apt-get update -y
apt-get upgrade -y

echo -e "${YELLOW}[2/8] Installing system dependencies...${NC}"
apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    nginx \
    certbot \
    python3-certbot-nginx \
    xvfb \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libexpat1 \
    libxcb1 \
    libxkbcommon0 \
    libxdamage1 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0

# --- 2. Install Node.js 20 LTS ---
echo -e "${YELLOW}[3/8] Installing Node.js 20 LTS...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

# --- 3. Install Google Chrome (for Puppeteer/WhatsApp Web) ---
echo -e "${YELLOW}[4/8] Installing Google Chrome...${NC}"
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb || true
apt-get --fix-broken install -y
google-chrome --version || echo -e "${RED}Chrome install may have issues${NC}"

# --- 4. Install PM2 Globally ---
echo -e "${YELLOW}[5/8] Installing PM2 process manager...${NC}"
npm install -y pm2 -g

# --- 5. Clone / Copy Application Code ---
echo -e "${YELLOW}[6/8] Setting up application...${NC}"
if [ ! -d "$BOT_DIR" ]; then
    mkdir -p "$BOT_DIR"
fi

# Create necessary directories
mkdir -p "$BOT_DIR/data" "$BOT_DIR/sessions" "$BOT_DIR/logs"

# Create .env file
cat > "$BOT_DIR/.env" << EOF
AI_PROVIDER=$AI_PROVIDER
AI_MODEL=$AI_MODEL
AI_API_KEY=$AI_API_KEY
AI_BASE_URL=
ADMIN_PASSWORD=$ADMIN_PASSWORD
NODE_ENV=production
EOF

echo -e "${GREEN}  -> .env file created at $BOT_DIR/.env${NC}"
echo -e "${YELLOW}  IMPORTANT: You still need to copy the application code to $BOT_DIR${NC}"
echo -e "${YELLOW}  Run: git clone <your-repo> $BOT_DIR  OR  scp -r ./whatsapp-ai-bot/* ubuntu@<ip>:$BOT_DIR/${NC}"

# --- 6. Install npm dependencies ---
echo -e "${YELLOW}[7/8] Installing npm dependencies...${NC}"
cd "$BOT_DIR"
if [ -f "package.json" ]; then
    npm install --production
else
    echo -e "${RED}  -> package.json not found. Install deps manually after copying code.${NC}"
fi

# --- 7. Configure Nginx ---
echo -e "${YELLOW}[8/8] Configuring Nginx...${NC}"

# Copy the nginx config
if [ -f "$BOT_DIR/deploy/nginx.conf" ]; then
    cp "$BOT_DIR/deploy/nginx.conf" /etc/nginx/sites-available/whatsapp-bot
    ln -sf /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default

    # Update domain if set
    if [ -n "$DOMAIN" ]; then
        sed -i "s/server_name _;/server_name $DOMAIN;/" /etc/nginx/sites-available/whatsapp-bot
    fi

    nginx -t && systemctl restart nginx
    echo -e "${GREEN}  -> Nginx configured${NC}"
else
    echo -e "${RED}  -> nginx.conf not found. Will create manually.${NC}"
    # Create minimal nginx config
    cat > /etc/nginx/sites-available/whatsapp-bot << 'NGINX'
upstream whatsapp_bot {
    server 127.0.0.1:3000;
    keepalive 64;
}
server {
    listen 80;
    server_name _;
    client_max_body_size 50m;
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
NGINX
    ln -sf /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl restart nginx
fi

# --- 8. Configure PM2 to auto-start on boot ---
echo -e "${YELLOW}[+] Setting up PM2 startup...${NC}"
pm2 startup systemd -u ubuntu --hp /home/ubuntu
if [ -f "$BOT_DIR/ecosystem.config.js" ]; then
    cd "$BOT_DIR"
    env PATH=$PATH:/usr/bin pm2 start ecosystem.config.js --env production
    pm2 save
fi

# --- 9. Set up firewall ---
echo -e "${YELLOW}[+] Configuring firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Next steps:"
echo -e "  1. Copy your code to: ${YELLOW}$BOT_DIR${NC}"
echo -e "  2. Run: ${YELLOW}cd $BOT_DIR && npm install && pm2 start ecosystem.config.js${NC}"
echo -e "  3. Set AI_API_KEY in ${YELLOW}$BOT_DIR/.env${NC} or press K in the dashboard"
echo -e "  4. Access web UI at: ${YELLOW}http://$(curl -s http://checkip.amazonaws.com)${NC}"
echo -e "  5. For HTTPS: ${YELLOW}certbot --nginx -d yourdomain.com${NC}"
echo ""
echo -e "${RED}  Ã¢Å¡Â  CHANGE THE ADMIN PASSWORD:${NC}"
echo -e "  Edit $BOT_DIR/.env and set ADMIN_PASSWORD to a strong password"
echo ""