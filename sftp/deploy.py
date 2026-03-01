"""
Deploy FileBrowser MatCraft theme to the server.
Uploads branding files, installs nginx, configures reverse proxy.
"""

import paramiko
import os
import sys
import time

HOST = "147.135.138.58"
PORT = 22
USER = "debian"
PASSWORD = "NNFjZ3enYfj4OyC3"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRANDING_DIR = os.path.join(SCRIPT_DIR, "branding")

def run(ssh, cmd, sudo=False):
    """Run a command via SSH, print output, raise on failure."""
    if sudo:
        cmd = f"echo '{PASSWORD}' | sudo -S bash -c '{cmd}'"
    print(f"  $ {cmd[:120]}{'...' if len(cmd) > 120 else ''}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=120)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(f"    {out.strip()}")
    if err.strip() and code != 0:
        print(f"    [stderr] {err.strip()}")
    if code != 0:
        raise RuntimeError(f"Command failed (exit {code}): {cmd}\n{err}")
    return out.strip()

def main():
    print(f"=== Connecting to {HOST}:{PORT} as {USER} ===")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
    sftp = ssh.open_sftp()
    print("Connected.\n")

    # --- 1. Upload branding files ---
    print("=== 1/5 — Upload branding files ===")
    run(ssh, "mkdir -p /tmp/filebrowser-branding", sudo=False)
    for fname in ["custom.css", "theme-toggle.js"]:
        local = os.path.join(BRANDING_DIR, fname)
        remote = f"/tmp/filebrowser-branding/{fname}"
        print(f"  Uploading {fname}...")
        sftp.put(local, remote)
    # Move to final location with sudo
    run(ssh, "mkdir -p /etc/filebrowser/branding && cp /tmp/filebrowser-branding/* /etc/filebrowser/branding/ && rm -rf /tmp/filebrowser-branding", sudo=True)
    print("  Branding files deployed.\n")

    # --- 2. Stop FileBrowser + update config ---
    print("=== 2/5 — Stop FileBrowser & update config (port 8081 + branding) ===")
    run(ssh, "systemctl stop filebrowser || true", sudo=True)
    run(ssh, "filebrowser config set --database /etc/filebrowser/filebrowser.db --port 8081 --branding.files /etc/filebrowser/branding", sudo=True)
    print()

    # --- 3. Install and configure nginx ---
    print("=== 3/5 — Install nginx ===")
    run(ssh, "apt-get update -qq && apt-get install -y nginx", sudo=True)
    print()

    print("=== 4/5 — Configure nginx reverse proxy ===")
    # Upload config files via SFTP (avoids shell quoting issues)
    import tempfile, textwrap

    ws_conf = textwrap.dedent("""\
        map $http_upgrade $connection_upgrade {
            default upgrade;
            '' close;
        }
    """)

    nginx_conf = textwrap.dedent("""\
        server {
            listen 127.0.0.1:8080;
            server_name _;
            server_tokens off;

            client_max_body_size 10G;

            # Serve theme-toggle.js directly (FileBrowser only auto-serves custom.css, not JS)
            location = /static/theme-toggle.js {
                alias /etc/filebrowser/branding/theme-toggle.js;
                default_type application/javascript;
                add_header Content-Type "application/javascript" always;
                add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            }

            location / {
                proxy_pass http://127.0.0.1:8081;
                proxy_http_version 1.1;

                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;

                proxy_set_header Upgrade $http_upgrade;
                proxy_set_header Connection $connection_upgrade;

                proxy_set_header Accept-Encoding "";

                # Strip FileBrowser cache headers (it sends max-age=86400)
                proxy_hide_header Cache-Control;

                # Inject dark theme inline + load toggle script (default to dark)
                sub_filter '</head>' '<script>try{var t=localStorage.getItem("filebrowser-theme")||"dark";if(t==="dark")document.documentElement.classList.add("dark","theme-dark")}catch(e){}</script><script defer src="/static/theme-toggle.js?v=8"></script></head>';
                sub_filter_once on;
                sub_filter_types text/html;

                # Security headers
                add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
                add_header X-XSS-Protection "1; mode=block" always;
                add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            }
        }
    """)

    # Write temp files and upload via SFTP
    for content, remote_tmp, final_path in [
        (ws_conf, "/tmp/ws-upgrade.conf", "/etc/nginx/conf.d/websocket-upgrade.conf"),
        (nginx_conf, "/tmp/fb-nginx.conf", "/etc/nginx/sites-available/filebrowser"),
    ]:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.conf', delete=False, newline='\n') as f:
            f.write(content)
            local_tmp = f.name
        print(f"  Uploading {final_path}...")
        sftp.put(local_tmp, remote_tmp)
        os.unlink(local_tmp)
        run(ssh, f"cp {remote_tmp} {final_path} && rm {remote_tmp}", sudo=True)

    # Remove default site, enable filebrowser site
    run(ssh, "rm -f /etc/nginx/sites-enabled/default", sudo=True)
    run(ssh, "ln -sf /etc/nginx/sites-available/filebrowser /etc/nginx/sites-enabled/", sudo=True)
    run(ssh, "nginx -t", sudo=True)
    print()

    # --- 5. Restart services ---
    print("=== 5/5 — Restart services ===")
    run(ssh, "systemctl restart filebrowser", sudo=True)
    run(ssh, "systemctl enable nginx && systemctl restart nginx", sudo=True)
    print()

    # Verify
    print("=== Verification ===")
    run(ssh, "systemctl is-active filebrowser", sudo=False)
    run(ssh, "systemctl is-active nginx", sudo=False)
    run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080", sudo=False)
    print()

    print("========================================")
    print("  DEPLOY OK!")
    print("  URL: https://sftp.matcraft-mc.com")
    print("  Architecture: Cloudflare -> nginx :8080 -> FileBrowser :8081")
    print("  Toggle dark mode: bouton en bas a droite")
    print("========================================")

    sftp.close()
    ssh.close()

if __name__ == "__main__":
    main()
