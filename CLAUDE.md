# MatCraft Launcher

Custom Electron desktop launcher for the MatCraft Minecraft server (matfaction.com).
Authenticates players via Azuriom, then launches Minecraft 1.21.11 with Fabric + bundled mods.

## Architecture

```
main.js          — Electron main process (window, auth, game launch, auto-updater)
preload.js       — Context bridge exposing `window.launcher` API to renderer
renderer/        — React 19 + TypeScript + Vite + Tailwind v4 frontend (shadcn/ui components)
mods/            — .jar files bundled with the app and copied to game dir at launch
src/icon.png     — App icon (must be >= 512x512 for macOS)
.github/workflows/release.yml — CI/CD pipeline
```

- **Auth**: AZauth against `https://matfaction.com`
- **Game**: `minecraft-java-core` launches Fabric 1.21.11 with Java 21
- **IPC**: main ↔ renderer via `ipcMain`/`ipcRenderer` channels (`azauth:*`, `minecraft:*`, `launch:*`, `updater:*`, `window:*`)
- **Auto-update**: `electron-updater` with generic provider at `https://matfaction.com/launcher`

## Development

```bash
npm install          # also installs renderer/ deps via postinstall
npm run dev          # starts Vite dev server + Electron with --dev flag
npm run start        # runs Electron without dev server (needs pre-built renderer)
```

Renderer dev server runs on `http://localhost:5173`. Electron loads it in dev mode, or `renderer/dist/index.html` in production.

## Building & Releasing

### Manual local build (Windows only)
```bash
npm run dist         # builds renderer then runs electron-builder --win
```

### Full release workflow
1. Bump `version` in `package.json`
2. Commit the version bump
3. `git tag vX.Y.Z && git push origin vX.Y.Z`
4. The `v*` tag triggers `.github/workflows/release.yml`

### CI pipeline (release.yml)
Three parallel build jobs:
- **build-win** (windows-latest) → `.exe`, `latest.yml`, `.blockmap`
- **build-mac** (macos-latest) → `.dmg`, `.zip`, `latest-mac.yml`
- **build-linux** (ubuntu-latest) → `.AppImage`, `latest-linux.yml`

Then a **deploy** job SCPs all artifacts to the server and cleans up old versions.

### Deploy target
```
/home/debian/website/azuriom/public/launcher/
```
on matfaction.com, served at `https://matfaction.com/launcher/`.

### Required GitHub secrets
- `SSH_HOST` — server hostname
- `SSH_PORT` — SSH port
- `SSH_USERNAME` — SSH user
- `SSH_PASSWORD` — SSH password

## macOS build notes

- No Apple Developer account — code signing is disabled:
  - `"identity": null` in package.json mac config
  - `CSC_IDENTITY_AUTO_DISCOVERY=false` in CI env
- `src/icon.png` must be >= 512x512 or the macOS build will fail

## Panel deploy

Le panel (`panel/`) tourne sur le serveur dédié. Après toute modification de `panel/server.ts` ou `panel/public/index.html`, **toujours déployer sur le serveur** :

- **Credentials SSH** : dans `.env` à la racine du projet (HOST, PORT, USERNAME, PASSWORD)
- **Chemin serveur** : `/home/debian/panel/` (fichiers statiques dans `/home/debian/panel/public/`)
- **Service systemd** : `matcraft-panel` — redémarrer après upload avec `sudo systemctl restart matcraft-panel`
- **Méthode** : utiliser `paramiko` (Python, dispo sur cette machine) pour SFTP upload + exec restart
- **Vérification** : après restart, vérifier que le service est `active` et lire les dernières lignes de `journalctl -u matcraft-panel`

## SFTP deploy

Le SFTP (`sftp/`) est un FileBrowser avec branding MatCraft, derrière nginx, sur le même serveur dédié.

```
sftp/
  branding/          → /etc/filebrowser/branding/     (CSS, JS, icônes)
  nginx/             → /etc/nginx/sites-available/    (config reverse proxy)
  systemd/           → /etc/systemd/system/           (service FileBrowser)
  setup.sh           — script de setup initial (one-shot)
  harden.py          — script de hardening (one-shot)
```

- **Credentials SSH** : même `.env` que le panel
- **Services systemd** : `filebrowser` (port 8081) + `nginx` (proxy port 8080)
- **URL** : `https://sftp.matcraft-mc.com` (Cloudflare Tunnel → nginx :8080 → FileBrowser :8081)
- **Méthode deploy** : paramiko SFTP vers `/tmp/` puis `sudo cp` vers la destination (fichiers dans `/etc/` donc pas d'écriture directe), puis :
  - Branding modifié : `sudo systemctl restart filebrowser`
  - Nginx modifié : `sudo nginx -t && sudo systemctl reload nginx`
  - Service modifié : `sudo systemctl daemon-reload && sudo systemctl restart filebrowser`

## Conventions

- **Messages de commit** : toujours en français.

## Key dependencies

| Package | Purpose |
|---|---|
| `electron` ^40 | Desktop shell |
| `electron-builder` ^25 | Packaging & publishing |
| `electron-updater` ^6 | Auto-update (generic provider) |
| `minecraft-java-core` ^4 | Minecraft download & launch |
| `azuriom-auth` ^1 | Azuriom site authentication |
| `react` ^19 | UI framework |
| `tailwindcss` ^4 | Styling |
| `framer-motion` ^12 | Animations |
