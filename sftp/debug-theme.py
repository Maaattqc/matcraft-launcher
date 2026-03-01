"""Quick debug: check if nginx injection and static files work."""
import paramiko

HOST = "147.135.138.58"
PORT = 22
USER = "debian"
PASSWORD = "NNFjZ3enYfj4OyC3"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

def run(cmd):
    print(f"\n$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    out = stdout.read().decode()
    err = stderr.read().decode()
    print(out[:2000] if out else "(no output)")
    if err.strip():
        print(f"[stderr] {err[:500]}")
    return out

# 1. Check if theme-toggle.js is served by FileBrowser at /static/
print("=== 1. Check /static/theme-toggle.js from FileBrowser (port 8081) ===")
run("curl -s -o /dev/null -w 'HTTP %{http_code} - size: %{size_download}' http://127.0.0.1:8081/static/theme-toggle.js")

# 2. Check /static/custom.css from FileBrowser
print("\n=== 2. Check /static/custom.css from FileBrowser (port 8081) ===")
run("curl -s -o /dev/null -w 'HTTP %{http_code} - size: %{size_download}' http://127.0.0.1:8081/static/custom.css")

# 3. Check if nginx injects the script tag in HTML
print("\n=== 3. Check nginx injection (port 8080) - look for theme-toggle in HTML ===")
run("curl -s http://127.0.0.1:8080 | grep -o 'theme-toggle\\|theme-dark\\|filebrowser-theme' || echo 'NOT FOUND in HTML'")

# 4. Show the actual <head> section from nginx
print("\n=== 4. Show </head> area from nginx response ===")
run("curl -s http://127.0.0.1:8080 | grep -i '</head>'")

# 5. Check /static/theme-toggle.js through nginx (port 8080)
print("\n=== 5. Check /static/theme-toggle.js through nginx (port 8080) ===")
run("curl -s -o /dev/null -w 'HTTP %{http_code} - size: %{size_download}' http://127.0.0.1:8080/static/theme-toggle.js")

# 6. Check branding files exist on disk
print("\n=== 6. Check branding files on disk ===")
run("ls -la /etc/filebrowser/branding/")

# 7. Show nginx config
print("\n=== 7. Current nginx config ===")
run("cat /etc/nginx/sites-available/filebrowser")

ssh.close()
