"""Check what CSS rules apply to listing items."""
import paramiko

HOST = "147.135.138.58"
PORT = 22
USER = "debian"
PASSWORD = "NNFjZ3enYfj4OyC3"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

def run(cmd):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    return stdout.read().decode()

# Check what the compiled CSS says about #listing .item background
print("=== Rules with surfacePrimary ===")
css = run("curl -s http://127.0.0.1:8081/static/assets/index-B2p4dMn7.css")
import re
# Find all rules that use surfacePrimary
for m in re.finditer(r'[^}]*surfacePrimary[^}]*}', css):
    print(m.group().strip())
    print()

print("\n=== Rules with #listing .item ===")
for m in re.finditer(r'[^}]*#listing[^}]*item[^}]*}', css):
    print(m.group().strip())
    print()

print("\n=== Current custom.css on server (first 20 lines of variables) ===")
out = run("head -40 /etc/filebrowser/branding/custom.css")
print(out)

print("\n=== Verify custom.css is loaded and has surfacePrimary ===")
out = run("curl -s http://127.0.0.1:8080/static/custom.css | grep -c 'surfacePrimary'")
print(f"surfacePrimary count in served CSS: {out.strip()}")

print("\n=== Check CSS load order in HTML ===")
out = run("curl -s http://127.0.0.1:8080 | grep -n 'custom.css\\|index-.*\\.css'")
print(out)

ssh.close()
