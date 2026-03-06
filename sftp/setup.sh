#!/bin/bash
set -e

# Setup script for FileBrowser + nginx (theme injection) + Cloudflare Tunnel
# Provides web file access to /home/debian/minecraft/server/test via sftp.matcraft-mc.com
# Run with sudo on the target Debian server
#
# Requires: scripts/filebrowser-branding/ directory next to this script
#   - custom.css      (MatCraft dark/light theme)
#   - theme-toggle.js (dark mode toggle button)
#
# Set FILEBROWSER_PASSWORD env var before running, or you will be prompted.

if [ -z "$FILEBROWSER_PASSWORD" ]; then
  read -s -p "FileBrowser password for user 'dev': " FILEBROWSER_PASSWORD
  echo
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== 1/8 — Installation de FileBrowser ==="
curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

echo "=== 2/8 — Configuration de FileBrowser ==="
mkdir -p /etc/filebrowser
filebrowser config init --database /etc/filebrowser/filebrowser.db
filebrowser config set \
  --database /etc/filebrowser/filebrowser.db \
  --root /home/debian/minecraft/server/test \
  --address 127.0.0.1 \
  --port 8081 \
  --locale fr \
  --branding.name "MatCraft Files" \
  --branding.files /etc/filebrowser/branding
# Note: FileBrowser requires min 12 char passwords
filebrowser users add dev "$FILEBROWSER_PASSWORD" \
  --database /etc/filebrowser/filebrowser.db \
  --perm.admin \
  --locale fr

echo "=== 3/8 — Theme MatCraft (branding) ==="
mkdir -p /etc/filebrowser/branding
cp "$SCRIPT_DIR/filebrowser-branding/custom.css" /etc/filebrowser/branding/
cp "$SCRIPT_DIR/filebrowser-branding/theme-toggle.js" /etc/filebrowser/branding/
echo "Branding files copied to /etc/filebrowser/branding/"

echo "=== 4/8 — Installation de nginx (proxy pour injection JS) ==="
apt-get update -qq
apt-get install -y nginx

# WebSocket upgrade map (needed in http context)
cat > /etc/nginx/conf.d/websocket-upgrade.conf <<'WSEOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
WSEOF

# Remove default nginx site to free port 80 (we don't use it)
rm -f /etc/nginx/sites-enabled/default

# FileBrowser reverse proxy config
# nginx on :8080 → FileBrowser on :8081
# Injects theme-toggle.js into HTML responses via sub_filter
cat > /etc/nginx/sites-available/filebrowser <<'NGXEOF'
server {
    listen 127.0.0.1:8080;
    server_name _;

    client_max_body_size 10G;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (terminal, real-time updates)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Disable compression so sub_filter can process the response
        proxy_set_header Accept-Encoding "";

        # Inject theme scripts into HTML <head>:
        # 1. Inline script: applies dark class immediately (prevents flash of white)
        # 2. External script: creates the toggle button + handles persistence
        sub_filter '</head>' '<script>try{var t=localStorage.getItem("filebrowser-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");if(t==="dark")document.documentElement.classList.add("theme-dark")}catch(e){}</script><script defer src="/static/theme-toggle.js"></script></head>';
        sub_filter_once on;
        sub_filter_types text/html;
    }
}
NGXEOF

ln -sf /etc/nginx/sites-available/filebrowser /etc/nginx/sites-enabled/
nginx -t
echo "nginx configure: 127.0.0.1:8080 -> FileBrowser :8081"

echo "=== 5/8 — Services systemd ==="
cat > /etc/systemd/system/filebrowser.service <<SVCEOF
[Unit]
Description=FileBrowser
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/filebrowser --database /etc/filebrowser/filebrowser.db
Restart=on-failure

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable filebrowser nginx
systemctl restart filebrowser
systemctl restart nginx
echo "FileBrowser sur :8081, nginx sur :8080"

echo "=== 6/8 — Installation de cloudflared ==="
if ! command -v cloudflared &>/dev/null; then
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
else
  echo "cloudflared deja installe: $(cloudflared --version)"
fi

echo "=== 7/8 — Connexion a Cloudflare ==="
echo ">>> Un lien va s'afficher. Ouvre-le dans ton navigateur pour autoriser le domaine matcraft-mc.com. <<<"
cloudflared tunnel login

echo "=== 7b/8 — Creation du tunnel ==="
cloudflared tunnel create matcraft-files

# Recuperer le TUNNEL_ID automatiquement
TUNNEL_ID=$(cloudflared tunnel list | grep matcraft-files | awk '{print $1}')
CRED_FILE="/root/.cloudflared/${TUNNEL_ID}.json"

echo "Tunnel ID: $TUNNEL_ID"

mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<CFGEOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: sftp.matcraft-mc.com
    service: http://127.0.0.1:8080
  - service: http_status:404
CFGEOF

echo "=== 8/8 — DNS + Service tunnel ==="
# Ajouter le CNAME manuellement dans Cloudflare Dashboard pour matcraft-mc.com:
#   Type: CNAME | Nom: sftp | Cible: <TUNNEL_ID>.cfargotunnel.com | Proxy: active
# Ou si le cert.pem autorise matcraft-mc.com:
cloudflared tunnel route dns matcraft-files sftp.matcraft-mc.com

# Si cloudflared service existe deja, restart; sinon install
if systemctl list-unit-files | grep -q cloudflared.service; then
  systemctl restart cloudflared
else
  cloudflared service install
  systemctl enable cloudflared
  systemctl start cloudflared
fi

echo ""
echo "========================================"
echo "  TERMINE !"
echo "  URL    : https://sftp.matcraft-mc.com"
echo "  User   : dev"
echo "  Mot de passe : ****"
echo "  Dossier: /home/debian/minecraft/server/test"
echo ""
echo "  Architecture:"
echo "    Cloudflare Tunnel -> nginx :8080 -> FileBrowser :8081"
echo "    Theme toggle: clic sur le bouton en bas a droite"
echo "========================================"
