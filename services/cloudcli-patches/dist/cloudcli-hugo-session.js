(function () {
  "use strict";

  // Git/Session status chip for CloudCLI. Polls /api/git-status and surfaces
  // branch / uncommitted count / last auto-save / concurrent-session warnings,
  // plus a manual "Wrap & Push" button (POST /api/git-status/wrap).

  const POLL_MS = 15000;
  const state = { data: null, open: false, busy: false, slug: null };

  // Reuse the mission overlay's active slug if it exposes one; else null (repo-wide).
  function activeSlug() {
    try {
      return (window.__hugoMission && window.__hugoMission.activeSlug) || state.slug || null;
    } catch (_) {
      return null;
    }
  }

  async function fetchStatus() {
    try {
      const slug = activeSlug();
      const url = "/api/git-status" + (slug ? "?slug=" + encodeURIComponent(slug) : "");
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.data = await res.json();
    } catch (err) {
      state.data = { ok: false, error: String(err && err.message || err) };
    }
    render();
  }

  async function wrapAndPush() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      const slug = activeSlug();
      const res = await fetch("/api/git-status/wrap", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slug ? { slug } : {}),
      });
      const out = await res.json();
      flash(out && out.pushed
        ? "✅ Pushed → " + (out.branch || "session branch")
        : "⚠️ " + (out && (out.error || out.raw) || "wrap done, not pushed"));
    } catch (err) {
      flash("❌ " + String(err && err.message || err));
    } finally {
      state.busy = false;
      fetchStatus();
    }
  }

  function flash(msg) {
    const el = document.getElementById("hugo-session-flash");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 4200);
  }

  // ---------- DOM ----------
  function ensureRoot() {
    let root = document.getElementById("hugo-session-chip");
    if (root) return root;
    root = document.createElement("div");
    root.id = "hugo-session-chip";
    root.innerHTML =
      '<button id="hugo-session-pill" type="button" aria-haspopup="true">' +
        '<span class="hsc-dot"></span>' +
        '<span class="hsc-branch">…</span>' +
        '<span class="hsc-dirty"></span>' +
      '</button>' +
      '<div id="hugo-session-pop" hidden></div>' +
      '<div id="hugo-session-flash"></div>';
    document.body.appendChild(root);
    root.querySelector("#hugo-session-pill").addEventListener("click", (e) => {
      e.stopPropagation();
      state.open = !state.open;
      render();
    });
    document.addEventListener("click", (e) => {
      if (state.open && !root.contains(e.target)) { state.open = false; render(); }
    });
    return root;
  }

  function timeAgo(s) { return s || "—"; }

  function render() {
    const root = ensureRoot();
    const d = state.data || {};
    const pill = root.querySelector("#hugo-session-pill");
    const dot = root.querySelector(".hsc-dot");
    const branchEl = root.querySelector(".hsc-branch");
    const dirtyEl = root.querySelector(".hsc-dirty");
    const pop = root.querySelector("#hugo-session-pop");

    let level = "ok";
    if (!d.ok) level = "off";
    else if (d.collision) level = "warn";
    else if (d.dirty > 0) level = "dirty";
    pill.setAttribute("data-level", level);
    dot.setAttribute("data-level", level);

    branchEl.textContent = d.ok ? (d.branch || "?") : "no git";
    dirtyEl.textContent = d.ok && d.dirty > 0 ? "●" + d.dirty : "";

    pop.hidden = !state.open;
    if (!state.open) return;

    if (!d.ok) {
      pop.innerHTML = '<div class="hsc-row hsc-muted">唔係 git repo<br>' +
        (d.error ? String(d.error) : "") + "</div>";
      return;
    }
    const sessions = Array.isArray(d.activeSessions) ? d.activeSessions : [];
    pop.innerHTML =
      '<div class="hsc-head">' + (d.repo || "repo") + " · <b>" + (d.branch || "?") + "</b></div>" +
      '<div class="hsc-row"><span>未 commit</span><b>' + (d.dirty || 0) + " file(s)</b></div>" +
      '<div class="hsc-row"><span>上次 auto-save</span><b>' + timeAgo(d.lastAutoSave) + "</b></div>" +
      (d.lastCommit
        ? '<div class="hsc-row hsc-commit"><span>' + d.lastCommit.hash + "</span> " +
            escapeHtml(d.lastCommit.subject || "") + "</div>"
        : "") +
      (sessions.length > 1
        ? '<div class="hsc-warn">⚠️ ' + sessions.length + ' 個 session 改緊呢個 repo：<br>' +
            sessions.map((s) => "· " + escapeHtml(s.branch || "?")).join("<br>") + "</div>"
        : '<div class="hsc-row hsc-muted">1 個 session（無撞）</div>') +
      '<button id="hugo-session-wrap" type="button"' + (state.busy ? " disabled" : "") + ">" +
        (state.busy ? "Pushing…" : "📦 Wrap & Push 收工") + "</button>" +
      '<div class="hsc-foot">每 turn 自動 commit · 收工 push 去 session/… branch</div>';

    const btn = pop.querySelector("#hugo-session-wrap");
    if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); wrapAndPush(); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function init() {
    ensureRoot();
    render();
    fetchStatus();
    setInterval(fetchStatus, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
