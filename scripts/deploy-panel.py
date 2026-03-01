"""
Deploy MatCraft Staff Panel + migrate Minecraft screens to systemd.

Steps:
  1. Install Node.js 20 LTS if absent
  2. Upload panel code (server.ts, package.json, public/index.html)
  3. npm install --production on server
  4. Generate config.json with bcrypt hash for 'dev' user
  5. Create matcraft-panel systemd service
  6. Configure nginx reverse proxy (port 8082, rate limit via CF-Connecting-IP, security headers, WebSocket)
  6b. Sudoers restriction for minecraft-* systemctl commands
  7. Migrate screen-based Minecraft servers to systemd
  8. Add panel.matcraft-mc.com to Cloudflare Tunnel
  9. Route DNS via cloudflared
 10. Restart all services
 11. Verify deployment
"""

import paramiko
import os
import sys
import time
import tempfile
import textwrap
import re

HOST = "147.135.138.58"
PORT = 22
USER = "debian"
PASSWORD = "NNFjZ3enYfj4OyC3"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
PANEL_DIR = os.path.join(PROJECT_DIR, "panel")

PANEL_USER = "admin"
PANEL_PASSWORD = "123minecraft123$$"

MC_BASE = "/home/debian/minecraft"
PANEL_REMOTE = "/home/debian/panel"


def run(ssh, cmd, sudo=False, timeout=120, allow_fail=False):
    """Run a command via SSH, print output, raise on failure."""
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
    """Upload a local file via SFTP."""
    print(f"  Uploading {os.path.basename(local_path)} -> {remote_path}")
    sftp.put(local_path, remote_path)


