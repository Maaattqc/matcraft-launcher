(function () {
  'use strict';

  var STORAGE_KEY = 'filebrowser-theme';

  // SVG icons (Lucide-style)
  var sunSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="5"/>' +
    '<line x1="12" y1="1" x2="12" y2="3"/>' +
    '<line x1="12" y1="21" x2="12" y2="23"/>' +
    '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>' +
    '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>' +
    '<line x1="1" y1="12" x2="3" y2="12"/>' +
    '<line x1="21" y1="12" x2="23" y2="12"/>' +
    '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>' +
    '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>' +
    '</svg>';

  var moonSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' +
    '</svg>';

  function getTheme() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return stored;
      // Default to dark mode (MatCraft theme)
      return 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function setTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      // localStorage might be unavailable
    }
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark', 'theme-dark');
    } else {
      document.documentElement.classList.remove('dark', 'theme-dark');
    }
    updateIcon();
  }

  function updateIcon() {
    var btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    var isDark = document.documentElement.classList.contains('theme-dark');
    // Show sun icon in dark mode (click to go light), moon icon in light mode (click to go dark)
    btn.innerHTML = isDark ? sunSVG : moonSVG;
    btn.title = isDark ? 'Passer en mode clair' : 'Passer en mode sombre';
    btn.setAttribute('aria-label', btn.title);
  }

  // SVG for panel link button
  var panelSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>' +
    '<line x1="8" y1="21" x2="16" y2="21"/>' +
    '<line x1="12" y1="17" x2="12" y2="21"/>' +
    '</svg>';

  function createToggleButton() {
    if (document.getElementById('theme-toggle-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'theme-toggle-btn';
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var current = getTheme();
      var next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
      applyTheme(next);
    });

    document.body.appendChild(btn);
    updateIcon();
  }

  function createPanelButton() {
    if (document.getElementById('panel-nav-btn')) return;

    var sidebar = document.querySelector('nav');
    if (!sidebar) return;

    var panelBtn = document.createElement('a');
    panelBtn.id = 'panel-nav-btn';
    panelBtn.href = 'https://panel.matcraft-mc.com';
    panelBtn.target = '_blank';
    panelBtn.title = 'Ouvrir le Panel';
    panelBtn.setAttribute('aria-label', 'Ouvrir le Panel');
    panelBtn.innerHTML = panelSVG + ' Panel';
    sidebar.appendChild(panelBtn);
  }

  // Apply theme immediately (also applied by inline script in <head> to prevent FOUC)
  applyTheme(getTheme());

  function hideCredits() {
    var els = document.querySelectorAll('.credits');
    for (var i = 0; i < els.length; i++) {
      els[i].style.display = 'none';
    }
  }

  // Create buttons when DOM is ready
  function init() {
    createToggleButton();
    createPanelButton();
    hideCredits();

    // Re-create buttons if DOM changes (FileBrowser is a SPA, DOM can be replaced)
    var observer = new MutationObserver(function () {
      if (!document.getElementById('theme-toggle-btn')) {
        createToggleButton();
      }
      if (!document.getElementById('panel-nav-btn')) {
        createPanelButton();
      }
      hideCredits();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
