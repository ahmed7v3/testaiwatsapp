# AWS EC2 Deployment Guide

## Architecture

```
Internet â”€â”€â–º EC2 (Ubuntu 22.04)
                â”œâ”€â”€ Nginx (port 80) â”€â”€â–º proxy to â”€â”€â–º Node.js (port 3000)
                â”œâ”€â”€ PM2 (process manager)
                â”œâ”€â”€ Chrome (headless) â† WhatsApp Web
                â”œâ”€â”€ sessions/ (persistent login)
                â””â”€â”€ data/config.json
```

## Prerequisites

1. **AWS Account** â€” with permissions to create EC2, Security Groups, Elastic IP
2. **AWS CLI** or AWS Console access
3. **SSH client** â€” to connect to the server
4. **Domain** (optional) â€” for HTTPS

---

## Step 1: Launch EC2 Instance

### From AWS Console:
1. **EC2 â†’ Launch Instance**
   - Name: `whatsapp-bot`
   - AMI: **Ubuntu Server 22.04 LTS (HVM), SSD Volume Type** â€” free tier eligible
   - Instance type: **t3.medium** (2 vCPU, 4GB RAM) minimum. t3.small might work but t3.medium is recommended for Chrome
   - Key pair: Create or select existing (you'll need the `.pem` file for SSH)
   - Network settings:
     - Allow SSH (22) â€” your IP only
     - Allow HTTP (80) â€” everywhere (0.0.0.0/0)
     - Allow HTTPS (443) â€” everywhere (optional, for SSL)
   - Storage: **20GB gp3** minimum

### From AWS CLI:
```bash
aws ec2 run-instances \
    --image-id ami-0c7217cdde317cfec \
    --instance-type t3.medium \
    --key-name your-key-pair \
    --security-group-ids sg-your-sg \
    --block-device-mappings DeviceName=/dev/sda1,Ebs={VolumeSize=20} \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=whatsapp-bot}]'
```

2. **Allocate Elastic IP** (optional but recommended â€” won't change on restart):
   ```bash
   aws ec2 allocate-address --domain vpc
   aws ec2 associate-address --instance-id i-xxxxx --allocation-id eipalloc-xxxxx
   ```

3. **Connect via SSH**:
   ```bash
   ssh -i your-key.pem ubuntu@<server-ip>
   ```

---

## Step 2: Run Setup Script

SSH into the server, then:

```bash
# Download the setup script and run it
# (Or you can copy it manually from the deploy/ directory)

# First, get the code on the server:
git clone https://github.com/your-repo/whatsapp-ai-bot.git ~/whatsapp-ai-bot
cd ~/whatsapp-ai-bot

# Make the setup script executable and run it:
chmod +x deploy/setup-ec2.sh
sudo ./deploy/setup-ec2.sh
```

The script will:
- Install system packages (Chrome, Nginx, Node.js 20, etc.)
- Install npm dependencies
- Configure Nginx as a reverse proxy
- Set up PM2 for auto-start on boot
- Configure firewall (UFW)

### What the script does step-by-step:

| Step | What | Why |
|------|------|-----|
| 1 | `apt-get update/upgrade` | Fresh system packages |
| 2 | Install Chrome dependencies | Puppeteer needs libs for headless Chrome |
| 3 | Install Node.js 20 LTS | Runtime for the bot |
| 4 | Install Google Chrome | Required by `whatsapp-web.js` for WhatsApp Web automation |
| 5 | Install PM2 | Keeps the bot running 24/7, auto-restarts on crash |
| 6 | Install npm deps | `whatsapp-web.js`, `express`, `@google/generative-ai`, etc. |
| 7 | Configure Nginx | Reverse proxy from port 80 â†’ 3000 for the web dashboard |
| 8 | PM2 startup | Ensures bot starts on server reboot |
| 9 | UFW firewall | Only SSH, HTTP, HTTPS allowed |

---

## Step 3: Configure Environment

```bash
cd ~/whatsapp-ai-bot

# Edit the .env file with your settings:
nano .env
```

**Required changes:**
- `AI_API_KEY` â€” your Gemini/OpenAI/Groq API key
- `ADMIN_PASSWORD` â€” change from default! This secures the web dashboard and WhatsApp admin commands

**Recommended settings for production:**
```
AI_PROVIDER=gemini
AI_MODEL=gemini-2.0-flash
AI_API_KEY=AIzaSy...
ADMIN_PASSWORD=your-strong-password
NODE_ENV=production
```

---

## Step 4: Start the Bot

```bash
cd ~/whatsapp-ai-bot

# Start with PM2 (recommended):
pm2 start ecosystem.config.js --env production
pm2 save

# Or test manually first:
node src/index.js
```

---

## Step 5: Link WhatsApp

The bot runs in **headless mode** (no terminal dashboard) on the server. The web dashboard handles everything.

1. Open your browser and go to: `http://<server-ip>`
2. Login with your admin password
3. Go to the **Ø§Ù„Ø£Ø±Ù‚Ø§Ù… (Instances)** tab
4. You'll see the instance status. If it shows "Scan QR", the QR code is generated
5. The web page will poll and display the QR automatically once generated
6. Open WhatsApp on your phone â†’ Linked Devices â†’ Link a Device â†’ Scan the QR

Alternatively, check the logs for QR info:
```bash
pm2 logs whatsapp-ai-bot --lines 50
```

---

## Step 6: Monitor & Manage

### Check status:
```bash
pm2 status
pm2 logs whatsapp-ai-bot      # Live logs
pm2 monit                      # Resource monitor
```

### Restart:
```bash
pm2 restart whatsapp-ai-bot
```

### Update the bot:
```bash
cd ~/whatsapp-ai-bot
git pull
npm install --production
pm2 restart whatsapp-ai-bot
```

---

## Step 7 (Optional): HTTPS with Let's Encrypt

```bash
sudo certbot --nginx -d yourdomain.com
```

Make sure your domain's DNS points to the server's IP first.

---

## Security Checklist

- [ ] Changed `ADMIN_PASSWORD` from default
- [ ] Set a strong `AI_API_KEY` (never commit to git)
- [ ] SSH key access only (no password auth)
- [ ] SSH port restricted to your IP in Security Group
- [ ] UFW firewall active (verify: `sudo ufw status`)
- [ ] HTTPS configured (certbot)
- [ ] Regular backups of `sessions/` directory (contains WhatsApp login)

---

## Troubleshooting

### Bot receives messages but doesn't reply
```bash
# Check the AI provider status:
pm2 logs whatsapp-ai-bot | grep -i "error\|quota\|429\|fail"
```

Common cause: **Gemini free tier quota exceeded** (20 req/day). Press `P` to cycle providers, or configure a different provider in `.env` and restart.

### Chrome/Puppeteer issues
```bash
# Verify Chrome is installed:
google-chrome --version

# If Puppeteer can't find Chrome, set the path:
export PUPPETEER_CHROMIUM_REVISION=0
export CHROME_PATH=/usr/bin/google-chrome
```

### Session lost after restart
The `sessions/` directory contains WhatsApp Web auth data. It's persistent across restarts. If it's lost, you'll need to re-scan the QR code. The `data/config.json` file is separate and stores bot configuration.

### Port already in use
```bash
sudo lsof -i :3000
sudo systemctl restart nginx
```

### Memory issues (t3.small)
WhatsApp Web + Chrome + Node.js can use 1-2GB RAM. If the bot crashes randomly:
- Check `dmesg | grep -i kill` for OOM killer
- Upgrade to t3.medium or add swap: `sudo fallocate -l 2G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`

---

## Cost Estimate (AWS)

| Service | Spec | Monthly Cost |
|---------|------|-------------|
| EC2 t3.medium | 2 vCPU, 4GB RAM | ~$30 (on-demand) |
| EBS gp3 | 20GB | ~$2 |
| Elastic IP | 1 IP | ~$3 (if not attached to running instance) |
| **Total** | | **~$35/month** |

**Cost reduction:**
- Use **t3.small** (~$20/month) â€” may need swap for Chrome
- Use **Spot Instance** (~60% cheaper) â€” but may be interrupted
- Use **Lightsail** ($10-20/month) â€” simpler, fixed pricing

---

## Quick Reference

```bash
# SSH
ssh -i your-key.pem ubuntu@<ip>

# Logs
pm2 logs whatsapp-ai-bot
tail -f logs/combined.log
tail -f logs/error.log

# Restart
pm2 restart whatsapp-ai-bot

# Stop
pm2 stop whatsapp-ai-bot

# Update code
cd ~/whatsapp-ai-bot && git pull && npm install && pm2 restart whatsapp-ai-bot

# Nginx
sudo nginx -t && sudo systemctl reload nginx
```
