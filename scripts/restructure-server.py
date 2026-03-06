"""
Restructure /home/debian on the dedicated server.

Moves all Minecraft-related directories under /home/debian/minecraft/:
  - Game servers → /home/debian/minecraft/server/
  - Panel → /home/debian/minecraft/panel/
  - Website → /home/debian/minecraft/website/

Also cleans up obsolete systemd services and updates all configs.
"""

import paramiko
import os
import sys
import time
import tempfile
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
load_dotenv(os.path.join(PROJECT_DIR, ".env"))

HOST = os.environ["SERVER_HOST"]
PORT = int(os.environ["SERVER_PORT"])
USER = os.environ["SERVER_USERNAME"]
PASSWORD = os.environ["SERVER_PASSWORD"]

PANEL_DIR = os.path.join(PROJECT_DIR, "panel")


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

    remote_tmp = f"/tmp/_restructure_{os.path.basename(remote_path)}"
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

    total_steps = 11
    step = 0

    # ==================================================================
    # Phase 1 — Pre-checks
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Pre-checks ===")

    # Check source directories exist
    sources = [
        "/home/debian/minecraft/--hg",
        "/home/debian/minecraft/proxy",
        "/home/debian/minecraft/survie",
        "/home/debian/minecraft/test",
        "/home/debian/panel",
        "/home/debian/website/azuriom",
    ]
    for src in sources:
        result = run(ssh, f"test -d {src} && echo OK || echo MISSING", allow_fail=True)
        if result != "OK":
            print(f"  WARNING: {src} not found — skipping this source")
        else:
            print(f"  OK: {src}")

    # Check targets don't exist yet
    targets = [
        "/home/debian/minecraft/server",
        "/home/debian/minecraft/panel",
        "/home/debian/minecraft/website",
    ]
    for tgt in targets:
        result = run(ssh, f"test -d {tgt} && echo EXISTS || echo OK", allow_fail=True)
        if result == "EXISTS":
            print(f"  WARNING: {tgt} already exists — moves may fail")
        else:
            print(f"  OK: {tgt} does not exist yet")
    print()

    # ==================================================================
    # Phase 2 — Stop services
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Stop services ===")
    services_to_stop = [
        "minecraft-survie",
        "minecraft-test",
        "minecraft-proxy",
        "matcraft-panel",
        "nginx",
        "php8.3-fpm",
    ]
    for svc in services_to_stop:
        run(ssh, f"systemctl stop {svc}", sudo=True, allow_fail=True)
        print(f"  Stopped {svc}")
    print()

    # ==================================================================
    # Phase 3 — Move directories
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Move directories ===")

    # Create server/ subdirectory
    run(ssh, "mkdir -p /home/debian/minecraft/server")

    # Move game servers into server/
    for name in ["--hg", "proxy", "survie", "test"]:
        src = f"/home/debian/minecraft/{name}"
        dst = f"/home/debian/minecraft/server/{name}"
        check = run(ssh, f"test -d {src} && echo OK || echo MISSING", allow_fail=True)
        if check == "OK":
            run(ssh, f"mv {src} {dst}")
            print(f"  Moved {src} -> {dst}")
        else:
            print(f"  Skipped {src} (not found)")

    # Move panel
    check = run(ssh, "test -d /home/debian/panel && echo OK || echo MISSING", allow_fail=True)
    if check == "OK":
        run(ssh, "mv /home/debian/panel /home/debian/minecraft/panel")
        print("  Moved /home/debian/panel -> /home/debian/minecraft/panel")
    else:
        print("  Skipped /home/debian/panel (not found)")

    # Move website
    check = run(ssh, "test -d /home/debian/website/azuriom && echo OK || echo MISSING", allow_fail=True)
    if check == "OK":
        run(ssh, "mv /home/debian/website/azuriom /home/debian/minecraft/website")
        print("  Moved /home/debian/website/azuriom -> /home/debian/minecraft/website")
        # Try to remove empty website directory
        run(ssh, "rmdir /home/debian/website 2>/dev/null || true", allow_fail=True)
    else:
        print("  Skipped /home/debian/website/azuriom (not found)")
    print()

    # ==================================================================
    # Phase 4 — Update systemd services (sed)
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Update systemd services ===")

    # minecraft-survie: WorkingDirectory
    run(ssh,
        "sed -i 's|WorkingDirectory=/home/debian/minecraft/survie|WorkingDirectory=/home/debian/minecraft/server/survie|' "
        "/etc/systemd/system/minecraft-survie.service",
        sudo=True, allow_fail=True)
    print("  Updated minecraft-survie.service")

    # minecraft-proxy: WorkingDirectory
    run(ssh,
        "sed -i 's|WorkingDirectory=/home/debian/minecraft/proxy|WorkingDirectory=/home/debian/minecraft/server/proxy|' "
        "/etc/systemd/system/minecraft-proxy.service",
        sudo=True, allow_fail=True)
    print("  Updated minecraft-proxy.service")

    # minecraft-test: WorkingDirectory
    run(ssh,
        "sed -i 's|WorkingDirectory=/home/debian/minecraft/test|WorkingDirectory=/home/debian/minecraft/server/test|' "
        "/etc/systemd/system/minecraft-test.service",
        sudo=True, allow_fail=True)
    print("  Updated minecraft-test.service")

    # matcraft-panel: WorkingDirectory + ExecStart
    run(ssh,
        "sed -i 's|WorkingDirectory=/home/debian/panel|WorkingDirectory=/home/debian/minecraft/panel|' "
        "/etc/systemd/system/matcraft-panel.service",
        sudo=True, allow_fail=True)
    run(ssh,
        "sed -i 's|ExecStart=/home/debian/panel/|ExecStart=/home/debian/minecraft/panel/|' "
        "/etc/systemd/system/matcraft-panel.service",
        sudo=True, allow_fail=True)
    print("  Updated matcraft-panel.service")
    print()

    # ==================================================================
    # Phase 5 — Remove obsolete services
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Remove obsolete services ===")
    obsolete = [
        "minecraft-afk",
        "minecraft-bot",
        "minecraft-casino",
        "minecraft-login",
        "minecraft-mine",
        "minecraft-playworld",
        "minecraft-smp",
        "minecraft-spawner",
        "minecraft-tutoriel",
        "minecraft-test0",
    ]
    for svc in obsolete:
        service_file = f"/etc/systemd/system/{svc}.service"
        exists = run(ssh, f"test -f {service_file} && echo YES || echo NO", allow_fail=True)
        if exists == "YES":
            run(ssh, f"systemctl stop {svc}", sudo=True, allow_fail=True)
            run(ssh, f"systemctl disable {svc}", sudo=True, allow_fail=True)
            run(ssh, f"rm {service_file}", sudo=True, allow_fail=True)
            print(f"  Removed {svc}.service")
        else:
            print(f"  Skipped {svc} (not found)")
    print()

    # ==================================================================
    # Phase 6 — Update nginx (Azuriom site)
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Update nginx config ===")
    run(ssh,
        "sed -i 's|/home/debian/website/azuriom/public|/home/debian/minecraft/website/public|g' "
        "/etc/nginx/sites-available/azuriom",
        sudo=True, allow_fail=True)
    print("  Updated /etc/nginx/sites-available/azuriom")
    print()

    # ==================================================================
    # Phase 7 — Update FileBrowser root
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Update FileBrowser root ===")
    run(ssh,
        "filebrowser config set "
        "--database /etc/filebrowser/filebrowser.db "
        "--root /home/debian/minecraft/server/test",
        sudo=True, allow_fail=True)
    run(ssh,
        "chown -R filebrowser:filebrowser /home/debian/minecraft/server/test/",
        sudo=True, allow_fail=True)
    print("  FileBrowser root updated to /home/debian/minecraft/server/test")
    print()

    # ==================================================================
    # Phase 8 — Upload updated server.ts
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Upload updated panel/server.ts ===")
    local_server_ts = os.path.join(PANEL_DIR, "server.ts")
    upload_file(sftp, local_server_ts, "/home/debian/minecraft/panel/server.ts")
    print()

    # ==================================================================
    # Phase 9 — Clear Laravel cache
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Clear Laravel cache ===")
    run(ssh, "cd /home/debian/minecraft/website && php artisan cache:clear", allow_fail=True)
    run(ssh, "cd /home/debian/minecraft/website && php artisan config:clear", allow_fail=True)
    print()

    # ==================================================================
    # Phase 10 — daemon-reload + restart
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Reload systemd + restart services ===")
    run(ssh, "systemctl daemon-reload", sudo=True)

    # Start infrastructure services first
    for svc in ["php8.3-fpm", "nginx", "filebrowser", "matcraft-panel"]:
        run(ssh, f"systemctl start {svc}", sudo=True, allow_fail=True)
        print(f"  Started {svc}")

    # Start game servers
    for svc in ["minecraft-proxy", "minecraft-survie", "minecraft-test"]:
        run(ssh, f"systemctl start {svc}", sudo=True, allow_fail=True)
        print(f"  Started {svc}")
    print()

    # ==================================================================
    # Phase 11 — Verification
    # ==================================================================
    step += 1
    print(f"=== {step}/{total_steps} — Verification ===")
    time.sleep(3)

    # Check all services
    all_services = [
        "php8.3-fpm", "nginx", "filebrowser", "matcraft-panel",
        "minecraft-proxy", "minecraft-survie", "minecraft-test",
    ]
    all_ok = True
    for svc in all_services:
        status = run(ssh, f"systemctl is-active {svc}", allow_fail=True)
        icon = "OK" if status == "active" else "FAIL"
        if status != "active":
            all_ok = False
        print(f"  [{icon}] {svc}: {status}")

    # Curl website
    print()
    web_http = run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:80", allow_fail=True)
    print(f"  Website HTTP status: {web_http}")

    # Curl panel
    panel_http = run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082", allow_fail=True)
    print(f"  Panel HTTP status: {panel_http}")

    # Check for path errors in recent logs
    print()
    print("  Recent matcraft-panel logs:")
    run(ssh, "journalctl -u matcraft-panel --no-pager -n 5 --since '1 min ago'", sudo=True, allow_fail=True)

    print()
    if all_ok:
        print("=" * 50)
        print("  RESTRUCTURE OK!")
        print("=" * 50)
    else:
        print("=" * 50)
        print("  RESTRUCTURE DONE (some services may need attention)")
        print("=" * 50)

    print()
    print("  New layout:")
    print("    /home/debian/minecraft/panel/     (staff panel)")
    print("    /home/debian/minecraft/website/    (Azuriom)")
    print("    /home/debian/minecraft/server/     (game servers)")
    print()

    sftp.close()
    ssh.close()


if __name__ == "__main__":
    main()
