"""Fetch FileBrowser's compiled CSS to find actual selectors."""
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

# Get the compiled CSS
print("=== Fetching compiled CSS (background/color related rules) ===")
css = run("curl -s http://127.0.0.1:8081/static/assets/index-B2p4dMn7.css")

# Print lines with background or color definitions
import re
# Split by } to get individual rules
rules = css.split('}')
for rule in rules:
    if any(kw in rule.lower() for kw in ['background', 'bg-', '#fff', '#ffffff', 'white', 'color:']):
        rule = rule.strip()
        if rule:
            print(rule + '}')
            print()

ssh.close()
