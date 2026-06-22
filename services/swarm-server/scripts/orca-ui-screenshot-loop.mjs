#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_ROUTES = [
  { key: "teacher", roleCode: "teacher", path: "/teacher", expectVisible: true },
  { key: "panel_head", roleCode: "panel_head", path: "/panel-head", expectVisible: true },
  { key: "principal", roleCode: "principal", path: "/principal", expectVisible: true },
  { key: "admin", roleCode: "admin", path: "/admin", expectVisible: true },
];

const DEFAULT_VIEWPORTS = [
  { key: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
  { key: "tablet", width: 820, height: 1180, deviceScaleFactor: 1 },
  { key: "mobile", width: 390, height: 844, deviceScaleFactor: 2 },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "1";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function slug(value, fallback = "run") {
  const text = String(value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

function parseRoutes(value) {
  if (!value) return DEFAULT_ROUTES;
  return String(value).split(",").map((item) => {
    const [left, right] = item.split(":");
    const key = slug(left || right || "route");
    const routePath = right || left || "/";
    return {
      key,
      roleCode: key.replace(/-/g, "_"),
      path: routePath.startsWith("/") ? routePath : `/${routePath}`,
      expectVisible: true,
    };
  });
}

function parseViewports(value) {
  if (!value) return DEFAULT_VIEWPORTS;
  return String(value).split(",").map((item) => {
    const [name, size] = item.includes(":") ? item.split(":") : ["viewport", item];
    const [width, height] = String(size || "").split("x").map((n) => Number(n));
    if (!width || !height) throw new Error(`Invalid viewport: ${item}`);
    const key = slug(name || `${width}x${height}`);
    return { key, width, height, deviceScaleFactor: key.includes("mobile") ? 2 : 1 };
  });
}

function isOff(value) {
  return /^(0|false|no|off)$/i.test(String(value || ""));
}

function identityFor(route) {
  const roleCode = route.roleCode || route.key.replace(/-/g, "_");
  return {
    id: `visual-${roleCode}`,
    role_code: roleCode,
    display_name: "Visual QA",
    scope_label: "Screenshot loop",
    home_path: route.path,
  };
}

async function installMockAuth(page, route) {
  const roleCode = route.roleCode || route.key.replace(/-/g, "_");
  const identity = identityFor(route);

  await page.route("**/api/**", async (routeRequest) => {
    const url = new URL(routeRequest.request().url());
    if (url.pathname === "/api/auth/me") {
      await routeRequest.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "visual-qa-user",
            email: "visual-qa@orca.dev",
            display_name: "Visual QA",
            role: roleCode,
            tenant_id: "visual-qa-tenant",
          },
          identities: [identity],
          active_identity_id: identity.id,
          active_role: roleCode,
        }),
      });
      return;
    }
    if (url.pathname === "/api/me/scope") {
      await routeRequest.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ classes: [], subjects: [] }),
      });
      return;
    }
    await routeRequest.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.addInitScript(({ roleCode: rc, identity: id }) => {
    localStorage.removeItem("orca_token");
    localStorage.setItem("orca_user", JSON.stringify({
      id: "visual-qa-user",
      email: "visual-qa@orca.dev",
      display_name: "Visual QA",
      role: rc,
      tenant_id: "visual-qa-tenant",
    }));
    localStorage.setItem("orca_identities", JSON.stringify([id]));
    localStorage.setItem("orca_active_identity", JSON.stringify(id));
  }, { roleCode, identity });
}

