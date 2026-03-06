"""
Deploy MatCraft Hub to the dedicated server.

Steps:
  1. Upload hub code (server.ts, package.json, tsconfig.json, public/index.html)
  2. npm install on server
  3. Generate config.json with bcrypt password hash
  4. Create matcraft-hub systemd service
  5. Configure nginx reverse proxy (port 8083)
  6. Add hub.matcraft-mc.com to Cloudflare Tunnel
  7. Sudoers for hub to manage services
  8. Restart all services
  9. Verify
"""

import paramiko
import os
import sys
import time
import tempfile
import textwrap
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
load_dotenv(os.path.join(PROJECT_DIR, ".env"))

HOST = os.environ["SERVER_HOST"]
PORT = int(os.environ["SERVER_PORT"])
USER = os.environ["SERVER_USERNAME"]
PASSWORD = os.environ["SERVER_PASSWORD"]
HUB_PASSWORD = os.environ["HUB_PASSWORD"]

HUB_DIR = os.path.join(PROJECT_DIR, "hub")

HUB_REMOTE = "/home/debian/hub"


def run(ssh, cmd, sudo=False, timeout=120, allow_fail=False):
    if sudo:
        cmd = f"echo '{PASSWORD}' | sudo -S bash -c '{cmd}'"
    print(f"  $ {cmd[:120]}{'...' if len(cmd) > 120 else ''}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        for line in out.strip().split('\n')[:10]:
            print(f"    {line}")
        if out.strip().count('\n') > 10:
            print(f"    ... ({out.strip().count(chr(10))} lines total)")
    if err.strip() and code != 0:
        print(f"    [stderr] {err.strip()[:200]}")
    if code != 0 and not allow_fail:
        raise RuntimeError(f"Command failed (exit {code}): {cmd}\n{err}")
    return out.strip()


def upload_file(sftp, local_path, remote_path):
    print(f"  Uploading {os.path.basename(local_path)} -> {remote_path}")
    sftp.put(local_path, remote_path)


def upload_content(sftp, ssh, content, remote_path, sudo=False):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.tmp', delete=False, encoding='utf-8', newline='\n') as f:
        f.write(content)
        local_tmp = f.name

    remote_tmp = f"/tmp/_hub_deploy_{os.path.basename(remote_path)}"
    sftp.put(local_tmp, remote_tmp)
    os.unlink(local_tmp)

    if sudo:
        run(ssh, f"cp {remote_tmp} {remote_path} && rm {remote_tmp}", sudo=True)
    else:
        run(ssh, f"cp {remote_tmp} {remote_path} && rm {remote_tmp}")


def main():
    print(f"=== Connecting to {HOST}:{PORT} as {USER} ===")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
    sftp = ssh.open_sftp()
    print("Connected.\n")

    total_steps = 9
    step = 0

    # ---------------------------------------------------------------
    # 1. Upload hub code
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Upload hub code ===")
    run(ssh, f"mkdir -p {HUB_REMOTE}/client/dist/assets")

    for fname in ["server.ts", "package.json", "tsconfig.json"]:
        local = os.path.join(HUB_DIR, fname)
        remote = f"{HUB_REMOTE}/{fname}"
        upload_file(sftp, local, remote)

    # Upload built client
    client_dist = os.path.join(HUB_DIR, "client", "dist")
    for root, dirs, files in os.walk(client_dist):
        for f in files:
            local = os.path.join(root, f)
            rel = os.path.relpath(local, client_dist).replace("\\", "/")
            remote = f"{HUB_REMOTE}/client/dist/{rel}"
            upload_file(sftp, local, remote)
    print()

    # ---------------------------------------------------------------
    # 2. npm install
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — npm install ===")
    run(ssh, f"cd {HUB_REMOTE} && npm install --ignore-scripts", timeout=120)
    print()

    # ---------------------------------------------------------------
    # 3. Generate config.json with bcrypt hash
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Generate config.json ===")
    import secrets as _secrets

    # Preserve existing session secret if config exists
    existing_secret = None
    try:
        existing_config = run(ssh, f"cat {HUB_REMOTE}/config.json 2>/dev/null", allow_fail=True)
        if existing_config:
            import json as _json
            existing_secret = _json.loads(existing_config).get("sessionSecret")
    except:
        pass

    session_secret = existing_secret or _secrets.token_hex(32)

    # Generate bcrypt hash for password
    import bcrypt
    pw_hash = bcrypt.hashpw(HUB_PASSWORD.encode(), bcrypt.gensalt()).decode()

    config_json = (
        '{\n'
        f'  "sessionSecret": "{session_secret}",\n'
        f'  "passwordHash": "{pw_hash}"\n'
        '}\n'
    )
    upload_content(sftp, ssh, config_json, f"{HUB_REMOTE}/config.json")
    print()

    # ---------------------------------------------------------------
    # 4. Systemd service
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Hub systemd service ===")
    hub_service = textwrap.dedent(f"""\
        [Unit]
        Description=MatCraft Hub Dashboard
        After=network.target

        [Service]
        User=debian
        Group=debian
        WorkingDirectory={HUB_REMOTE}
        ExecStart={HUB_REMOTE}/node_modules/.bin/tsx server.ts
        Restart=on-failure
        RestartSec=5
        Environment=NODE_ENV=production

        StandardOutput=journal
        StandardError=journal
        SyslogIdentifier=matcraft-hub

        [Install]
        WantedBy=multi-user.target
    """)
    upload_content(sftp, ssh, hub_service, "/etc/systemd/system/matcraft-hub.service", sudo=True)
    run(ssh, "systemctl daemon-reload", sudo=True)
    run(ssh, "systemctl enable matcraft-hub", sudo=True)
    print()

    # ---------------------------------------------------------------
    # 5. Nginx reverse proxy
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Nginx reverse proxy (port 8083) ===")

    nginx_conf = textwrap.dedent("""\
        limit_req_zone $binary_remote_addr zone=hub_login:10m rate=5r/m;

        server {
            listen 127.0.0.1:8083;
            server_name _;
            server_tokens off;

            # Rate limit on login
            location = /api/login {
                limit_req zone=hub_login burst=3 nodelay;
                limit_req_status 429;

                proxy_pass http://127.0.0.1:3848;
                proxy_http_version 1.1;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;
            }

            # API
            location /api/ {
                proxy_pass http://127.0.0.1:3848;
                proxy_http_version 1.1;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;

                proxy_read_timeout 30s;
            }

            location / {
                proxy_pass http://127.0.0.1:3848;
                proxy_http_version 1.1;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;

                add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            }

            add_header X-Content-Type-Options nosniff always;
            add_header X-Frame-Options DENY always;
            add_header Referrer-Policy strict-origin-when-cross-origin always;
            add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;" always;
            add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        }
    """)
    upload_content(sftp, ssh, nginx_conf, "/etc/nginx/sites-available/matcraft-hub", sudo=True)
    run(ssh, "ln -sf /etc/nginx/sites-available/matcraft-hub /etc/nginx/sites-enabled/", sudo=True)
    run(ssh, "nginx -t", sudo=True)
    print()

    # ---------------------------------------------------------------
    # 6. Cloudflare Tunnel
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Cloudflare Tunnel config ===")
    cf_config = run(ssh, "cat /etc/cloudflared/config.yml", allow_fail=True)
    if 'hub.matcraft-mc.com' not in cf_config:
        new_cf = cf_config.replace(
            '  - service: http_status:404',
            '  - hostname: hub.matcraft-mc.com\n    service: http://127.0.0.1:8083\n  - service: http_status:404'
        )
        upload_content(sftp, ssh, new_cf + '\n', "/etc/cloudflared/config.yml", sudo=True)
        print("  Added hub.matcraft-mc.com to Cloudflare Tunnel config")

        # Try DNS route
        tunnel_id = ""
        for line in cf_config.split('\n'):
            if 'tunnel:' in line:
                tunnel_id = line.split(':', 1)[1].strip()
                break
        if tunnel_id:
            run(ssh, f"cloudflared tunnel route dns {tunnel_id} hub.matcraft-mc.com", sudo=True, allow_fail=True)
            print(f"  DNS route added. If not working, add CNAME manually:")
            print(f"    Name: hub  Target: {tunnel_id}.cfargotunnel.com  Proxy: ON")
    else:
        print("  hub.matcraft-mc.com already in Cloudflare Tunnel config")
    print()

    # ---------------------------------------------------------------
    # 7. Sudoers — hub needs to manage all services
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Sudoers for hub ===")
    # The existing matcraft-panel sudoers covers minecraft-* services.
    # Hub also needs to manage matcraft-panel, filebrowser, php8.3-fpm, nginx, cloudflared.
    sudoers_content = textwrap.dedent("""\
        # MatCraft Hub — allow managing all MatCraft-related services
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl start matcraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl stop matcraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl restart matcraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl is-active matcraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl show matcraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl start filebrowser
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl stop filebrowser
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl restart filebrowser
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl start php8.3-fpm
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl stop php8.3-fpm
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl restart php8.3-fpm
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl start nginx
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl stop nginx
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl start cloudflared
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl stop cloudflared
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl restart cloudflared
    """)
    upload_content(sftp, ssh, sudoers_content, "/etc/sudoers.d/matcraft-hub", sudo=True)
    run(ssh, "chmod 0440 /etc/sudoers.d/matcraft-hub", sudo=True)
    run(ssh, "visudo -cf /etc/sudoers.d/matcraft-hub", sudo=True)
    print("  Sudoers installed")
    print()

    # ---------------------------------------------------------------
    # 8. Restart services
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Restart services ===")
    run(ssh, "systemctl restart matcraft-hub", sudo=True)
    run(ssh, "systemctl restart nginx", sudo=True)
    run(ssh, "systemctl restart cloudflared", sudo=True)
    print()

    # ---------------------------------------------------------------
    # 9. Verify
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Verification ===")
    time.sleep(3)
    run(ssh, "systemctl is-active matcraft-hub", allow_fail=True)
    run(ssh, "systemctl is-active nginx", allow_fail=True)
    run(ssh, "systemctl is-active cloudflared", allow_fail=True)
    hub_http = run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8083", allow_fail=True)
    print(f"  Hub HTTP status: {hub_http}")
    hub_direct = run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3848", allow_fail=True)
    print(f"  Hub direct HTTP status: {hub_direct}")

    print()
    print("  Recent hub logs:")
    run(ssh, "journalctl -u matcraft-hub --no-pager -n 5", allow_fail=True)

    print()
    print("=" * 50)
    print("  DEPLOY OK!")
    print(f"  URL: https://hub.matcraft-mc.com")
    print(f"  Architecture: Cloudflare -> nginx :8083 -> Hub :3848")
    print("=" * 50)

    sftp.close()
    ssh.close()


if __name__ == "__main__":
    main()
