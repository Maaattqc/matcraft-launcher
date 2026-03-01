"""Fix: serve theme-toggle.js via nginx + cache-busting."""
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
    print(f"  $ {cmd[:120]}{'...' if len(cmd) > 120 else ''}")
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
# - Added location to serve theme-toggle.js directly from disk
# - Added ?v=2 cache-busting to script URL
nginx_conf = """\
server {
    listen 127.0.0.1:8080;
    server_name _;

    client_max_body_size 10G;

    # Serve theme JS directly (FileBrowser only auto-serves custom.css)
    location = /static/theme-toggle.js {
        alias /etc/filebrowser/branding/theme-toggle.js;
        add_header Cache-Control "public, max-age=3600";
        add_header Content-Type "application/javascript";
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

        proxy_set_header Accept-Encoding "";

        sub_filter '</head>' '<script>try{var t=localStorage.getItem("filebrowser-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");if(t==="dark")document.documentElement.classList.add("theme-dark")}catch(e){}</script><script defer src="/static/theme-toggle.js?v=2"></script></head>';
        sub_filter_once on;
        sub_filter_types text/html;
    }
}
"""

print("=== 1. Upload updated nginx config ===")
with tempfile.NamedTemporaryFile(mode='w', suffix='.conf', delete=False) as f:
    f.write(nginx_conf)
    tmp = f.name
sftp.put(tmp, "/tmp/fb-nginx.conf")
os.unlink(tmp)
run("cp /tmp/fb-nginx.conf /etc/nginx/sites-available/filebrowser && rm /tmp/fb-nginx.conf", sudo=True)

print("\n=== 2. Test & reload nginx ===")
run("nginx -t", sudo=True)
run("systemctl reload nginx", sudo=True)

print("\n=== 3. Verify ===")
run("curl -s -o /dev/null -w 'JS: HTTP %{http_code} - %{size_download} bytes' http://127.0.0.1:8080/static/theme-toggle.js?v=2")
run("curl -s -o /dev/null -w 'CSS: HTTP %{http_code} - %{size_download} bytes' http://127.0.0.1:8080/static/custom.css")
run("curl -s http://127.0.0.1:8080 | grep -o 'theme-toggle.js?v=2' || echo 'INJECTION NOT FOUND'")

print("\n=== DONE ===")
sftp.close()
ssh.close()