async function captureOne({ browser, baseUrl, outDir, route, viewport, mockAuth, waitMs, soft, strictPath }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (mockAuth) await installMockAuth(page, route);

  const targetUrl = new URL(route.path, baseUrl).toString();
  const result = {
    route: route.key,
    roleCode: route.roleCode,
    path: route.path,
    viewport: `${viewport.width}x${viewport.height}`,
    viewportKey: viewport.key,
    url: targetUrl,
    status: null,
    finalPath: "",
    screenshot: "",
    bodyTextLength: 0,
    horizontalOverflow: false,
    blank: false,
    consoleErrorCount: 0,
    pageErrorCount: 0,
    consoleErrors: [],
    pageErrors: [],
    pass: false,
    failures: [],
    warnings: [],
  };

  try {
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    result.status = response ? response.status() : null;
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    if (waitMs) await page.waitForTimeout(waitMs);

    const metrics = await page.evaluate(() => ({
      path: window.location.pathname,
      bodyText: document.body.innerText || "",
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      title: document.title || "",
    }));
    result.finalPath = metrics.path;
    result.bodyTextLength = metrics.bodyText.trim().length;
    result.horizontalOverflow = metrics.scrollWidth > metrics.clientWidth + 2;
    result.blank = result.bodyTextLength < 20;
    result.warnings = [
      metrics.bodyText.includes("undefined") ? "body contains undefined" : "",
      metrics.bodyText.includes("NaN") ? "body contains NaN" : "",
    ].filter(Boolean);

    const fileName = `${route.key}-${viewport.key}.png`;
    result.screenshot = join(outDir, fileName);
    await page.screenshot({ path: result.screenshot, fullPage: true });
  } catch (error) {
    result.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    result.consoleErrorCount = consoleErrors.length;
    result.pageErrorCount = pageErrors.length;
    result.consoleErrors = consoleErrors.slice(0, 10);
    result.pageErrors = pageErrors.slice(0, 10);
    await context.close();
  }

  if (result.status && result.status >= 500) result.failures.push(`HTTP ${result.status}`);
  if (route.expectVisible && result.finalPath && result.finalPath !== route.path) {
    const message = `redirected to ${result.finalPath}`;
    if (strictPath) result.failures.push(message);
    else result.warnings.push(message);
  }
  if (result.horizontalOverflow) result.failures.push("horizontal overflow");
  if (result.blank) result.failures.push("blank or near-blank page");
  if (result.pageErrorCount) result.failures.push(`page errors: ${result.pageErrorCount}`);
  if (result.consoleErrorCount && !soft) result.failures.push(`console errors: ${result.consoleErrorCount}`);
  result.pass = result.failures.length === 0;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log([
      "Usage:",
      "  node ~/services/swarm-server/scripts/orca-ui-screenshot-loop.mjs --project /home/hugo-orca/orca-platform-mvp/apps/mvp-web/frontend --base-url http://127.0.0.1:8003 --loop mvp-ui --phase before",
      "",
      "Options:",
      "  --phase before|after|fix",
      "  --loop <id>",
      "  --routes teacher:/teacher,panel_head:/panel-head,principal:/principal,admin:/admin",
      "  --viewports desktop:1440x900,mobile:390x844",
      "  --mock-auth 0    Use real auth/session instead of mocked role identity",
      "  --strict-path    Fail if a role route redirects to another path",
      "  --soft          Do not fail on console errors",
    ].join("\n"));
    return;
  }

  const project = resolve(args.project || process.cwd());
  const baseUrl = args["base-url"] || args.baseUrl || process.env.ORCA_BASE_URL || "http://127.0.0.1:8003";
  const loop = slug(args.loop || process.env.SWARM_RUN_ID || new Date().toISOString().slice(0, 19), "ui-loop");
  const phase = slug(args.phase || "before", "before");
  const waitMs = Number(args.wait || args["wait-ms"] || 1200);
  const mockAuth = !isOff(args["mock-auth"] ?? args.mockAuth ?? "1");
  const soft = !!args.soft || isOff(args["fail-on-console"]);
  const strictPath = !!args["strict-path"] || !!args.strictPath;
  const routes = parseRoutes(args.routes);
  const viewports = parseViewports(args.viewports);

  if (!existsSync(join(project, "package.json"))) {
    throw new Error(`Project frontend package.json not found: ${project}`);
  }

  const requireFromProject = createRequire(join(project, "package.json"));
  const { chromium } = requireFromProject("playwright");

  const loopDir = resolve(project, "artifacts", "ui-visual-qa", loop);
  const outDir = join(loopDir, phase);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const results = [];
  try {
    for (const route of routes) {
      for (const viewport of viewports) {
        const result = await captureOne({ browser, baseUrl, outDir, route, viewport, mockAuth, waitMs, soft, strictPath });
        results.push(result);
        console.log(`${result.pass ? "PASS" : "FAIL"} ${route.key} ${route.path} ${viewport.key} screenshot=${result.screenshot || "-"} failures=${result.failures.join("|") || "none"}`);
      }
    }
  } finally {
    await browser.close();
  }

  const summary = {
    loop,
    phase,
    project,
    baseUrl,
    mockAuth,
    capturedAt: new Date().toISOString(),
    outDir,
    pass: results.every((item) => item.pass),
    failed: results.filter((item) => !item.pass).length,
    total: results.length,
    results,
  };
  writeFileSync(join(outDir, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const manifestPath = join(loopDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { loop, project, baseUrl, phases: {} };
  manifest.project = project;
  manifest.baseUrl = baseUrl;
  manifest.updatedAt = summary.capturedAt;
  manifest.phases[phase] = {
    capturedAt: summary.capturedAt,
    pass: summary.pass,
    failed: summary.failed,
    total: summary.total,
    outDir,
    resultsJson: join(outDir, "results.json"),
    screenshots: results.map((item) => item.screenshot).filter(Boolean),
  };
  const phaseKeys = Object.keys(manifest.phases);
  manifest.latestPhase = phase;
  manifest.compare = {
    before: manifest.phases.before ? manifest.phases.before.resultsJson : null,
    latest: manifest.phases[phase].resultsJson,
    availablePhases: phaseKeys,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nUI screenshot loop ${summary.pass ? "PASS" : "FAIL"} ${summary.failed}/${summary.total} failed`);
  console.log(`Results: ${join(outDir, "results.json")}`);
  console.log(`Manifest: ${manifestPath}`);
  if (!summary.pass) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
