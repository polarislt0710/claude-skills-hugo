(function () {
  "use strict";

  const COMMAND_TYPES = new Set([
    "claude-command",
    "cursor-command",
    "codex-command",
    "gemini-command",
    "cursor-resume",
  ]);

  const state = {
    missions: [],
    activeSlug: null,
    base: null,
    loaded: false,
    reasoningEffort: "medium",
  };

  const REASONING_STORAGE_KEY = "hugo.codex.reasoningEffort";
  const REASONING_OPTIONS = [
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
  ];

  function normalizeReasoningEffort(value) {
    const allowed = new Set(REASONING_OPTIONS.map((option) => option.value));
    return allowed.has(value) ? value : null;
  }

  function loadReasoningEffort() {
    try {
      return normalizeReasoningEffort(localStorage.getItem(REASONING_STORAGE_KEY)) || "medium";
    } catch (_) {
      return "medium";
    }
  }

  function saveReasoningEffort(value) {
    const normalized = normalizeReasoningEffort(value) || "medium";
    state.reasoningEffort = normalized;
    try {
      localStorage.setItem(REASONING_STORAGE_KEY, normalized);
    } catch (_) {}
    updateReasoningControl();
  }

  // ---------- API ----------
  async function fetchMissions() {
    try {
      const res = await fetch("/api/missions", { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.missions = Array.isArray(data.missions) ? data.missions : [];
      state.base = data.base || null;
      state.loaded = true;
      return state.missions;
    } catch (err) {
      console.warn("[hugo-mission] fetchMissions failed", err);
      state.loaded = true;
      return [];
    }
  }

  // ---------- WebSocket monkey-patch ----------
  function injectCommandOptions(payload) {
    try {
      const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (!obj || typeof obj !== "object") return payload;
      if (!COMMAND_TYPES.has(obj.type)) return payload;
      const options = obj.options && typeof obj.options === "object" ? obj.options : {};
      const nextOptions = { ...options };
      if (state.activeSlug) nextOptions.missionSlug = state.activeSlug;
      if (obj.type === "codex-command") nextOptions.reasoningEffort = state.reasoningEffort;
      obj.options = nextOptions;
      return JSON.stringify(obj);
    } catch (_) {
      return payload;
    }
  }

  function patchWebSocket() {
    if (typeof WebSocket === "undefined") return;
    if (WebSocket.prototype.__hugoMissionPatched) return;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && data.length > 0 && data[0] === "{") {
        const mutated = injectCommandOptions(data);
        return originalSend.call(this, mutated);
      }
      return originalSend.call(this, data);
    };
    WebSocket.prototype.__hugoMissionPatched = true;
  }

  // ---------- Reasoning selector ----------
  function updateReasoningControl() {
    const panel = document.getElementById("hugo-codex-reasoning");
    if (!panel) return;
    for (const button of panel.querySelectorAll("[data-reasoning-effort]")) {
      const active = button.getAttribute("data-reasoning-effort") === state.reasoningEffort;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function mountReasoningControl() {
    if (document.getElementById("hugo-codex-reasoning")) {
      updateReasoningControl();
      return;
    }
    const panel = document.createElement("div");
    panel.id = "hugo-codex-reasoning";
    panel.setAttribute("aria-label", "Codex reasoning effort");
    panel.innerHTML = `
      <span class="hugo-codex-reasoning-label">思考</span>
      <div class="hugo-codex-reasoning-options">
        ${REASONING_OPTIONS.map((option) => (
          `<button type="button" data-reasoning-effort="${option.value}" aria-pressed="false">${option.label}</button>`
        )).join("")}
      </div>
    `;
    panel.addEventListener("click", (event) => {
      const button = event.target && event.target.closest
        ? event.target.closest("[data-reasoning-effort]")
        : null;
      if (!button) return;
      saveReasoningEffort(button.getAttribute("data-reasoning-effort"));
    });
    document.body.appendChild(panel);
    updateReasoningControl();
  }

  // ---------- Bootstrap ----------
  async function init() {
    state.reasoningEffort = loadReasoningEffort();
    patchWebSocket();
    mountReasoningControl();
    const oldPanel = document.getElementById("hugo-mission-panel");
    if (oldPanel) oldPanel.remove();
    state.activeSlug = null;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
