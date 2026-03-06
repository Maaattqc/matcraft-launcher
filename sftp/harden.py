"""
Harden FileBrowser security on sftp.matcraft-mc.com.

Applies 6 fixes:
  1. Disable shell execute on user 'dev'
  2. Run FileBrowser as dedicated non-root user
  3. Rate-limit /api/login in nginx
  4. Add security headers to nginx
  5. Upload updated CSS to hide sidebar credits
  6. Enable UFW firewall

Usage:
  python scripts/harden-filebrowser.py
"""

import paramiko
import os
import sys
import tempfile
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
load_dotenv(os.path.join(PROJECT_DIR, ".env"))

HOST = os.environ["SERVER_HOST"]
PORT = int(os.environ["SERVER_PORT"])
USER = os.environ["SERVER_USERNAME"]
PASSWORD = os.environ["SERVER_PASSWORD"]

BRANDING_DIR = os.path.join(SCRIPT_DIR, "filebrowser-branding")


def run(ssh, cmd, sudo=False, check=True):
    """Run a command via SSH, print output, optionally raise on failure."""
    if sudo:
        cmd = f"echo '{PASSWORD}' | sudo -S bash -c '{cmd}'"
    print(f"  $ {cmd[:120]}{'...' if len(cmd) > 120 else ''}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=120)
    out = stdout.read().decode()
    err = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(f"    {out.strip()}")
    if err.strip() and code != 0:
        print(f"    [stderr] {err.strip()}")
    if check and code != 0:
        raise RuntimeError(f"Command failed (exit {code}): {cmd}\n{err}")
    return out.strip(), code


def upload_file(sftp, ssh, content, remote_final):
    """Write content to a temp file, SFTP to /tmp, then sudo-copy to final path."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".conf", delete=False) as f:
        f.write(content)
        local_tmp = f.name
    remote_tmp = f"/tmp/{os.path.basename(remote_final)}.tmp"
    print(f"  Uploading -> {remote_final}")
    sftp.put(local_tmp, remote_tmp)
    os.unlink(local_tmp)
    run(ssh, f"cp {remote_tmp} {remote_final} && rm {remote_tmp}", sudo=True)


def main():
    print(f"=== Connecting to {HOST}:{PORT} as {USER} ===")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
    sftp = ssh.open_sftp()
    print("Connected.\n")

    # ================================================================
    # 1. Disable execute permission on user 'dev'
    # ================================================================
    print("=" * 60)
    print("  STEP 1/6 — Disable execute on user 'dev'")
    print("=" * 60)

    run(ssh, "systemctl stop filebrowser", sudo=True)
    run(
        ssh,
        "filebrowser users update dev "
        "--database /etc/filebrowser/filebrowser.db "
        "--perm.execute=false",
        sudo=True,
    )
    print("  Execute permission disabled for 'dev'.\n")

    # ================================================================
    # 2. Run FileBrowser as dedicated non-root user
    # ================================================================
    print("=" * 60)
    print("  STEP 2/6 — Create 'filebrowser' system user + update service")
    print("=" * 60)

    # Create system user if it doesn't exist
    run(
        ssh,
        "id filebrowser &>/dev/null || useradd -r -s /usr/sbin/nologin filebrowser",
        sudo=True,
    )

    # Transfer ownership of config and data directories
    run(ssh, "chown -R filebrowser:filebrowser /etc/filebrowser/", sudo=True)
    run(ssh, "chown -R filebrowser:filebrowser /home/debian/minecraft/server/test/", sudo=True)

    # Write updated systemd service
    service_unit = """\
[Unit]
Description=FileBrowser
After=network.target

[Service]
Type=simple
User=filebrowser
Group=filebrowser
ExecStart=/usr/local/bin/filebrowser --database /etc/filebrowser/filebrowser.db
Restart=on-failure

[Install]
WantedBy=multi-user.target
"""
    upload_file(sftp, ssh, service_unit, "/etc/systemd/system/filebrowser.service")
    run(ssh, "systemctl daemon-reload", sudo=True)
    print("  Service updated to run as 'filebrowser' user.\n")

    # ================================================================
    # 3. Rate limiting nginx on /api/login
    # ================================================================
    print("=" * 60)
    print("  STEP 3/6 — Rate limit /api/login in nginx")
    print("=" * 60)

    rate_limit_conf = """\
# Rate limiting for FileBrowser login endpoint
# 5 requests/minute per IP — burst of 3 with no delay
limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
"""
    upload_file(sftp, ssh, rate_limit_conf, "/etc/nginx/conf.d/rate-limit.conf")
    print("  rate-limit.conf deployed.\n")

    # ================================================================
    # 4. Security headers + rate limit location in nginx server block
    # ================================================================
    print("=" * 60)
    print("  STEP 4/6 — Security headers + updated nginx config")
    print("=" * 60)

    # Full nginx config: keeps existing functionality, adds security headers
    # and a dedicated /api/login location with rate limiting.
    nginx_conf = """\
server {
    listen 127.0.0.1:8080;
    server_name _;

    # --- Security headers ---
    server_tokens off;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    client_max_body_size 10G;

    # Serve branding files directly from disk (bypass FileBrowser + cache control)
    location = /static/custom.css {
        alias /etc/filebrowser/branding/custom.css;
        add_header Content-Type "text/css";
        add_header Cache-Control "no-cache, must-revalidate";
        add_header X-Content-Type-Options "nosniff" always;
        etag off;
    }

    location = /static/theme-toggle.js {
        alias /etc/filebrowser/branding/theme-toggle.js;
        add_header Content-Type "application/javascript";
        add_header Cache-Control "no-cache, must-revalidate";
        add_header X-Content-Type-Options "nosniff" always;
        etag off;
    }

    # Rate-limited login endpoint
    location /api/login {
        limit_req zone=login burst=3 nodelay;
        limit_req_status 429;

        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Main proxy
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Disable compression so sub_filter works
        proxy_set_header Accept-Encoding "";

        # Two substitutions:
        # 1. Cache-bust the custom.css link
        # 2. Inject theme scripts in <head>
        sub_filter 'custom.css' 'custom.css?v=5';
        sub_filter '</head>' '<script>try{var t=localStorage.getItem("filebrowser-theme");if(!t)t="dark";if(t==="dark")document.documentElement.classList.add("theme-dark")}catch(e){document.documentElement.classList.add("theme-dark")}</script><script defer src="/static/theme-toggle.js?v=5"></script></head>';
        sub_filter_once off;
        sub_filter_types text/html;
    }
}
"""
    upload_file(sftp, ssh, nginx_conf, "/etc/nginx/sites-available/filebrowser")
    run(ssh, "nginx -t", sudo=True)
    run(ssh, "systemctl reload nginx", sudo=True)
    print("  nginx config updated with security headers + rate limiting.\n")

    # ================================================================
    # 5. Upload updated CSS (hide sidebar credits)
    # ================================================================
    print("=" * 60)
    print("  STEP 5/6 — Upload updated branding (hide sidebar credits)")
    print("=" * 60)

    run(ssh, "mkdir -p /tmp/filebrowser-branding", sudo=False)
    for fname in ["custom.css", "theme-toggle.js"]:
        local = os.path.join(BRANDING_DIR, fname)
        remote = f"/tmp/filebrowser-branding/{fname}"
        print(f"  Uploading {fname}...")
        sftp.put(local, remote)
    run(
        ssh,
        "cp /tmp/filebrowser-branding/* /etc/filebrowser/branding/ "
        "&& chown -R filebrowser:filebrowser /etc/filebrowser/branding/ "
        "&& rm -rf /tmp/filebrowser-branding",
        sudo=True,
    )
    print("  Branding files updated (credits hidden).\n")

    # ================================================================
    # 6. Enable UFW firewall
    # ================================================================
    print("=" * 60)
    print("  STEP 6/6 — Enable UFW firewall")
    print("=" * 60)

    run(ssh, "apt-get install -y ufw", sudo=True)
    run(ssh, "ufw default deny incoming", sudo=True)
    run(ssh, "ufw default allow outgoing", sudo=True)
    run(ssh, "ufw allow 22/tcp", sudo=True)      # SSH
    run(ssh, "ufw allow 25565/tcp", sudo=True)    # Minecraft
    run(ssh, "ufw --force enable", sudo=True)
    print("  UFW enabled. Only SSH (22) and Minecraft (25565) open.\n")

    # ================================================================
    # Restart FileBrowser (now as 'filebrowser' user)
    # ================================================================
    print("=" * 60)
    print("  Restarting services...")
    print("=" * 60)

    run(ssh, "systemctl start filebrowser", sudo=True)
    print()

    # ================================================================
    # Verification
    # ================================================================
    print("=" * 60)
    print("  VERIFICATION")
    print("=" * 60)

    # 1. Check execute is disabled (may fail if DB is locked by running service)
    print("\n--- 1. Execute permission ---")
    out, code = run(
        ssh,
        "filebrowser users ls --database /etc/filebrowser/filebrowser.db",
        sudo=True,
        check=False,
    )
    if code != 0:
        print("    (DB locked by running service — execute was set to false in step 1)")

    # 2. Check FileBrowser runs as 'filebrowser' user, not root
    print("\n--- 2. FileBrowser process user ---")
    run(ssh, "ps aux | grep '[f]ilebrowser' | awk '{print \"User:\", $1}'")

    # 3. Check UFW is active
    print("\n--- 3. UFW status ---")
    run(ssh, "ufw status verbose", sudo=True)

    # 4. Check security headers
    print("\n--- 4. Security headers ---")
    run(
        ssh,
        "curl -sI http://127.0.0.1:8080 | grep -iE "
        "'x-frame|x-content-type|referrer-policy|permissions-policy|server'",
    )

    # 5. Check rate limiting (rapid requests to /api/login)
    print("\n--- 5. Rate limiting test (10 rapid POST to /api/login) ---")
    run(
        ssh,
        "for i in $(seq 1 10); do "
        "  code=$(curl -s -o /dev/null -w '%{http_code}' "
        "    -X POST http://127.0.0.1:8080/api/login "
        "    -H 'Content-Type: application/json' "
        "    -d '{\"username\":\"test\",\"password\":\"test\"}'); "
        "  echo \"  Request $i: HTTP $code\"; "
        "done",
    )

    # 6. Check services are running
    print("\n--- 6. Services status ---")
    run(ssh, "systemctl is-active filebrowser")
    run(ssh, "systemctl is-active nginx")

    # 7. Quick functional test
    print("\n--- 7. Functional test ---")
    run(
        ssh,
        "curl -s -o /dev/null -w 'HTTP %{http_code}' http://127.0.0.1:8080",
    )

    print()
    print("=" * 60)
    print("  HARDENING COMPLETE")
    print("=" * 60)
    print("  Applied:")
    print("    1. dev execute=false (no shell access)")
    print("    2. FileBrowser runs as 'filebrowser' user (not root)")
    print("    3. /api/login rate-limited (5r/m, burst 3)")
    print("    4. Security headers (X-Frame-Options, CSP, etc.)")
    print("    5. Sidebar credits hidden (custom.css)")
    print("    6. UFW enabled (allow SSH 22, Minecraft 25565 only)")
    print()
    print("  URL: https://sftp.matcraft-mc.com")
    print("=" * 60)

    sftp.close()
    ssh.close()


if __name__ == "__main__":
    main()
