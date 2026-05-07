// ==UserScript==
// @name         CloudCLI Vibe Switcher
// @namespace    hugo.cloudcli
// @version      1.0.1
// @description  4 background themes (Tokyo Neon / Studio Ghibli / Lofi / Deep Space) + floating switcher button
// @author       Hugo Chan
// @match        *://187.127.115.235:3001/*
// @match        *://localhost:3001/*
// @match        http://187.127.115.235:3001/*
// @match        http://localhost:3001/*
// @match        https://187.127.115.235:3001/*
// @match        https://localhost:3001/*
// @include      http://187.127.115.235:3001/*
// @include      http://localhost:3001/*
// @include      https://187.127.115.235:3001/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/polarislt0710/claude-skills-hugo/main/userscripts/cloudcli-vibe-switcher.user.js
// @downloadURL  https://raw.githubusercontent.com/polarislt0710/claude-skills-hugo/main/userscripts/cloudcli-vibe-switcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  console.log('[VibeSwitcher] script started, url:', location.href);

  const THEMES = {
    tokyo:  { label:'🌃 Tokyo',  bg:'url("https://images.unsplash.com/photo-1542931287-023b922fa89b?auto=format&fit=crop&w=2400&q=80")', tint:'linear-gradient(rgba(15,5,35,.65),rgba(15,5,35,.65))', accent1:'#ff7eb9', accent2:'#7afcff', text:'#f0e6ff', panel:'rgba(20,10,35,.78)',  border:'rgba(255,126,185,.25)' },
    ghibli: { label:'☁️ Ghibli', bg:'url("https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=2400&q=80")', tint:'linear-gradient(rgba(255,250,240,.5),rgba(255,250,240,.5))',  accent1:'#7cb9e8', accent2:'#f4a261', text:'#3d3327', panel:'rgba(255,252,245,.85)', border:'rgba(124,185,232,.35)' },
    lofi:   { label:'☕ Lofi',   bg:'url("https://images.unsplash.com/photo-1554797589-7241bb691973?auto=format&fit=crop&w=2400&q=80")', tint:'linear-gradient(rgba(15,25,35,.55),rgba(15,25,35,.55))',   accent1:'#d8a657', accent2:'#89b4a4', text:'#e8e4d8', panel:'rgba(20,28,35,.82)',   border:'rgba(216,166,87,.3)' },
    space:  { label:'🌌 Space',  bg:'url("https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=2400&q=80")', tint:'linear-gradient(rgba(5,5,25,.7),rgba(5,5,25,.7))',         accent1:'#a78bfa', accent2:'#f472b6', text:'#e0d6ff', panel:'rgba(15,10,35,.82)',   border:'rgba(167,139,250,.3)' },
  };
  const KEYS = Object.keys(THEMES);
  const KEY = 'cloudcli-theme';

  const css = `
    html::before{content:'';position:fixed;inset:0;z-index:-2;background:var(--vibe-bg) center/cover fixed no-repeat;}
    html::after{content:'';position:fixed;inset:0;z-index:-1;background:var(--vibe-tint);pointer-events:none;}
    body,#root,#__next,#app{background:transparent !important;color:var(--vibe-text) !important;}
    nav,aside,[class*="sidebar" i],[class*="Sidebar" i]{background:var(--vibe-panel) !important;backdrop-filter:blur(16px) saturate(140%) !important;-webkit-backdrop-filter:blur(16px) saturate(140%) !important;border-color:var(--vibe-border) !important;}
    main,[class*="main" i][class*="container" i]{background:transparent !important;}
    [class*="message" i],[class*="Message" i],[data-testid*="message" i],[class*="bubble" i]{background:var(--vibe-panel) !important;backdrop-filter:blur(8px) !important;-webkit-backdrop-filter:blur(8px) !important;border:1px solid var(--vibe-border) !important;border-radius:14px !important;}
    textarea,[contenteditable="true"],[class*="composer" i]{background:var(--vibe-panel) !important;backdrop-filter:blur(12px) !important;-webkit-backdrop-filter:blur(12px) !important;border:1px solid var(--vibe-border) !important;color:var(--vibe-text) !important;}
    button[class*="primary" i],button[type="submit"]{background:linear-gradient(135deg,var(--vibe-accent1),var(--vibe-accent2)) !important;border:none !important;color:#fff !important;}
    button:hover{filter:brightness(1.1);}
    a{color:var(--vibe-accent1) !important;}
    ::-webkit-scrollbar{width:10px;height:10px;}
    ::-webkit-scrollbar-thumb{background:var(--vibe-accent1);border-radius:6px;opacity:.4;}
    ::-webkit-scrollbar-track{background:transparent;}
    #vibe-switcher{position:fixed !important;bottom:24px !important;right:24px !important;z-index:2147483647 !important;padding:10px 18px !important;background:var(--vibe-panel) !important;color:var(--vibe-text) !important;border:1px solid var(--vibe-border) !important;border-radius:100px !important;cursor:pointer !important;font-family:system-ui,-apple-system,sans-serif !important;font-size:13px !important;font-weight:500 !important;backdrop-filter:blur(20px) saturate(160%) !important;-webkit-backdrop-filter:blur(20px) saturate(160%) !important;box-shadow:0 8px 32px rgba(0,0,0,.25) !important;transition:transform .2s ease,background .3s ease !important;user-select:none !important;}
    #vibe-switcher:hover{transform:translateY(-2px) !important;background:linear-gradient(135deg,var(--vibe-accent1),var(--vibe-accent2)) !important;color:#fff !important;}
    #vibe-switcher:active{transform:translateY(0) !important;}
  `;

  function applyTheme(name) {
    const t = THEMES[name];
    const r = document.documentElement;
    r.dataset.theme = name;
    r.style.setProperty('--vibe-bg', t.bg);
    r.style.setProperty('--vibe-tint', t.tint);
    r.style.setProperty('--vibe-accent1', t.accent1);
    r.style.setProperty('--vibe-accent2', t.accent2);
    r.style.setProperty('--vibe-text', t.text);
    r.style.setProperty('--vibe-panel', t.panel);
    r.style.setProperty('--vibe-border', t.border);
    try { localStorage.setItem(KEY, name); } catch (e) {}
    const btn = document.getElementById('vibe-switcher');
    if (btn) btn.textContent = t.label;
    console.log('[VibeSwitcher] applied theme:', name);
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
      const next = KEYS[(KEYS.indexOf(c) + 1) % KEYS.length];
      applyTheme(next);
    };
    document.body.appendChild(btn);
    console.log('[VibeSwitcher] button injected');
  }

  // Inject style
  const style = document.createElement('style');
  style.id = 'vibe-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // Apply saved or default theme
  let saved;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  applyTheme(KEYS.includes(saved) ? saved : 'lofi');

  // Inject button (body should exist at document-end)
  injectButton();

  // Re-inject if SPA navigation removes button
  const obs = new MutationObserver(() => {
    if (!document.getElementById('vibe-switcher') && document.body) injectButton();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
