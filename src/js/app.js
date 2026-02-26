// Window controls
document.getElementById('btn-minimize').addEventListener('click', () => window.launcher.minimize());
document.getElementById('btn-close').addEventListener('click', () => window.launcher.close());

// Load user data
const user = JSON.parse(sessionStorage.getItem('user'));
if (!user) {
    window.location.href = 'index.html';
}

document.getElementById('username').textContent = user.username;

// Elements
const playBtn = document.getElementById('play-btn');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const progressSpeed = document.getElementById('progress-speed');
const statusText = document.getElementById('status-text');
const consolePanel = document.getElementById('console-panel');
const consoleOutput = document.getElementById('console-output');
const toggleConsole = document.getElementById('toggle-console');
const logoutBtn = document.getElementById('logout-btn');
const minRam = document.getElementById('min-ram');
const maxRam = document.getElementById('max-ram');

let isLaunching = false;

// Event listeners from main process
window.launcher.onProgress((progress, size) => {
    const percent = size > 0 ? ((progress / size) * 100).toFixed(1) : 0;
    progressFill.style.width = percent + '%';
    progressText.textContent = `Téléchargement... ${percent}%`;
});

window.launcher.onSpeed((speed) => {
    progressSpeed.textContent = `${speed.toFixed(1)} ko/s`;
});

window.launcher.onEstimated((seconds) => {
    if (seconds > 0) {
        const min = Math.floor(seconds / 60);
        const sec = Math.floor(seconds % 60);
        const eta = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
        progressText.textContent = progressText.textContent.split('—')[0].trim() + ` — ${eta} restant`;
    }
});

window.launcher.onExtract((fileName) => {
    statusText.textContent = `Extraction: ${fileName}`;
});

window.launcher.onPatch((patchName) => {
    statusText.textContent = `Patch: ${patchName}`;
});

window.launcher.onData((line) => {
    consoleOutput.textContent += line;
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
});

window.launcher.onClose(() => {
    isLaunching = false;
    playBtn.disabled = false;
    playBtn.textContent = 'JOUER';
    progressSection.classList.add('hidden');
    statusText.textContent = 'Jeu fermé — Prêt à rejouer';
    progressFill.style.width = '0%';
    progressSpeed.textContent = '';
});

window.launcher.onError((err) => {
    isLaunching = false;
    playBtn.disabled = false;
    playBtn.textContent = 'JOUER';
    progressSection.classList.add('hidden');
    statusText.textContent = `Erreur: ${err}`;
    statusText.classList.add('error');
});

// Play button
playBtn.addEventListener('click', async () => {
    if (isLaunching) return;
    isLaunching = true;

    playBtn.disabled = true;
    playBtn.textContent = 'Lancement...';
    progressSection.classList.remove('hidden');
    consolePanel.classList.remove('hidden');
    consoleOutput.textContent = '';
    statusText.textContent = 'Préparation du lancement...';
    statusText.classList.remove('error');
    progressFill.style.width = '0%';

    const config = {
        username: user.username,
        uuid: user.uuid,
        accessToken: user.accessToken,
        minRam: minRam.value,
        maxRam: maxRam.value
    };

    const result = await window.launcher.launchGame(config);

    if (!result.success) {
        isLaunching = false;
        playBtn.disabled = false;
        playBtn.textContent = 'JOUER';
        progressSection.classList.add('hidden');
        statusText.textContent = `Erreur: ${result.error}`;
        statusText.classList.add('error');
    } else {
        statusText.textContent = 'Minecraft est en cours d\'exécution...';
    }
});

// Console toggle
toggleConsole.addEventListener('click', () => {
    const isHidden = consoleOutput.classList.toggle('collapsed');
    toggleConsole.textContent = isHidden ? 'Afficher' : 'Masquer';
});

// Logout
logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('user');
    window.location.href = 'index.html';
});
