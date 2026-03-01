"""Inspect FileBrowser HTML structure to find unstyled elements."""
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

# Get the full HTML page
print("=== Full HTML page ===")
html = run("curl -s http://127.0.0.1:8080")
print(html)

# Login, get token, then fetch the files page
print("\n=== Login & fetch files page ===")
# FileBrowser API login
token_resp = run("""curl -s -X POST http://127.0.0.1:8081/api/login -H 'Content-Type: application/json' -d '{"username":"dev","password":"devdev123456$"}'""")
print(f"Token response: {token_resp[:200]}")

ssh.close()
