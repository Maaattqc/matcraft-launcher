"""Fix: serve custom.css directly via nginx + cache-bust in HTML + no-cache headers."""
import paramiko
import os
import tempfile

HOST = "147.135.138.58"
PORT = 22
USER = "debian"
PASSWORD = "NNFjZ3enYfj4OyC3"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
sftp = ssh.open_sftp()

def run(cmd, sudo=False):
    if sudo:
        cmd = f"echo '{PASSWORD}' | sudo -S bash -c '{cmd}'"
    print(f"  $ {cmd[:140]}{'...' if len(cmd) > 140 else ''}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=120)
    out = stdout.read().decode()
    err = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(f"    {out.strip()}")
    if err.strip() and code != 0:
        print(f"    [stderr] {err.strip()}")
    if code != 0:
        raise RuntimeError(f"Command failed (exit {code}): {err}")
    return out.strip()

# Updated nginx config:
# - Serve BOTH custom.css and theme-toggle.js directly from disk (bypass FileBrowser cache)
# - Add no-cache headers on branding files
# - sub_filter: replace custom.css with cache-busted version + inject theme script
nginx_conf = """\
server {
    listen 127.0.0.1:8080;
    server_name _;

    client_max_body_size 10G;

    # Serve branding files directly from disk (bypass FileBrowser + cache control)
    location = /static/custom.css {
        alias /etc/filebrowser/branding/custom.css;
        add_header Content-Type "text/css";
        add_header Cache-Control "no-cache, must-revalidate";
        etag off;
    }

    location = /static/theme-toggle.js {
        alias /etc/filebrowser/branding/theme-toggle.js;
        add_header Content-Type "application/javascript";
        add_header Cache-Control "no-cache, must-revalidate";
        etag off;
    }

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
        sub_filter 'custom.css' 'custom.css?v=4';
        sub_filter '</head>' '<script>try{var t=localStorage.getItem("filebrowser-theme");if(!t)t="dark";if(t==="dark")document.documentElement.classList.add("theme-dark")}catch(e){document.documentElement.classList.add("theme-dark")}</script><script defer src="/static/theme-toggle.js?v=4"></script></head>';
        sub_filter_once off;
        sub_filter_types text/html;
    }
}
"""

print("=== 1/2 — Upload new nginx config ===")
with tempfile.NamedTemporaryFile(mode='w', suffix='.conf', delete=False) as f:
    f.write(nginx_conf)
    tmp = f.name
sftp.put(tmp, "/tmp/fb-nginx.conf")
os.unlink(tmp)
run("cp /tmp/fb-nginx.conf /etc/nginx/sites-available/filebrowser && rm /tmp/fb-nginx.conf", sudo=True)

print("\n=== 2/2 — Test & reload nginx ===")
run("nginx -t", sudo=True)
run("systemctl reload nginx", sudo=True)

print("\n=== Verify ===")
# Check CSS is served fresh with correct content
run("curl -s -o /dev/null -w 'CSS direct: HTTP %{http_code} - %{size_download} bytes' http://127.0.0.1:8080/static/custom.css")
run("curl -s -o /dev/null -w 'CSS busted: HTTP %{http_code} - %{size_download} bytes' http://127.0.0.1:8080/static/custom.css?v=4")
# Check CSS has the variable overrides
run("curl -s http://127.0.0.1:8080/static/custom.css | grep -c 'surfacePrimary'")
# Check HTML has cache-busted CSS
run("curl -s http://127.0.0.1:8080 | grep -o 'custom.css?v=4' || echo 'CSS CACHE-BUST NOT FOUND'")
# Check HTML has JS injection
run("curl -s http://127.0.0.1:8080 | grep -o 'theme-toggle.js?v=4' || echo 'JS INJECTION NOT FOUND'")
# Check response headers on CSS
print("\n  CSS response headers:")
run("curl -sI http://127.0.0.1:8080/static/custom.css | grep -i 'cache\\|content-type'")

print("\n=== DONE — CSS + JS cache-busted to v=4 ===")
sftp.close()
ssh.close()
