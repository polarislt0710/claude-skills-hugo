// ==UserScript==
// @name         CloudCLI Vibe Switcher
// @namespace    hugo.cloudcli
// @version      1.0.0
// @description  4 background themes (Tokyo Neon / Studio Ghibli / Lofi / Deep Space) + floating switcher button. Saves preference to localStorage.
// @author       Hugo Chan
// @match        http://187.127.115.235:3001/*
// @match        http://localhost:3001/*
// @match        https://187.127.115.235:3001/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/polarislt0710/claude-skills-hugo/main/userscripts/cloudcli-vibe-switcher.user.js
// @downloadURL  https://raw.githubusercontent.com/polarislt0710/claude-skills-hugo/main/userscripts/cloudcli-vibe-switcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 4 THEMES — to swap any background, change the bg URL below.
  // For your own image, upload to:
  //   https://github.com/polarislt0710/claude-skills-hugo/tree/main/images
  // Then use:
  //   https://raw.githubusercontent.com/polarislt0710/claude-skills-hugo/main/images/<your-file>
  // ============================================================
  const THEMES = {
    tokyo: {
      label: '🌃 Tokyo',
      bg: 'url("https://images.unsplash.com/photo-1542931287-023b922fa89b?auto=format&fit=crop&w=2400&q=80")',
      tint: 'linear-gradient(rgba(15, 5, 35, 0.65), rgba(15, 5, 35, 0.65))',
      accent1: '#ff7eb9',
      accent2: '#7afcff',
      text: '#f0e6ff',
      panel: 'rgba(20, 10, 35, 0.78)',
      border: 'rgba(255, 126, 185, 0.25)',
    },
    ghibli: {
      label: '☁️ Ghibli',
      bg: 'url("https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=2400&q=80")',
      tint: 'linear-gradient(rgba(255, 250, 240, 0.5), rgba(255, 250, 240, 0.5))',
      accent1: '#7cb9e8',
      accent2: '#f4a261',
      text: '#3d3327',
      panel: 'rgba(255, 252, 245, 0.85)',
      border: 'rgba(124, 185, 232, 0.35)',
    },
    lofi: {
      label: '☕ Lofi',
      // 👇 Default: Tokyo nightscape from Unsplash. Swap with raw URL of your uploaded image.
      bg: 'url("https://images.unsplash.com/photo-1554797589-7241bb691973?auto=format&fit=crop&w=2400&q=80")',
      tint: 'linear-gradient(rgba(15, 25, 35, 0.55), rgba(15, 25, 35, 0.55))',
      accent1: '#d8a657',
      accent2: '#89b4a4',
      text: '#e8e4d8',
      panel: 'rgba(20, 28, 35, 0.82)',
      border: 'rgba(216, 166, 87, 0.3)',
    },
    space: {
      label: '🌌 Space',
      bg: 'url("https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=2400&q=80")',
      tint: 'linear-gradient(rgba(5, 5, 25, 0.7), rgba(5, 5, 25, 0.7))',
      accent1: '#a78bfa',
      accent2: '#f472b6',
      text: '#e0d6ff',
      panel: 'rgba(15, 10, 35, 0.82)',
      border: 'rgba(167, 139, 250, 0.3)',
    },
  };

  const THEME_KEYS = Object.keys(THEMES);
  const STORAGE_KEY = 'cloudcli-theme';

  const css = `
    html { transition: background-image 0.5s ease; }
    html::before {
      content: ''; position: fixed; inset: 0; z-index: -2;
      background: var(--vibe-bg) center/cover fixed no-repeat;
    }
    html::after {
      content: ''; position: fixed; inset: 0; z-index: -1;
      background: var(--vibe-tint); pointer-events: none;
    }

    body, #root, #__next, #app {
      background: transparent !important;
      color: var(--vibe-text) !important;
    }

    nav, aside,
    [class*="sidebar" i],
    [class*="Sidebar" i],
    [data-testid*="sidebar" i] {
      background: var(--vibe-panel) !important;
      backdrop-filter: blur(16px) saturate(140%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(140%) !important;
      border-color: var(--vibe-border) !important;
    }

    main,
    [class*="main" i][class*="container" i],
    [class*="ChatArea" i] {
      background: transparent !important;
    }

    [class*="message" i],
    [class*="Message" i],
    [data-testid*="message" i],
    [class*="bubble" i] {
      background: var(--vibe-panel) !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      border: 1px solid var(--vibe-border) !important;
      border-radius: 14px !important;
    }

    textarea,
    [contenteditable="true"],
    [class*="composer" i],
    [class*="input" i][class*="container" i] {
      background: var(--vibe-panel) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      border: 1px solid var(--vibe-border) !important;
      color: var(--vibe-text) !important;
    }

    button[class*="primary" i],
    button[class*="send" i],
    button[type="submit"] {
      background: linear-gradient(135deg, var(--vibe-accent1), var(--vibe-accent2)) !important;
      border: none !important;
      color: #fff !important;
    }
    button:hover { filter: brightness(1.1); }

    a, [class*="link" i] { color: var(--vibe-accent1) !important; }

    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb {
      background: var(--vibe-accent1);
      border-radius: 6px;
      opacity: 0.4;
    }
    ::-webkit-scrollbar-track { background: transparent; }

    #vibe-switcher {
      position: fixed;
      bottom: 24px; right: 24px;
      z-index: 99999;
      padding: 10px 18px;
      background: var(--vibe-panel);
      color: var(--vibe-text);
      border: 1px solid var(--vibe-border);
      border-radius: 100px;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 13px;
      font-weight: 500;
      backdrop-filter: blur(20px) saturate(160%);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      transition: transform 0.2s ease, background 0.3s ease;
      user-select: none;
    }
    #vibe-switcher:hover {
      transform: translateY(-2px);
      background: linear-gradient(135deg, var(--vibe-accent1), var(--vibe-accent2));
      color: white;
    }
    #vibe-switcher:active { transform: translateY(0); }
  `;

  function applyTheme(name) {
    const t = THEMES[name];
    const root = document.documentElement;
    root.dataset.theme = name;
    root.style.setProperty('--vibe-bg', t.bg);
    root.style.setProperty('--vibe-tint', t.tint);
    root.style.setProperty('--vibe-accent1', t.accent1);
    root.style.setProperty('--vibe-accent2', t.accent2);
    root.style.setProperty('--vibe-text', t.text);
    root.style.setProperty('--vibe-panel', t.panel);
    root.style.setProperty('--vibe-border', t.border);
    localStorage.setItem(STORAGE_KEY, name);
    const btn = document.getElementById('vibe-switcher');
    if (btn) btn.textContent = t.label;
  }

  function injectButton() {
    if (document.getElementById('vibe-switcher')) return;
    if (!document.body) return;
    const btn = document.createElement('button');
    btn.id = 'vibe-switcher';
    const cur = document.documentElement.dataset.theme || 'lofi';
    btn.textContent = THEMES[cur].label;
    btn.onclick = () => {
      const c = document.documentElement.dataset.theme;
      const next = THEME_KEYS[(THEME_KEYS.indexOf(c) + 1) % THEME_KEYS.length];
      applyTheme(next);
    };
    document.body.appendChild(btn);
  }

  function init() {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    const saved = localStorage.getItem(STORAGE_KEY) || 'lofi';
    applyTheme(THEME_KEYS.includes(saved) ? saved : 'lofi');

    if (document.body) injectButton();
    else {
      const observer = new MutationObserver(() => {
        if (document.body) {
          injectButton();
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  init();
})();