def upload_content(sftp, ssh, content, remote_path, sudo=False):
    """Upload string content to a remote file via SFTP + sudo cp."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.tmp', delete=False, encoding='utf-8', newline='\n') as f:
        f.write(content)
        local_tmp = f.name

    remote_tmp = f"/tmp/_panel_deploy_{os.path.basename(remote_path)}"
    sftp.put(local_tmp, remote_tmp)
    os.unlink(local_tmp)

    if sudo:
        run(ssh, f"cp {remote_tmp} {remote_path} && rm {remote_tmp}", sudo=True)
    else:
        run(ssh, f"cp {remote_tmp} {remote_path} && rm {remote_tmp}")


# ---------------------------------------------------------------------------
# Minecraft server discovery (remote)
# ---------------------------------------------------------------------------

def discover_servers(ssh):
    """Discover Minecraft servers from start.sh files on the remote server."""
    out = run(ssh, f"ls -1 {MC_BASE}/", allow_fail=True)
    if not out:
        return []

    servers = []
    for name in out.split('\n'):
        name = name.strip()
        if not name or name.startswith('--'):
            continue

        start_sh = f"{MC_BASE}/{name}/start.sh"
        try:
            script = run(ssh, f"cat {start_sh}", allow_fail=True)
        except:
            continue
        if not script:
            continue

        server = parse_start_script(name, script)
        if server:
            servers.append(server)

    return servers


def parse_start_script(name, script):
    """Parse start.sh to extract server config."""
    jar_m = re.search(r'SERVER_JAR=["\'"]?([^\s"\']+)', script)
    screen_m = re.search(r'SCREEN_NAME=["\'"]?([^\s"\']+)', script)
    min_mem_m = re.search(r'MIN_MEMORY=["\'"]?([^\s"\']+)', script)
    max_mem_m = re.search(r'MAX_MEMORY=["\'"]?([^\s"\']+)', script)

    jar = jar_m.group(1) if jar_m else None
    if not jar:
        return None

    # Detect type
    lower = jar.lower()
    if 'fabric' in lower:
        stype = 'Fabric'
    elif 'purpur' in lower:
        stype = 'Purpur'
    elif 'velocity' in lower:
        stype = 'Velocity'
    elif 'paper' in lower:
        stype = 'Paper'
    else:
        stype = 'Vanilla'

    # Extract JVM args from the java command line
    jvm_args = extract_jvm_args(script)

    return {
        'name': name,
        'jar': jar,
        'type': stype,
        'screen': screen_m.group(1) if screen_m else name,
        'min_memory': min_mem_m.group(1) if min_mem_m else '1G',
        'max_memory': max_mem_m.group(1) if max_mem_m else '2G',
        'jvm_args': jvm_args,
    }


def extract_jvm_args(script):
    """Extract extra JVM flags from the java command in start.sh."""
    # Look for flags like -XX:+UseG1GC, -Dlog4j2.formatMsgNoLookups=true, etc.
    args = []
    for m in re.finditer(r'(-XX:[^\s"]+|-D[^\s"]+)', script):
        args.append(m.group(1))
    return ' '.join(args)


# ---------------------------------------------------------------------------
# systemd service generation
# ---------------------------------------------------------------------------

def generate_mc_service(server):
    """Generate a systemd service unit for a Minecraft server."""
    name = server['name']
    jar = server['jar']
    min_mem = server['min_memory']
    max_mem = server['max_memory']
    jvm_args = server['jvm_args']

    # Calculate MemoryMax = max_memory + 1G headroom
    max_gb = parse_memory_gb(max_mem)
    mem_limit = f"{max_gb + 1}G"

    # Velocity uses different nogui
    if server['type'] == 'Velocity':
        jar_args = f"-jar {jar}"
    else:
        jar_args = f"-jar {jar} nogui"

    return textwrap.dedent(f"""\
        [Unit]
        Description=MatCraft {name.capitalize()} Server
        After=network.target

        [Service]
        User=debian
        Group=debian
        WorkingDirectory={MC_BASE}/{name}
        ExecStart=/usr/bin/java -Xms{min_mem} -Xmx{max_mem} {jvm_args} {jar_args}
        ExecStop=/bin/kill -SIGTERM $MAINPID
        Restart=on-failure
        RestartSec=10
        SuccessExitStatus=0 130 143

        MemoryMax={mem_limit}
        StandardOutput=journal
        StandardError=journal
        SyslogIdentifier=minecraft-{name}

        [Install]
        WantedBy=multi-user.target
    """).strip() + '\n'


def parse_memory_gb(mem_str):
    """Parse memory string like '4G' or '512M' to GB (int)."""
    mem_str = mem_str.upper().strip()
    if mem_str.endswith('G'):
        return int(mem_str[:-1])
    if mem_str.endswith('M'):
        return max(1, int(mem_str[:-1]) // 1024)
    return 2  # default


# ---------------------------------------------------------------------------
# Main deploy
# ---------------------------------------------------------------------------

def main():
    print(f"=== Connecting to {HOST}:{PORT} as {USER} ===")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
    sftp = ssh.open_sftp()
    print("Connected.\n")

    total_steps = 11
    step = 0

    # ---------------------------------------------------------------
    # 1. Install Node.js 20 LTS
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Install Node.js 20 LTS (if needed) ===")
    node_check = run(ssh, "node --version 2>/dev/null || echo 'MISSING'", allow_fail=True)
    if 'MISSING' in node_check or not node_check.startswith('v'):
        print("  Node.js not found, installing...")
        run(ssh, "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs", sudo=True, timeout=180)
    else:
        print(f"  Node.js already installed: {node_check}")
    run(ssh, "node --version && npm --version")
    print()

    # ---------------------------------------------------------------
    # 2. Upload panel code
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Upload panel code ===")
    run(ssh, f"mkdir -p {PANEL_REMOTE}/public")

    for fname, subdir in [
        ("server.ts", ""),
        ("package.json", ""),
        ("tsconfig.json", ""),
        ("public/index.html", ""),
    ]:
        local = os.path.join(PANEL_DIR, fname)
        remote = f"{PANEL_REMOTE}/{fname}"
        upload_file(sftp, local, remote)
    print()

    # ---------------------------------------------------------------
    # 3. npm install
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — npm install ===")
    run(ssh, f"cd {PANEL_REMOTE} && npm install", timeout=120)
    print()

    # ---------------------------------------------------------------
    # 4. Generate config.json with bcrypt hash
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Generate config.json ===")
    # Preserve existing session secret if config.json already exists on server
    import secrets as _secrets
    existing_secret = None
    try:
        existing_config = run(ssh, f"cat {PANEL_REMOTE}/config.json 2>/dev/null", allow_fail=True)
        if existing_config:
            import json as _json
            existing_secret = _json.loads(existing_config).get("sessionSecret")
    except:
        pass
    session_secret = existing_secret or _secrets.token_hex(32)
    config_json = (
        '{\n'
        f'  "sessionSecret": "{session_secret}"\n'
        '}\n'
    )
    upload_content(sftp, ssh, config_json, f"{PANEL_REMOTE}/config.json")
    print()

    # ---------------------------------------------------------------
    # 5. Panel systemd service
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Panel systemd service ===")
    panel_service = textwrap.dedent("""\
        [Unit]
        Description=MatCraft Staff Panel
        After=network.target

        [Service]
        User=debian
        Group=debian
        WorkingDirectory=/home/debian/panel
        ExecStart=/home/debian/panel/node_modules/.bin/tsx server.ts
        Restart=on-failure
        RestartSec=5
        Environment=NODE_ENV=production

        StandardOutput=journal
        StandardError=journal
        SyslogIdentifier=matcraft-panel

        [Install]
        WantedBy=multi-user.target
    """)
    upload_content(sftp, ssh, panel_service, "/etc/systemd/system/matcraft-panel.service", sudo=True)
    run(ssh, "systemctl daemon-reload", sudo=True)
    run(ssh, "systemctl enable matcraft-panel", sudo=True)
    print()

    # ---------------------------------------------------------------
    # 6. Nginx reverse proxy
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Nginx reverse proxy (port 8082) ===")

    # Rate limit zone — use a separate conf.d file to avoid quoting issues with nginx.conf
    # Also clean up any broken lines from previous attempts
    run(ssh, "sed -i '/limit_req_zone.*panel_login/d' /etc/nginx/nginx.conf", sudo=True, allow_fail=True)
    # Use CF-Connecting-IP for rate limiting (all traffic comes through Cloudflare Tunnel,
    # so $binary_remote_addr is always 127.0.0.1 — rate limit would be global instead of per-client)
    ratelimit_conf = 'limit_req_zone $http_cf_connecting_ip zone=panel_login:10m rate=5r/m;\n'
    upload_content(sftp, ssh, ratelimit_conf, "/etc/nginx/conf.d/panel-ratelimit.conf", sudo=True)

    nginx_conf = textwrap.dedent("""\
        server {
            listen 127.0.0.1:8082;
            server_name _;
            server_tokens off;

            # Rate limit on login
            location = /api/login {
                limit_req zone=panel_login burst=3 nodelay;
                limit_req_status 429;

                proxy_pass http://127.0.0.1:3847;
                proxy_http_version 1.1;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;
            }

            # WebSocket
            location /ws {
                proxy_pass http://127.0.0.1:3847;
                proxy_http_version 1.1;
                proxy_set_header Upgrade $http_upgrade;
                proxy_set_header Connection $connection_upgrade;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;

                proxy_read_timeout 86400;
            }

            # Everything else — no-cache on HTML to prevent stale UI
            location / {
                proxy_pass http://127.0.0.1:3847;
                proxy_http_version 1.1;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;

                add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            }

            # Security headers
            add_header X-Content-Type-Options nosniff always;
            add_header X-Frame-Options DENY always;
            add_header Referrer-Policy strict-origin-when-cross-origin always;
            add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
            add_header Content-Security-Policy "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' https://mc-heads.net" always;
            add_header X-XSS-Protection "1; mode=block" always;
        }
    """)
    upload_content(sftp, ssh, nginx_conf, "/etc/nginx/sites-available/matcraft-panel", sudo=True)
    run(ssh, "ln -sf /etc/nginx/sites-available/matcraft-panel /etc/nginx/sites-enabled/", sudo=True)
    # Also fix FileBrowser rate limit to use CF-Connecting-IP (same issue)
    try:
        fb_check = run(ssh, "grep -c binary_remote_addr /etc/nginx/conf.d/rate-limit.conf 2>/dev/null || echo 0", allow_fail=True)
        if fb_check and fb_check.strip() != '0':
            # sed inside bash -c single-quotes: $ is literal, avoid nested single-quotes
            run(ssh, "sed -i s/binary_remote_addr/http_cf_connecting_ip/g /etc/nginx/conf.d/rate-limit.conf", sudo=True)
            print("  Fixed FileBrowser rate-limit.conf to use CF-Connecting-IP")
    except:
        print("  Skipped FileBrowser rate-limit fix (file not found or not readable)")

    run(ssh, "nginx -t", sudo=True)
    print()

    # ---------------------------------------------------------------
    # 6b. Sudoers restriction for panel
    # ---------------------------------------------------------------
    print(f"  --- Sudoers restriction for minecraft-* systemctl ---")
    sudoers_content = textwrap.dedent("""\
        # MatCraft Panel — restrict systemctl commands to minecraft-* services only
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl start minecraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl stop minecraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl restart minecraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl is-active minecraft-*
        debian ALL=(root) NOPASSWD: /usr/bin/systemctl show minecraft-*
    """)
    upload_content(sftp, ssh, sudoers_content, "/etc/sudoers.d/matcraft-panel", sudo=True)
    run(ssh, "chmod 0440 /etc/sudoers.d/matcraft-panel", sudo=True)
    # Validate sudoers syntax
    run(ssh, "visudo -cf /etc/sudoers.d/matcraft-panel", sudo=True)
    print("  Sudoers restriction installed")
    print()

    # ---------------------------------------------------------------
    # 7. Migrate screen → systemd for Minecraft servers
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Migrate Minecraft screens to systemd ===")
    servers = discover_servers(ssh)
    print(f"  Discovered {len(servers)} servers")

    for s in servers:
        name = s['name']
        service_name = f"minecraft-{name}"
        service_path = f"/etc/systemd/system/{service_name}.service"

        print(f"\n  --- {name} ({s['type']}, {s['min_memory']}-{s['max_memory']}) ---")

        # Generate and upload service file
        service_content = generate_mc_service(s)
        upload_content(sftp, ssh, service_content, service_path, sudo=True)

        # Check if screen is running for this server
        screen_name = s['screen']
        screen_check = run(ssh, f"screen -ls 2>/dev/null | grep -c '\\.{screen_name}' || true", allow_fail=True)
        # grep -c returns a single number; take last non-empty line
        screen_count = screen_check.strip().split('\n')[-1].strip()
        screen_running = screen_count.isdigit() and int(screen_count) > 0

        if screen_running:
            print(f"  Stopping screen '{screen_name}'...")
            # Send stop command to Minecraft console
            run(ssh, f"screen -S {screen_name} -X stuff 'stop\\n'", allow_fail=True)
            # Wait for graceful shutdown
            print("  Waiting 30s for graceful shutdown...")
            time.sleep(30)
            # Kill screen if still alive
            run(ssh, f"screen -S {screen_name} -X quit 2>/dev/null || true", allow_fail=True)

        # Enable and start systemd service
        run(ssh, "systemctl daemon-reload", sudo=True)
        run(ssh, f"systemctl enable {service_name}", sudo=True)

        if screen_running:
            # Only start if it was previously running
            print(f"  Starting {service_name} via systemd...")
            run(ssh, f"systemctl start {service_name}", sudo=True)
            time.sleep(2)
            status = run(ssh, f"systemctl is-active {service_name}", allow_fail=True)
            print(f"  Status: {status}")
        else:
            print(f"  Service enabled but not started (was not running as screen)")

    print()

    # ---------------------------------------------------------------
    # 8. Cloudflare Tunnel config
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Cloudflare Tunnel config ===")

    # Check if panel entry already exists in cloudflared config
    cf_config = run(ssh, "cat /etc/cloudflared/config.yml", allow_fail=True)
    if 'panel.matcraft-mc.com' not in cf_config:
        # Insert panel rule before the catch-all 404 — rewrite the whole file via upload
        new_cf = cf_config.replace(
            '  - service: http_status:404',
            '  - hostname: panel.matcraft-mc.com\n    service: http://127.0.0.1:8082\n  - service: http_status:404'
        )
        upload_content(sftp, ssh, new_cf + '\n', "/etc/cloudflared/config.yml", sudo=True)
        print("  Added panel.matcraft-mc.com to Cloudflare Tunnel config")
    else:
        print("  panel.matcraft-mc.com already in Cloudflare Tunnel config")
    print()

    # ---------------------------------------------------------------
    # 9. DNS route
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Cloudflare DNS route ===")
    # The matcraft-mc.com zone is managed separately in Cloudflare.
    # The server's cloudflared cert only covers matfaction.com.
    # DNS CNAME must be added manually in Cloudflare dashboard.
    tunnel_id = ""
    for line in cf_config.split('\n'):
        if 'tunnel:' in line:
            tunnel_id = line.split(':', 1)[1].strip()
            break

    # Try automated route (works if cert covers the zone)
    if tunnel_id:
        run(ssh, f"cloudflared tunnel route dns {tunnel_id} panel.matcraft-mc.com", sudo=True, allow_fail=True)

    print(f"  If DNS is not resolving, add CNAME manually in Cloudflare:")
    print(f"    Name: panel")
    print(f"    Target: {tunnel_id}.cfargotunnel.com")
    print(f"    Proxy: ON (orange cloud)")
    print()

    # ---------------------------------------------------------------
    # 10. Restart services
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Restart services ===")
    run(ssh, "systemctl restart matcraft-panel", sudo=True)
    run(ssh, "systemctl restart nginx", sudo=True)
    run(ssh, "systemctl restart cloudflared", sudo=True)
    print()

    # ---------------------------------------------------------------
    # 11. Verify
    # ---------------------------------------------------------------
    step += 1
    print(f"=== {step}/{total_steps} — Verification ===")
    import time as _t
    _t.sleep(3)  # Give panel a moment to start
    run(ssh, "systemctl is-active matcraft-panel", allow_fail=True)
    run(ssh, "systemctl is-active nginx", allow_fail=True)
    run(ssh, "systemctl is-active cloudflared", allow_fail=True)
    panel_http = run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082", allow_fail=True)
    print(f"  Panel HTTP status: {panel_http}")

    # Check active Minecraft services
    active_count = 0
    for s in servers:
        status = run(ssh, f"systemctl is-active minecraft-{s['name']}", allow_fail=True)
        if status == 'active':
            active_count += 1
    print(f"  Active Minecraft services: {active_count}/{len(servers)}")
    print()

    # ---------------------------------------------------------------
    # Done
    # ---------------------------------------------------------------
    print("=" * 50)
    print("  DEPLOY OK!")
    print(f"  URL: https://panel.matcraft-mc.com")
    print(f"  Login: {PANEL_USER} / {PANEL_PASSWORD}")
    print(f"  Architecture: Cloudflare -> nginx :8082 -> Panel :3847")
    print(f"  Servers migrated: {len(servers)} (systemd)")
    print("=" * 50)

    sftp.close()
    ssh.close()


if __name__ == "__main__":
    main()
