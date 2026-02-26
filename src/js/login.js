// Window controls
document.getElementById('btn-minimize').addEventListener('click', () => window.launcher.minimize());
document.getElementById('btn-close').addEventListener('click', () => window.launcher.close());

const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const errorMsg = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) return;

    loginBtn.disabled = true;
    loginBtn.textContent = 'Connexion...';
    errorMsg.classList.add('hidden');

    try {
        const result = await window.launcher.login(email, password);

        if (result.success) {
            // Store user data for app.html
            sessionStorage.setItem('user', JSON.stringify(result.user));
            window.location.href = 'app.html';
        } else {
            errorMsg.textContent = result.error;
            errorMsg.classList.remove('hidden');
        }
    } catch (err) {
        errorMsg.textContent = 'Erreur inattendue. Veuillez réessayer.';
        errorMsg.classList.remove('hidden');
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Se connecter';
    }
});
