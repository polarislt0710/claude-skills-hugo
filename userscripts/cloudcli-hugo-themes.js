(function () {
  "use strict";

  const KEY = "cloudcli-hugo-theme";
  const LEGACY_KEY = "cloudcli-theme";
  const THEMES = [
    { id: "light", label: "Light", color: "#ffffff" },
    { id: "cozy", label: "Cozy", color: "#fbf3dc" },
    { id: "dark", label: "Dark", color: "#06101e" }
  ];
  const SWARM_PORT = "3010";

  function getStoredTheme() {
    try {
      const stored = localStorage.getItem(KEY);
      if (THEMES.some((theme) => theme.id === stored)) return stored;
    } catch (error) {
      // Ignore storage errors in private browsing contexts.
    }
    return "light";
  }

  function setThemeColor(themeId) {
    const theme = THEMES.find((item) => item.id === themeId) || THEMES[0];
    const nodes = document.querySelectorAll('meta[name="theme-color"], meta[name="msapplication-TileColor"]');
    nodes.forEach((node) => node.setAttribute("content", theme.color));
  }

  function cleanLegacyVibeSwitcher() {
    const legacyStyle = document.getElementById("vibe-style");
    if (legacyStyle) legacyStyle.remove();

    const legacyButton = document.getElementById("vibe-switcher");
    if (legacyButton) legacyButton.remove();

    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (error) {
      // No-op.
    }
  }

  function applyTheme(themeId) {
    const nextTheme = THEMES.some((theme) => theme.id === themeId) ? themeId : "light";
    document.documentElement.dataset.hugoCloudcliTheme = nextTheme;
    setThemeColor(nextTheme);

    try {
      localStorage.setItem(KEY, nextTheme);
    } catch (error) {
      // No-op.
    }

    document.querySelectorAll("#hugo-theme-switcher button").forEach((button) => {
      const active = button.dataset.theme === nextTheme;
      button.setAttribute("aria-pressed", String(active));
    });
    window.setTimeout(postCloudCliTheme, 0);
  }

  function positionSwitcher() {
    const switcher = document.getElementById("hugo-theme-switcher");
    if (!switcher) return;

    const candidates = [
      ...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], [class*="composer" i]')
    ].filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > window.innerWidth * 0.35 &&
        rect.height > 24 &&
        rect.bottom > window.innerHeight - 190 &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    });

    const bottomEdge = candidates.reduce((top, node) => {
      const rect = node.getBoundingClientRect();
      return Math.min(top, rect.top);
    }, window.innerHeight);

    const desktopDefault = 18;
    const mobileDefault = 10;
    const base = window.innerWidth <= 780 ? mobileDefault : desktopDefault;
    const lifted = bottomEdge < window.innerHeight ? Math.max(base, window.innerHeight - bottomEdge + 12) : base;
    document.documentElement.style.setProperty("--hugo-switch-bottom", `${Math.min(lifted, 190)}px`);
  }

  function ensureSwitcher() {
    cleanLegacyVibeSwitcher();

    if (document.getElementById("hugo-theme-switcher") || !document.body) return;

    const switcher = document.createElement("div");
    switcher.id = "hugo-theme-switcher";
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "CloudCLI visual mode");

    THEMES.forEach((theme) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.theme = theme.id;
      button.textContent = theme.label;
      button.addEventListener("click", () => applyTheme(theme.id));
      switcher.appendChild(button);
    });

    document.body.appendChild(switcher);
    applyTheme(document.documentElement.dataset.hugoCloudcliTheme || getStoredTheme());
    positionSwitcher();
  }

  function getSwarmUrl() {
    const host = location.hostname || "187.127.115.235";
    return `${location.protocol}//${host}:${SWARM_PORT}`;
  }

  function getMiroFishUrl() {
    const host = location.hostname || "187.127.115.235";
    return `${location.protocol}//${host}:${SWARM_PORT}/mirofish/`;
  }

  function getMissionUrl() {
    const host = location.hostname || "187.127.115.235";
    const theme = document.documentElement.dataset.hugoCloudcliTheme || getStoredTheme() || "cozy";
    return `${location.protocol}//${host}:${SWARM_PORT}/mission?theme=${encodeURIComponent(theme)}`;
  }

  function inferCloudCliTopic(text) {
    const heading = [...document.querySelectorAll("h1, h2, [class*='title' i], [class*='Title' i]")]
      .map((node) => (node.textContent || "").trim())
      .find((value) => value.length > 8 && value.length < 180);
    if (heading) return heading;

    const firstIssue = String(text || "").match(/Issue\s+\d+\s*[:：][^\n]{8,160}/i);
    if (firstIssue) return firstIssue[0].trim();

    const firstLine = String(text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .find((line) => line.length > 12 && line.length < 180);
    return firstLine || "CloudCLI Session Swarm";
  }

  function collectCloudCliContext() {
    const root = document.querySelector("main") || document.querySelector("#root") || document.body;
    const raw = (root && root.innerText ? root.innerText : document.body.innerText || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n")
      .trim();
    const text = raw.length > 24000 ? `${raw.slice(0, 24000)}\n\n...[CloudCLI context truncated]` : raw;
    const url = location.href;
    const sessionKey = [
      location.hostname,
      location.pathname,
      document.title || "",
      text.slice(0, 120)
    ].join("|");
    let sessionId = "cloudcli-session";
    try {
      sessionId = `cloudcli-${btoa(unescape(encodeURIComponent(sessionKey))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`;
    } catch (error) {
      sessionId = `cloudcli-${Date.now()}`;
    }
    return {
      source: "cloudcli",
      sessionId,
      url,
      title: document.title || "CloudCLI",
      topic: inferCloudCliTopic(text),
      theme: document.documentElement.dataset.hugoCloudcliTheme || getStoredTheme(),
      text,
      sentAt: new Date().toISOString()
    };
  }

  function postCloudCliTheme() {
    const frame = document.getElementById("hugo-swarm-frame");
    if (!frame || !frame.contentWindow || frame.dataset.hugoLoaded !== "true") return;
    frame.contentWindow.postMessage({
      type: "cloudcli-theme",
      theme: document.documentElement.dataset.hugoCloudcliTheme || getStoredTheme()
    }, getSwarmUrl());
  }

  function postCloudCliContext() {
    const frame = document.getElementById("hugo-swarm-frame");
    if (!frame || !frame.contentWindow) return;
    if (frame.dataset.hugoLoaded !== "true") return;
    postCloudCliTheme();
    const payload = collectCloudCliContext();
    frame.contentWindow.postMessage({ type: "cloudcli-context", payload }, getSwarmUrl());
  }

  function ensureSwarmPanel() {
    if (document.getElementById("hugo-swarm-panel") || !document.body) return;

    const panel = document.createElement("section");
    panel.id = "hugo-swarm-panel";
    panel.setAttribute("aria-label", "Agent Swarm dashboard");
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <div id="hugo-swarm-panel-header">
        <div>
          <strong>Agent Swarm V3</strong>
          <span>對話記憶 · 分層圖 · 執行 Agents</span>
        </div>
        <div id="hugo-swarm-panel-actions">
          <button type="button" data-hugo-swarm-action="sync">同步對話</button>
          <button type="button" data-hugo-swarm-action="refresh">重新整理</button>
          <a href="${getSwarmUrl()}" target="_blank" rel="noreferrer">開新頁</a>
          <button type="button" data-hugo-swarm-action="close" aria-label="關閉 Agent Swarm">關閉</button>
        </div>
      </div>
      <iframe id="hugo-swarm-frame" title="Agent Swarm Dashboard" loading="lazy"></iframe>
    `;

    panel.querySelector('[data-hugo-swarm-action="close"]').addEventListener("click", closeSwarmPanel);
    panel.querySelector('[data-hugo-swarm-action="sync"]').addEventListener("click", postCloudCliContext);
    panel.querySelector('[data-hugo-swarm-action="refresh"]').addEventListener("click", () => {
      const frame = document.getElementById("hugo-swarm-frame");
      if (frame) {
        frame.dataset.hugoLoaded = "false";
        frame.src = getSwarmUrl();
        frame.addEventListener("load", () => {
          frame.dataset.hugoLoaded = "true";
          postCloudCliContext();
        }, { once: true });
      }
    });

    document.body.appendChild(panel);
  }

  function openSwarmPanel() {
    ensureSwarmPanel();
    const panel = document.getElementById("hugo-swarm-panel");
    const frame = document.getElementById("hugo-swarm-frame");
    if (!panel || !frame) return;

    if (!frame.src) {
      frame.dataset.hugoLoaded = "false";
      frame.src = getSwarmUrl();
    }
    frame.addEventListener("load", () => {
      frame.dataset.hugoLoaded = "true";
      postCloudCliContext();
    }, { once: true });
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    document.documentElement.dataset.hugoSwarmOpen = "true";
    positionSwitcher();
    window.setTimeout(postCloudCliContext, 500);
    window.setTimeout(postCloudCliContext, 1400);
  }

  function closeSwarmPanel() {
    const panel = document.getElementById("hugo-swarm-panel");
    if (!panel) return;
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    delete document.documentElement.dataset.hugoSwarmOpen;
    positionSwitcher();
  }

  function ensureSwarmButton() {
    if (!document.body || document.getElementById("hugo-swarm-button-wrap")) return;

    const chatButton = [...document.querySelectorAll("button")].find((button) => {
      const text = (button.textContent || "").trim();
      const rect = button.getBoundingClientRect();
      return /^(Chat|聊天)$/.test(text) && rect.width > 20 && rect.height > 20 && rect.y < 90;
    });
    if (!chatButton || !chatButton.parentElement || !chatButton.parentElement.parentElement) return;

    const wrap = document.createElement("span");
    wrap.id = "hugo-swarm-button-wrap";
    wrap.className = "relative inline-block";

    const button = document.createElement("button");
    button.id = "hugo-swarm-button";
    button.type = "button";
    button.innerHTML = '<span aria-hidden="true">✦</span><span>Swarm</span>';
    button.addEventListener("click", openSwarmPanel);

    wrap.appendChild(button);
    chatButton.parentElement.parentElement.insertBefore(wrap, chatButton.parentElement);
    ensureSwarmPanel();
  }

  function ensureMiroFishButton() {
    if (!document.body || document.getElementById("hugo-mirofish-button-wrap")) return;

    var anchor = document.getElementById("hugo-swarm-button-wrap");
    if (!anchor || !anchor.parentElement) {
      var chatButton = [...document.querySelectorAll("button")].find(function (btn) {
        var text = (btn.textContent || "").trim();
        var rect = btn.getBoundingClientRect();
        return /^(Chat|聊天)$/.test(text) && rect.width > 20 && rect.height > 20 && rect.y < 90;
      });
      if (!chatButton || !chatButton.parentElement || !chatButton.parentElement.parentElement) return;
      anchor = chatButton.parentElement;
    }

    var wrap = document.createElement("span");
    wrap.id = "hugo-mirofish-button-wrap";
    wrap.className = "relative inline-block";

    var button = document.createElement("button");
    button.id = "hugo-mirofish-button";
    button.type = "button";
    button.innerHTML = '<span aria-hidden="true">\u{1F41F}</span><span>MiroFish</span>';
    button.addEventListener("click", function () {
      window.open(getMiroFishUrl(), "_blank", "noopener,noreferrer");
    });

    wrap.appendChild(button);
    anchor.parentElement.insertBefore(wrap, anchor.nextSibling);
  }

  function ensureMissionButton() {
    if (!document.body || document.getElementById("hugo-mission-button-wrap")) return;

    var anchor = document.getElementById("hugo-mirofish-button-wrap") || document.getElementById("hugo-swarm-button-wrap");
    if (!anchor || !anchor.parentElement) {
      var chatButton = [...document.querySelectorAll("button")].find(function (btn) {
        var text = (btn.textContent || "").trim();
        var rect = btn.getBoundingClientRect();
        return /^(Chat|聊天)$/.test(text) && rect.width > 20 && rect.height > 20 && rect.y < 90;
      });
      if (!chatButton || !chatButton.parentElement || !chatButton.parentElement.parentElement) return;
      anchor = chatButton.parentElement;
    }

    var wrap = document.createElement("span");
    wrap.id = "hugo-mission-button-wrap";
    wrap.className = "relative inline-block";

    var button = document.createElement("button");
    button.id = "hugo-mission-button";
    button.type = "button";
    button.innerHTML = '<span aria-hidden="true">\u{1F3AF}</span><span>Mission</span>';
    button.addEventListener("click", function () {
      window.open(getMissionUrl(), "_blank", "noopener,noreferrer");
    });

    wrap.appendChild(button);
    anchor.parentElement.insertBefore(wrap, anchor.nextSibling);
  }

  applyTheme(getStoredTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureSwitcher, { once: true });
  } else {
    ensureSwitcher();
  }

  window.addEventListener("resize", positionSwitcher);
  window.addEventListener("scroll", positionSwitcher, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSwarmPanel();
  });

  const observer = new MutationObserver(() => {
    ensureSwitcher();
    ensureSwarmButton();
    ensureMiroFishButton();
    ensureMissionButton();
    positionSwitcher();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
