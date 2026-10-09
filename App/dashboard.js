"use strict";

/* ========================================================================
 *  Dashboard
 *
 *  Same pattern as setup-wizard.js: a tiny local HTTP server on a random
 *  127.0.0.1 port, opened on demand in the system browser (tray menu ->
 *  "Open Dashboard"), and closed again once the tab is closed / a fresh
 *  request hasn't come in for a while. Unlike the wizard, this isn't a
 *  one-shot flow — it stays up while the tab is open and polls /data for
 *  live-ish status.
 *
 *  It reads/writes the same files server.js and tray.js already use
 *  (helper-config.json, the .engine-status.json / helper-events.jsonl /
 *  last-upload.json the running helper writes). It does NOT talk to a
 *  running server.js process directly — config changes made here take
 *  effect the next time the helper (re)starts, exactly like changing
 *  destination from the tray menu already works today.
 * ==================================================================== */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, "helper-config.json");
const INCOMING = path.join(APP_DIR, "incoming");
const ENGINE_STATUS_FILE = path.join(INCOMING, ".engine-status.json");
const BATCH_STATUS_FILE = path.join(INCOMING, ".batch-status.json");
const HOTKEY_STATUS_FILE = path.join(INCOMING, ".hotkey-status.json");
const PRESET_REQUEST_FILE = path.join(INCOMING, ".preset-request.json");
const PRESET_RESULT_FILE = path.join(INCOMING, ".preset-result.json");
const EVENTS_FILE = path.join(APP_DIR, "helper-events.jsonl");
const LICENSE_CACHE_FILE = path.join(APP_DIR, "license-cache.json");
const LAST_UPLOAD_FILE = path.join(APP_DIR, "last-upload.json");
const GOOGLE_TOKEN_FILE = path.join(APP_DIR, "google-token.json");
const PACKAGE_FILE = path.join(APP_DIR, "package.json");

// Plugin install/uninstall/version — same installer/uninstaller .bat
// files the setup wizard uses, just triggered from here too now.
const CEP_EXTENSIONS_DIR = path.join(process.env.APPDATA || "", "Adobe", "CEP", "extensions");
const upia = require("./upia.js");
const diagnostics = require("./diagnostics.js");
const legal = require("./legal.js");
const uploadHistory = require("./history.js");
const presetStore = require("./presets.js");
const hotkey = require("./hotkey.js");
const pluginUpdates = require("./plugin-updates.js");
const PLUGINS = {
    ae: {
        kind: "cep",
        label: "After Effects panel",
        extId: "com.spidx.uploader.ae",
        installer: path.join(APP_DIR, "..", "CEP-AE", "Install AE Panel.bat"),
        uninstaller: path.join(APP_DIR, "..", "CEP-AE", "Uninstall AE Panel.bat"),
        bundledManifest: path.join(APP_DIR, "..", "CEP-AE", "CSXS", "manifest.xml")
    },
    ppro: {
        kind: "cep",
        label: "Premiere Pro panel",
        extId: "com.spidx.uploader.ppro",
        installer: path.join(APP_DIR, "..", "CEP-PPRO", "Install PPRO Panel.bat"),
        uninstaller: path.join(APP_DIR, "..", "CEP-PPRO", "Uninstall PPRO Panel.bat"),
        bundledManifest: path.join(APP_DIR, "..", "CEP-PPRO", "CSXS", "manifest.xml")
    },
    // VEGAS Pro: a compiled .NET extension (.dll) built on the user's machine
    // against their own VEGAS install by VEGAS-Plugin\install-vegas.js, which
    // also records what it installed in vegas-install.json (read below).
    vegas: {
        kind: "vegas",
        label: "VEGAS Pro plugin",
        installer: path.join(APP_DIR, "..", "VEGAS-Plugin", "Install VEGAS Plugin.bat"),
        uninstaller: path.join(APP_DIR, "..", "VEGAS-Plugin", "Uninstall VEGAS Plugin.bat"),
        bundledVersionFile: path.join(APP_DIR, "..", "VEGAS-Plugin", "version.txt"),
        recordFile: path.join(process.env.APPDATA || "", "Spidx Uploader", "vegas-install.json")
    },
    // UXP, not CEP: one packaged .ccx, installed/removed through Adobe's
    // UPIA tool instead of a .bat copying files into a CEP extensions
    // folder. No manifest.xml to diff against, so "installed"/"needs
    // update" can't be detected the way the CEP panels' status is -- see
    // readPluginStatus() below. Filename/id must match Installer\SpidxUploader.iss.
    ps: {
        kind: "upia",
        label: "Photoshop panel",
        pluginId: "com.spidx.workupload", // from the .ccx's manifest.json "id"
        // The display name from the same manifest. UPIA documents /list and
        // /remove in terms of the NAME, and /list all doesn't necessarily
        // print the id - so both are matched.
        names: ["Spidx Uploader"],
        ccx: path.join(APP_DIR, "..", "UXP", "com.spidx.workupload_PS.ccx"),
        // Installed/removed by elevated scripts that run Adobe's UPIA as
        // Administrator (run without admin rights UPIA rejects the .ccx).
        installer: path.join(APP_DIR, "..", "UXP", "Install PS Panel.bat"),
        uninstaller: path.join(APP_DIR, "..", "UXP", "Uninstall PS Panel.bat")
    }
};

function readManifestVersion(manifestPath) {
    try {
        const xml = fs.readFileSync(manifestPath, "utf8");
        const m = xml.match(/ExtensionBundleVersion\s*=\s*"([^"]+)"/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

// Real Photoshop-panel install state, filled in by asking UPIA directly
// (see upia.listInstalled) since there's no manifest.xml to check the way
// the CEP panels work. null/false until the first check completes, so the
// UI can show "checking..." instead of confidently guessing wrong.
let psInstallStatus = { checked: false, installed: false, version: null };
function refreshPsInstallStatus(log) {
    const psPlugin = PLUGINS.ps;
    upia.listInstalled(psPlugin.pluginId, log, (installed, message, info) => {
        if (installed === null) {
            log(`Could not determine Photoshop panel install status: ${message}`);
            return; // leave the previous known state alone rather than guess
        }
        psInstallStatus = { checked: true, installed, version: installed && info ? info.version : null };
    }, { names: psPlugin.names });
}

// After the elevated installer/uninstaller window is opened, keep re-asking
// UPIA for the real state every few seconds (for up to ~3 minutes, stopping as
// soon as it changes) so the Dashboard flips to "installed"/"not installed"
// by itself once the console window finishes.
let psWatchTimer = null;
function watchPsInstall(log) {
    clearInterval(psWatchTimer);
    const before = psInstallStatus.checked ? psInstallStatus.installed : null;
    let ticks = 0;
    psWatchTimer = setInterval(() => {
        ticks++;
        refreshPsInstallStatus(log);
        const changed = before !== null && psInstallStatus.checked && psInstallStatus.installed !== before;
        if (changed || ticks >= 36) clearInterval(psWatchTimer);
    }, 5000);
}

function isNewerPsVersion(latest, current) {
    const parts = v => String(v).split(".").map(n => parseInt(n, 10) || 0);
    const a = parts(latest);
    const b = parts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
}

function readPluginStatus(key) {
    const p = PLUGINS[key];
    if (p.kind === "upia") {
        // UPIA has no manifest.xml to diff a version out of, so this only
        // reports whether we HAVE something to install, not whether
        // Photoshop already has it — the button always reads "Install"
        // rather than "Update".
        return {
            label: p.label,
            kind: "upia",
            ccxAvailable: fs.existsSync(p.ccx) && fs.existsSync(p.installer),
            upiaAvailable: !!upia.getUpiaPath(),
            // Real install state, from actually asking UPIA (see
            // refreshPsInstallStatus below) — ccxAvailable/upiaAvailable
            // above only ever said "could I install this", never "is it
            // already installed", which is what made Install stay
            // clickable and Uninstall look available right after a
            // successful install.
            checked: psInstallStatus.checked,
            installed: psInstallStatus.installed,
            installedVersion: psInstallStatus.installed ? psInstallStatus.version : null,
            bundledVersion: upia.readCcxVersion(p.ccx),
            needsUpdate: !!(psInstallStatus.installed && psInstallStatus.version && upia.readCcxVersion(p.ccx) && isNewerPsVersion(upia.readCcxVersion(p.ccx), psInstallStatus.version))
        };
    }
    if (p.kind === "vegas") {
        let record = null;
        try { record = JSON.parse(fs.readFileSync(p.recordFile, "utf8")); } catch {}
        const stillThere = !!(record && Array.isArray(record.dlls) && record.dlls.some(f => fs.existsSync(f)));
        let bundled = null;
        try { bundled = fs.readFileSync(p.bundledVersionFile, "utf8").trim() || null; } catch {}
        const installedVersion = stillThere ? (record.version || "unknown") : null;
        return {
            label: p.label,
            kind: "vegas",
            installed: stillThere,
            installedVersion,
            bundledVersion: bundled,
            needsUpdate: !!(installedVersion && bundled && installedVersion !== bundled)
        };
    }
    const installedManifest = path.join(CEP_EXTENSIONS_DIR, p.extId, "CSXS", "manifest.xml");
    const installedVersion = readManifestVersion(installedManifest);
    const bundledVersion = readManifestVersion(p.bundledManifest);
    return {
        label: p.label,
        kind: "cep",
        installed: installedVersion !== null,
        installedVersion,
        bundledVersion,
        // Only meaningful when both are known — a plain string compare is
        // fine here since every version we ship is a clean "X.Y.Z" triple.
        needsUpdate: !!(installedVersion && bundledVersion && installedVersion !== bundledVersion)
    };
}

function readAppVersion() {
    try {
        return JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8")).version || null;
    } catch {
        return null;
    }
}

// See the matching function in setup-wizard.js for why this waits for a
// real "spawn"/"error" event instead of answering the instant spawn() is
// called — that's what made previous failures invisible.
function spawnBatFile(batPath, log, cb) {
    let done = false;
    const finish = (ok, message) => {
        if (done) return;
        done = true;
        cb(ok, message);
    };
    try {
        const child = spawn(`"${batPath}"`, [], { shell: true, windowsHide: false, detached: true, cwd: path.dirname(batPath) });
        child.once("spawn", () => finish(true, null));
        child.once("error", err => {
            log(`Could not start ${batPath}: ${err.message}`);
            finish(false, err.message);
        });
        child.on("exit", code => log(`${path.basename(batPath)} window closed (exit code ${code}).`));
        child.unref();
        setTimeout(() => finish(true, null), 1200);
    } catch (err) {
        finish(false, err.message);
    }
}

const VALID_BROWSERS = ["auto", "chrome", "edge", "brave", "firefox", "opera", "opera-gx"];
const VALID_DESTINATIONS = ["workupload", "drive"];
const DRIVE_TIERS = new Set(["pro", "dev", "tester"]);

function readHelperConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        return {};
    }
}

function writeHelperConfig(raw) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), "utf8");
}

// What the Client-presets card shows: every preset with its short description, which one is active and
// whether the helper's current setup has drifted from it ("modified").
function presetSummaries(cfg) {
    try {
        const { presets, activePreset } = presetStore.loadPresets(CONFIG_FILE);
        const current = { destination: cfg.destination, drive: cfg.drive, compression: cfg.compression, cameraRawPreset: cfg.cameraRawPreset };
        return {
            active: activePreset,
            items: presets.map(p => ({
                name: p.name,
                summary: presetStore.describePreset(p),
                active: p.name === activePreset,
                modified: p.name === activePreset && !presetStore.matchesConfig(p, current)
            }))
        };
    } catch {
        return { active: null, items: [] };
    }
}

// Global shortcut: the saved settings + what the background program reports about itself.
function hotkeyInfo(cfg) {
    let status = null;
    try {
        status = JSON.parse(fs.readFileSync(HOTKEY_STATUS_FILE, "utf8"));
        if (!status.updatedAt || Date.now() - status.updatedAt > 15000) status = null;   // the program writes it every 5 s
    } catch {}
    return { config: hotkey.sanitizeHotkey(cfg.hotkey), status, state: hotkey.getState() };
}

function engineIsFresh() {
    const s = readEngineStatus();
    return !!(s && s.updatedAt && Date.now() - s.updatedAt < 20000);
}

function readEngineStatus() {
    try {
        return JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, "utf8"));
    } catch {
        return null;
    }
}

function readBatchStatus() {
    try {
        return JSON.parse(fs.readFileSync(BATCH_STATUS_FILE, "utf8"));
    } catch {
        return null;
    }
}

function readLastUpload() {
    try {
        return JSON.parse(fs.readFileSync(LAST_UPLOAD_FILE, "utf8"));
    } catch {
        return null;
    }
}

// helper-events.jsonl already exists (server.js writes one line per
// pipeline step) — this just tails it and turns each line into a short,
// human-readable summary. Newest first.
function readRecentEvents(limit) {
    let lines;
    try {
        lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
    } catch {
        return [];
    }

    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (!e || !e.step) continue;

        // Only surface the events that mean something to a human at a
        // glance — skip the fine-grained per-attempt/per-step noise.
        if (!["batch", "queue", "google_signin", "license_check"].includes(e.step)) continue;

        out.push({
            time: e.t || null,
            step: e.step,
            status: e.status,
            summary: summarizeEvent(e)
        });
    }
    return out;
}

function summarizeEvent(e) {
    const extra = e.extra || {};
    switch (e.step) {
        case "batch":
            if (e.status === "start") return `Batch started — ${extra.count || "?"} file(s)`;
            if (e.status === "ok") return `Batch uploaded — ${extra.count || "?"} file(s), ${extra.linksFound || 0} link(s) found`;
            if (e.status === "fail") return `Batch failed — ${(extra.failedFiles || []).length} file(s) could not be sent`;
            return "Batch event";
        case "queue":
            return `${extra.count || "?"} file(s) queued (${extra.queueLength || "?"} in queue)`;
        case "google_signin":
            if (e.status === "ok") return `Signed in as ${extra.email || "unknown"}`;
            if (e.status === "fail") return "Google sign-in failed";
            return "Google sign-in";
        case "license_check":
            if (e.status === "ok") return "Tier check completed";
            if (e.status === "fail") return "Tier check failed — using cached/default tier";
            return "Tier check";
        default:
            return e.step;
    }
}

function openInBrowser(url, log) {
    try {
        const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
        const rundll32Path = path.join(systemRoot, "System32", "rundll32.exe");
        const child = spawn(rundll32Path, ["url.dll,FileProtocolHandler", url], { windowsHide: true });
        child.on("error", err => log(`Could not auto-open the browser (use the URL above manually): ${err.message}`));
    } catch (err) {
        log(`Could not auto-open the browser (use the URL above manually): ${err.message}`);
    }
}

function buildData() {
    const cfg = readHelperConfig();
    const status = readEngineStatus();
    const tier = status && status.tier ? status.tier : null;
    const destination = (status && status.destination) || cfg.destination || "workupload";

    return {
        tier, // the rank (free / pro / dev / tester)
        roles: status && Array.isArray(status.roles) ? status.roles : (tier ? [tier] : []), // all roles, e.g. ["pro","spt"]
        deviceLimitReached: !!(status && status.deviceLimitReached),
        trialDaysRemaining: (status && status.trialDaysRemaining) || null,
        expiresAt: (status && status.trialDaysRemaining)
            ? new Date(Date.now() + status.trialDaysRemaining * 86400000).toISOString().slice(0, 10)
            : null, // null = permanent (paid with no trial end) or Free (no expiry to show)
        driveAllowed: tier === null || DRIVE_TIERS.has(tier),
        proFeaturesAllowed: tier === null || DRIVE_TIERS.has(tier), // same tier set — Camera Raw preset routing
        pproAllowed: tier === null || DRIVE_TIERS.has(tier) || (status && Array.isArray(status.roles) && status.roles.indexOf("spt") !== -1), // Premiere panel: Pro rank OR the "spt" role
        engineSeen: !!status,
        statusUpdatedAt: (status && status.updatedAt) || null,
        appVersion: readAppVersion(),
        consent: legal.consentSummary(),
        plugins: { ae: readPluginStatus("ae"), ppro: readPluginStatus("ppro"), vegas: readPluginStatus("vegas"), ps: readPluginStatus("ps") },
        pluginUpdates: pluginUpdates.readCachedPluginUpdates(),
        destination,
        cameraRawPreset: cfg.cameraRawPreset && cfg.cameraRawPreset.actionName
            ? { actionSet: cfg.cameraRawPreset.actionSet || "", actionName: cfg.cameraRawPreset.actionName }
            : null,
        // Saved slots so switching which Action runs doesn't mean retyping
        // Set/Name every time — "activate" just copies a slot's values into
        // the single cameraRawPreset above, which is all server.js/the
        // Photoshop bridge ever actually read.
        cameraRawPresets: Array.isArray(cfg.cameraRawPresets) ? cfg.cameraRawPresets : [],
        settings: {
            preferredBrowser: VALID_BROWSERS.includes(cfg.preferredBrowser) ? cfg.preferredBrowser : "auto",
            autoRetry: {
                enabled: !!(cfg.autoRetry && cfg.autoRetry.enabled),
                maxAttempts: (cfg.autoRetry && cfg.autoRetry.maxAttempts) || 3,
                delaySeconds: (cfg.autoRetry && cfg.autoRetry.delaySeconds) || 10
            },
            notifications: { enabled: !(cfg.notifications && cfg.notifications.enabled === false) },
            cleanup: {
                enabled: !!(cfg.cleanup && cfg.cleanup.enabled),
                afterDays: (cfg.cleanup && cfg.cleanup.afterDays) || 7
            },
            browserIdle: {
                enabled: !!(cfg.browserIdle && cfg.browserIdle.enabled),
                timeoutSeconds: (cfg.browserIdle && cfg.browserIdle.timeoutSeconds) || 120
            },
            batch: { timeoutSeconds: (cfg.batch && cfg.batch.timeoutSeconds) || 120 },
            throttle: {
                enabled: !!(cfg.throttle && cfg.throttle.enabled),
                minMs: (cfg.throttle && cfg.throttle.minMs) || 500,
                maxMs: (cfg.throttle && cfg.throttle.maxMs) || 2000
            },
            compression: presetStore.sanitizeCompression(cfg.compression)
        },
        presets: presetSummaries(cfg),
        hotkey: hotkeyInfo(cfg),
        batch: readBatchStatus(),
        lastUpload: readLastUpload(),
        events: readRecentEvents(12),
        tourSeen: !!cfg.dashboardTourSeen
    };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spidx Uploader — Dashboard</title>
<style>
    :root {
        --bg: #000000;
        --bg-soft: #141416;
        --surface: #1c1c1e;
        --surface-2: #2c2c2e;
        --line: rgba(255,255,255,.10);
        --line-soft: rgba(255,255,255,.07);
        --text: #f5f5f7;
        --text-dim: #98989d;
        --text-faint: #636366;
        --accent: #0a84ff;
        --accent-2: #64d2ff;
        --ok: #30d158;
        --warn: #ff9f0a;
        --err: #ff453a;
        --radius: 14px;
        --shadow: 0 18px 40px -24px rgba(0,0,0,.9);
    }

    * { box-sizing: border-box; }

    html, body {
        margin: 0; padding: 0; min-height: 100%;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 14px;
        -webkit-font-smoothing: antialiased;
    }

    body::before {
        content: "";
        position: fixed; inset: 0 0 auto 0; height: 380px; pointer-events: none;
        background:
            radial-gradient(620px 240px at 18% -40px, rgba(10,132,255,.18), transparent 70%),
            radial-gradient(520px 220px at 82% -60px, rgba(100,210,255,.12), transparent 70%);
    }

    .wrap { position: relative; max-width: 880px; margin: 0 auto; padding: 30px 22px 90px; }

    /* ---------- top bar ---------- */
    .topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
    .mark {
        width: 36px; height: 36px; border-radius: 11px; flex-shrink: 0;
        background: linear-gradient(160deg, #0a84ff, #0060df);
        display: flex; align-items: center; justify-content: center;
        font-size: 17px; font-weight: 700; letter-spacing: -.03em; color: #fff;
        box-shadow: none;
    }
    .brand { display: flex; flex-direction: column; gap: 2px; margin-right: auto; }
    .brand b { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
    .brand span { font-size: 11.5px; color: var(--text-faint); }

    .pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 700;
        letter-spacing: .02em; border: 1px solid var(--line); background: var(--surface);
        color: var(--text-dim); white-space: nowrap;
    }
    .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .pill.live { color: var(--ok); border-color: rgba(47,217,122,.3); background: rgba(47,217,122,.09); }
    .pill.live .dot { animation: breathe 2s ease-in-out infinite; }
    .pill.off { color: var(--text-faint); }
    .pill.warn { color: var(--warn); border-color: rgba(255,176,32,.32); background: rgba(255,176,32,.1); }
    .pill.tier-free { color: #c3c3cc; }
    .pill.tier-pro { color: #ffd60a; border-color: rgba(255,214,10,.3); background: rgba(255,214,10,.09); }
    .pill.tier-dev { color: #c07bff; border-color: rgba(192,123,255,.3); background: rgba(192,123,255,.1); }
    .pill.tier-tester { color: #64d2ff; border-color: rgba(100,210,255,.3); background: rgba(100,210,255,.1); }
    /* ---- upload history ---- */
    .hist-tools { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
    .hist-tools input { flex: 1; min-width: 0; }
    .hist-row { display: grid; grid-template-columns: 112px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; background: var(--surface); animation: fade .2s ease; }
    .hist-when { font-size: 12px; color: var(--text-dim); line-height: 1.4; }
    .hist-when b { display: block; color: var(--text); font-size: 12.5px; }
    .hist-main { min-width: 0; }
    .hist-files { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hist-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .chip { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-dim); }
    .chip.src { background: rgba(10,132,255,.16); color: var(--accent-2); }
    .chip.ps { background: rgba(255,159,10,.14); color: var(--warn); }
    .hist-links { margin-top: 7px; display: flex; flex-direction: column; gap: 3px; }
    .hist-links a { font-size: 12px; color: var(--accent-2); text-decoration: none; word-break: break-all; }
    .hist-links a:hover { text-decoration: underline; }
    .hist-actions { display: flex; gap: 6px; }
    .hist-actions .mini-btn { margin: 0; }

    /* ---- consent banner ---- */
    .legal-banner {
        display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap;
        margin: 0 0 18px; padding: 14px 16px; border-radius: var(--radius); border: 1px solid rgba(255,159,10,.35);
        background: rgba(255,159,10,.08);
    }
    .legal-banner b { display: block; font-size: 13.5px; margin-bottom: 3px; }
    .legal-banner span { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }
    .legal-banner .actions { display: flex; gap: 10px; align-items: center; margin: 0; }
    .legal-banner a { color: var(--accent-2); font-size: 12.5px; text-decoration: none; }
    .legal-banner a:hover { text-decoration: underline; }

    /* ---- legal links (Support card + footer on every tab) ---- */
    .legal-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .legal-link {
        display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; border-radius: 10px;
        border: 1px solid var(--line); background: var(--surface-2); color: var(--text);
        text-decoration: none; font-size: 12.5px; font-weight: 600; transition: border-color .15s ease, transform .1s ease;
    }
    .legal-link:hover { border-color: var(--accent); }
    .legal-link:active { transform: translateY(1px); }
    .legal-link .ext { color: var(--text-faint); font-weight: 500; }
    .legal-foot { margin: 26px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--text-dim); text-align: center; line-height: 1.8; }
    .legal-foot a { color: var(--accent-2); text-decoration: none; }
    .legal-foot a:hover { text-decoration: underline; }
    .pill.tier-spt { color: #ff9f0a; border-color: rgba(255,159,10,.3); background: rgba(255,159,10,.1); }

    @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

    /* ---------- stat tiles ---------- */
    .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 22px; }
    .tile {
        background: linear-gradient(180deg, var(--surface), var(--bg-soft));
        border: 1px solid var(--line-soft); border-radius: var(--radius);
        padding: 15px 16px; min-height: 96px; display: flex; flex-direction: column; gap: 7px;
        box-shadow: var(--shadow);
    }
    .tile .k { font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--text-faint); font-weight: 700; }
    .tile .v { font-size: 17px; font-weight: 700; letter-spacing: -.02em; }
    .tile .s { font-size: 11.5px; color: var(--text-dim); line-height: 1.45; word-break: break-all; }
    .tile .s a { color: var(--accent-2); text-decoration: none; }
    .tile .s a:hover { text-decoration: underline; }

    .mini-btn {
        align-self: flex-start; margin-top: auto;
        border: 1px solid var(--line); background: var(--surface-2); color: var(--text-dim);
        border-radius: 8px; padding: 4px 9px; font-size: 11px; font-weight: 600;
        cursor: pointer; font-family: inherit; transition: .15s ease;
    }
    .mini-btn:hover { color: var(--text); border-color: #3a3a44; }

    /* ---------- tabs ---------- */
    .tabs { display: flex; gap: 4px; padding: 4px; background: var(--bg-soft);
            border: 1px solid var(--line-soft); border-radius: 12px; margin-bottom: 18px; }
    .tab {
        flex: 1; padding: 9px 12px; border-radius: 9px; border: none; background: transparent;
        color: var(--text-dim); font-size: 13px; font-weight: 600; font-family: inherit;
        cursor: pointer; transition: .15s ease;
    }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--surface-2); color: var(--text); box-shadow: 0 1px 0 rgba(255,255,255,.04) inset; }

    .page { display: none; animation: fade .2s ease; }
    .page.active { display: block; }
    @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

    /* ---------- cards ---------- */
    .card {
        background: var(--surface); border: 1px solid var(--line-soft); border-radius: var(--radius);
        padding: 20px 22px; margin-bottom: 14px;
    }
    .card h2 { font-size: 14px; font-weight: 700; margin: 0 0 5px; letter-spacing: -.01em; }
    .card .desc { font-size: 12.5px; color: var(--text-dim); margin: 0 0 16px; line-height: 1.55; }
    .card .desc:last-child { margin-bottom: 0; }

    .note { font-size: 12px; color: var(--text-dim); margin-top: 11px; min-height: 15px; line-height: 1.5; }
    .note.ok { color: var(--ok); }
    .note.err { color: var(--err); }
    .hint { font-size: 11.5px; color: var(--text-dim); margin: 0; line-height: 1.5; opacity: .8; }

    /* ---------- destination picker ---------- */
    .dest-options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .dest-btn {
        position: relative; text-align: left; padding: 14px 15px; border-radius: 13px;
        border: 1.5px solid var(--line); background: var(--bg-soft); color: var(--text);
        font-family: inherit; cursor: pointer; transition: .16s ease;
    }
    .dest-btn .t { display: block; font-size: 13.5px; font-weight: 700; margin-bottom: 3px; }
    .dest-btn .d { display: block; font-size: 11.5px; color: var(--text-dim); line-height: 1.45; }
    .dest-btn:hover:not(:disabled) { border-color: #434350; transform: translateY(-1px); }
    .dest-btn.active {
        border-color: var(--accent);
        background: linear-gradient(180deg, rgba(10,132,255,.25), rgba(10,132,255,.06));
    }
    .dest-btn.active::after {
        content: "✓"; position: absolute; top: 12px; right: 13px;
        font-size: 11px; font-weight: 700; color: var(--accent);
    }
    .dest-btn:disabled { opacity: .38; cursor: not-allowed; }

    /* ---------- forms ---------- */
    input[type="text"], input[type="number"], select {
        background: var(--bg-soft); border: 1px solid var(--line); color: var(--text);
        border-radius: 10px; padding: 9px 11px; font-size: 13px; font-family: inherit;
        transition: border-color .15s ease, box-shadow .15s ease;
    }
    input:focus, select:focus {
        outline: none; border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(10,132,255,.25);
    }
    input::placeholder { color: var(--text-faint); }
    select { width: 150px; }
    input[type="number"] { width: 96px; text-align: right; }

    .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .field label { font-size: 12px; color: var(--text-dim); font-weight: 600; }
    .inline { display: flex; gap: 9px; }
    .inline input { flex: 1; }

    .btn {
        padding: 10px 18px; border-radius: 10px; border: none; cursor: pointer; font-family: inherit;
        font-size: 13px; font-weight: 600; color: #fff;
        background: var(--accent);
        box-shadow: none;
        transition: filter .15s ease, transform .1s ease;
    }
    .btn:hover { filter: brightness(1.12); }
    .btn:active { transform: translateY(1px); }
    .btn.ghost {
        background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--line); box-shadow: none;
    }
    .btn.ghost:hover { color: var(--text); }
    .btn.danger { background: rgba(255,90,82,.12); color: var(--err); border: 1px solid rgba(255,90,82,.3); box-shadow: none; }
    .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 16px; }

    /* ---------- settings rows ---------- */
    .set-group { border: 1px solid var(--line-soft); border-radius: 13px; overflow: hidden; }
    .set-row {
        display: flex; align-items: center; gap: 16px; padding: 13px 15px;
        border-bottom: 1px solid var(--line-soft); background: var(--bg-soft);
    }
    .set-row:last-child { border-bottom: none; }
    .set-row .txt { flex: 1; min-width: 0; }
    .set-row .txt b { display: block; font-size: 13px; font-weight: 600; }
    .set-row .txt span { display: block; font-size: 11.5px; color: var(--text-faint); margin-top: 2px; line-height: 1.45; }
    .set-row.sub { padding-left: 34px; background: var(--surface); }
    .set-row.sub .txt b { font-weight: 500; color: var(--text-dim); font-size: 12.5px; }
    .set-row.locked { opacity: .45; }

    .switch { position: relative; width: 40px; height: 23px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch .track {
        position: absolute; inset: 0; background: #34343c; border-radius: 999px; cursor: pointer;
        transition: background .18s ease;
    }
    .switch .track::before {
        content: ""; position: absolute; width: 17px; height: 17px; left: 3px; top: 3px;
        background: #fff; border-radius: 50%; transition: transform .18s cubic-bezier(.4,0,.2,1);
    }
    .switch input:checked + .track { background: var(--accent); }
    .switch input:checked + .track::before { transform: translateX(17px); }

    /* ---------- activity ---------- */
    .events { list-style: none; margin: 0; padding: 0; }
    .events li {
        display: flex; align-items: flex-start; gap: 12px; padding: 12px 0;
        border-bottom: 1px solid var(--line-soft); font-size: 13px;
    }
    .events li:last-child { border-bottom: none; }
    .events .ev-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: var(--accent-2); flex-shrink: 0; }
    .events .ev-dot.ok { background: var(--ok); }
    .events .ev-dot.fail { background: var(--err); }
    .events .ev-body { flex: 1; min-width: 0; }
    .events .ev-summary { color: #d9d9e0; line-height: 1.45; }
    .events .ev-summary.fail { color: var(--err); }
    .events .ev-time { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; margin-top: 3px; }
    .empty {
        text-align: center; padding: 26px 10px; color: var(--text-faint); font-size: 12.5px;
        border: 1px dashed var(--line); border-radius: 12px;
    }

    /* ---------- save bar ---------- */
    .savebar {
        position: sticky; bottom: 14px; margin-top: 16px;
        display: flex; align-items: center; gap: 12px;
        padding: 12px 16px; border-radius: 14px;
        background: rgba(23,23,27,.92); border: 1px solid var(--line);
        backdrop-filter: blur(14px); box-shadow: var(--shadow);
    }
    .savebar .note { margin-top: 0; }

    /* ---------- toast ---------- */
    #toast {
        position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 18px);
        padding: 11px 18px; border-radius: 11px; font-size: 13px; font-weight: 600;
        background: #26262d; border: 1px solid var(--line); color: var(--text);
        opacity: 0; pointer-events: none; transition: .22s ease; z-index: 50; max-width: 90vw;
    }
    #toast.show { opacity: 1; transform: translate(-50%, 0); }
    #toast.ok { border-color: rgba(47,217,122,.45); color: var(--ok); }
    #toast.err { border-color: rgba(255,90,82,.45); color: var(--err); }

    .banner {
        display: none; align-items: flex-start; gap: 10px; padding: 12px 14px; margin-bottom: 16px;
        border-radius: 12px; font-size: 12.5px; line-height: 1.5;
        background: rgba(255,176,32,.09); border: 1px solid rgba(255,176,32,.3); color: #ffce6a;
    }
    .banner.show { display: flex; }

    @media (max-width: 680px) {
        .tiles { grid-template-columns: 1fr; }
        .dest-options { grid-template-columns: 1fr; }
    }
/* ---------------- first-run tour ---------------- */
.tour-backdrop {
    position: fixed; inset: 0; z-index: 9000;
    background: transparent; /* the spotlight's own box-shadow below does the actual dimming */
    opacity: 0; transition: opacity .2s ease;
    pointer-events: none;
}
.tour-backdrop.show { opacity: 1; pointer-events: auto; }
.tour-spotlight {
    position: fixed; z-index: 9001; pointer-events: none;
    border-radius: 12px;
    box-shadow: 0 0 0 4px var(--accent), 0 0 0 9999px rgba(0,0,0,.55);
    transition: top .25s ease, left .25s ease, width .25s ease, height .25s ease;
}
.tour-bubble {
    position: fixed; z-index: 9002; max-width: 300px;
    background: var(--bg-soft); border: 1px solid var(--line);
    border-radius: 12px; padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
    transition: top .25s ease, left .25s ease;
}
.tour-bubble .step { font-size: 12px; color: var(--text-dim); margin-bottom: 6px; }
.tour-bubble p { margin: 0 0 14px; font-size: 14px; color: var(--text); line-height: 1.5; }
.tour-bubble .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.tour-bubble .skip { font-size: 12px; color: var(--text-faint); cursor: pointer; background: none; border: none; padding: 0; }
.tour-bubble .next { padding: 7px 16px; border-radius: 8px; border: none; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">

    <div class="topbar">
        <div class="mark">S</div>
        <div class="brand">
            <b>Spidx Uploader</b>
            <span>Dashboard</span>
        </div>
        <span class="pill off" id="tierPill"><span class="dot"></span><span id="tierPillText">tier —</span></span>
        <span class="pill off" id="helperPill"><span class="dot"></span><span id="helperPillText">helper —</span></span>
        <span class="pill off" id="tourReplayBtn" style="cursor:pointer;" title="Show the quick tour again">? Tour</span>
    </div>

    <div class="banner" id="deviceBanner">
        <span>⚠</span>
        <div>Device limit reached — this computer is a 3rd device on a paid tier, so it runs as Free. Remove an old device row from the "Devices" tab of your Sheet to free a slot.</div>
    </div>

    <div class="banner" id="expiryBanner">
        <span>⏳</span>
        <div><span id="expiryText"></span> <a href="#" id="expiryEnterCode" style="color:inherit;font-weight:600;">Enter a new code</a></div>
    </div>

    <div class="banner" id="dashboardErrorBanner">
        <span>⚠</span>
        <div id="dashboardErrorText"></div>
    </div>

    <div class="tiles">
        <div class="tile">
            <div class="k">Engine</div>
            <div class="v" id="engineState">—</div>
            <div class="s" id="engineSub">Waiting for the helper to report.</div>
        </div>
        <div class="tile">
            <div class="k">Destination</div>
            <div class="v" id="destValue">—</div>
            <div class="s" id="destSub">Where finished files are sent.</div>
        </div>
        <div class="tile">
            <div class="k">Last upload</div>
            <div class="v" id="lastValue">—</div>
            <div class="s" id="lastSub">Nothing uploaded yet.</div>
            <button class="mini-btn" id="copyLastBtn" style="display:none;">Copy link</button>
        </div>
    </div>

    <div class="legal-banner" id="legalBanner" style="display:none;">
        <div>
            <b id="legalBannerTitle">Please review the Terms of Service, the EULA and the Privacy Policy</b>
            <span id="legalBannerText"></span>
        </div>
        <div class="actions">
            <a href="https://spidxuploader.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
            <a href="https://spidxuploader.com/eula" target="_blank" rel="noopener noreferrer">EULA</a>
            <a href="https://spidxuploader.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
            <button class="btn" id="acceptLegalBtn">I agree</button>
        </div>
    </div>

    <div class="tabs">
        <button class="tab active" data-page="overview">Overview</button>
        <button class="tab" data-page="history">History</button>
        <button class="tab" data-page="account">Account</button>
        <button class="tab" data-page="settings">Settings</button>
        <button class="tab" data-page="activity">Activity</button>
    </div>

    <!-- ============ OVERVIEW ============ -->
    <div class="page active" id="page-overview">

        <div class="card" id="tourCardDest">
            <h2>Upload destination</h2>
            <p class="desc">Switches immediately — the helper restarts itself in the background to apply it.</p>
            <div class="dest-options">
                <button class="dest-btn" id="destWorkupload" data-dest="workupload">
                    <span class="t">WorkUpload</span>
                    <span class="d">Upload — works on every tier.</span>
                </button>
                <button class="dest-btn" id="destDrive" data-dest="drive">
                    <span class="t">Google Drive</span>
                    <span class="d">Upload straight to your own Drive — paid tiers.</span>
                </button>
            </div>
            <div class="note" id="destNote"></div>
        </div>

        <div class="card" id="tourCardPreset">
            <h2>Camera Raw editing preset</h2>
            <p class="desc">Plays a Photoshop Action you recorded once (Window &gt; Actions &gt; record a Camera Raw Filter step) before a file uploads — from the Photoshop panel's own Upload button, and from the After Effects panel's "Photoshop + Upload" button. For After Effects frames specifically, the frame is added as a new layer at the bottom of whatever document is currently active in Photoshop (e.g. your particles/overlay template) — the Action runs on that layer, and the composited result uploads. Leave both fields empty to skip this step and upload as-is.</p>
            <p class="note" id="presetLockedNote" style="display:none;">This is a Pro feature — upgrade your tier to use it.</p>
            <div class="field">
                <label for="presetActionSet">Action Set name</label>
                <p class="hint">The folder your Action lives in, in Photoshop's Actions panel (Window &gt; Actions) — not the Action itself.</p>
                <input type="text" id="presetActionSet" placeholder="e.g. Default Actions">
            </div>
            <div class="field">
                <label for="presetActionName">Action name</label>
                <p class="hint">Must match exactly, spelling and capitalization included, or it won't run.</p>
                <input type="text" id="presetActionName" placeholder="e.g. Spidx Preset">
            </div>
            <div class="actions">
                <button class="btn" id="presetSaveBtn">Save preset Action</button>
                <button class="btn danger" id="presetClearBtn" style="display:none;">Clear</button>
                <span class="note" id="presetNote" style="margin-top:0;"></span>
            </div>
            <div class="field" style="margin-top: 4px;">
                <label>Saved presets</label>
                <p class="hint">Save the Set/Name above as a named slot, then switch which one is active with one click — no retyping.</p>
                <div id="presetSlotList"></div>
                <div class="actions" style="margin-top: 8px;">
                    <button class="btn ghost" id="presetSaveSlotBtn">Save current as new preset</button>
                    <span class="note" id="presetSlotNote" style="margin-top:0;"></span>
                </div>
            </div>
        </div>
    </div>

    <!-- ============ ACCOUNT ============ -->
    <div class="page" id="page-account">

        <div class="card">
            <h2>License</h2>
            <p class="desc" id="licenseSummary">Checking your license...</p>
            <div class="actions" style="margin-top: 0;">
                <button class="btn ghost" id="forceRefreshBtn">Force refresh tier</button>
                <button class="btn danger" id="logoutBtn">Log out</button>
                <span class="note" id="forceRefreshNote" style="margin-top:0;"></span>
                <span class="note" id="logoutNote" style="margin-top:0;"></span>
            </div>
        </div>

        <div class="card">
            <h2>Enter a license code</h2>
            <p class="desc">Got a code with your purchase or from an invite? Enter it to unlock Pro. It's tied to your signed-in Google account, and the helper restarts itself to pick up the new tier.</p>
            <div class="inline">
                <input type="text" id="licenseCodeInput" placeholder="e.g. PRO-XXXX-XXXX" style="text-transform: uppercase;" autocomplete="off" spellcheck="false">
                <button class="btn" id="licenseRedeemBtn">Activate</button>
            </div>
            <div class="note" id="licenseNote"></div>
        </div>

        <div class="card">
            <h2>Devices</h2>
            <p class="desc" id="devicesDesc">Each paid license works on up to 2 computers. Remove one you no longer use to free its slot.</p>
            <div id="deviceList"><p class="hint" style="margin:0;">Loading...</p></div>
            <div class="actions" style="margin-top: 8px;">
                <button class="btn ghost" id="devicesRefreshBtn">Refresh list</button>
                <span class="note" id="devicesNote" style="margin-top:0;"></span>
            </div>
        </div>

        <div class="card">
            <h2>App updates</h2>
            <p class="desc" id="appVersionLine">—</p>
            <div class="actions" style="margin-top: 0;">
                <button class="btn ghost" id="checkUpdateBtn">Check for updates</button>
                <button class="btn" id="installUpdateBtn" style="display:none;">Install update</button>
                <button class="btn ghost" id="openReleaseBtn" style="display:none;">Open release page</button>
                <span class="note" id="updateNote" style="margin-top:0;"></span>
            </div>
        </div>

        <div class="card" id="tourCardPlugins">
            <h2>Plugins</h2>
            <p class="desc">Install, update or remove the After Effects / Premiere Pro panels and the VEGAS Pro plugin. The host app must be closed first — a console window (with an admin prompt) does the actual copy; for VEGAS it also builds the plugin for your VEGAS version.</p>
            <div class="field" id="pluginRowAe">
                <label>After Effects panel — <span id="pluginStatusAe">—</span></label>
                <div class="actions" style="margin-top:6px;">
                    <button class="btn" id="installAeBtn">Install</button>
                    <button class="btn danger" id="uninstallAeBtn" disabled>Uninstall</button>
                </div>
            </div>
            <div class="field" id="pluginRowPpro">
                <label>Premiere Pro panel — <span id="pluginStatusPpro">—</span></label>
                <div class="actions" style="margin-top:6px;">
                    <button class="btn" id="installPproBtn">Install</button>
                    <button class="btn danger" id="uninstallPproBtn" disabled>Uninstall</button>
                </div>
            </div>
            <div class="field" id="pluginRowVegas">
                <label>VEGAS Pro plugin <span style="color: var(--text-faint); font-weight: 500;">(uploading needs Pro)</span> — <span id="pluginStatusVegas">—</span></label>
                <div class="actions" style="margin-top:6px;">
                    <button class="btn" id="installVegasBtn">Install</button>
                    <button class="btn danger" id="uninstallVegasBtn" disabled>Uninstall</button>
                </div>
            </div>
            <div class="field" id="pluginRowPs">
                <label>Photoshop panel — <span id="pluginStatusPs">—</span></label>
                <div class="actions" style="margin-top:6px;">
                    <button class="btn" id="installPsBtn">Install</button>
                    <button class="btn danger" id="uninstallPsBtn" disabled>Uninstall</button>
                    <button class="btn ghost" id="refreshPsStatusBtn">Refresh status</button>
                </div>
            </div>
            <div class="field" id="pluginUpdatesRow">
                <label>Plugin updates — <span id="pluginUpdatesStatus">—</span></label>
                <div class="actions" style="margin-top:6px;">
                    <button class="btn ghost" id="checkPluginUpdatesBtn">Check for plugin updates</button>
                    <button class="btn" id="downloadPluginUpdatesBtn" style="display:none;">Download updates</button>
                </div>
            </div>
            <div class="note" id="pluginNote"></div>
        </div>

        <div class="card">
            <h2>Backup &amp; restore</h2>
            <p class="desc">Backs up your destination, Camera Raw preset, and helper settings — not your Google sign-in (sign in again after restoring on a new machine).</p>
            <div class="actions" style="margin-top: 0;">
                <button class="btn ghost" id="backupBtn">Download backup</button>
                <input type="file" id="restoreFile" accept="application/json" style="display:none;">
                <button class="btn ghost" id="restoreBtn">Restore from file</button>
                <span class="note" id="backupNote" style="margin-top:0;"></span>
            </div>
        </div>

        <div class="card" id="tourCardDiagnostics">
            <h2>Diagnostics</h2>
            <p class="desc">Something not working? Run the self-test to see exactly what is wrong, or create a diagnostics file to send to support. Emails, user names in paths, tokens and secrets are removed from it.</p>
            <div class="actions" style="margin-top: 0;">
                <button class="btn" id="selfTestBtn">Run self-test</button>
                <button class="btn ghost" id="makeDiagBtn">Create diagnostics file</button>
                <span class="note" id="diagNote" style="margin-top:0;"></span>
            </div>
            <div id="selfTestResults" style="margin-top: 12px;"></div>
        </div>

        <div class="card" id="legalCard">
            <h2>Support &amp; legal</h2>
            <p class="desc" id="supportLine">Questions or a bug to report? <a href="#" id="supportLink" style="display:none;">Contact support</a><span id="supportFallback">— link not set up yet.</span></p>
            <p class="desc" style="margin-bottom: 0;">The Terms of Service say how Spidx Uploader may be used, the EULA is the software licence, and the Privacy Policy explains what is sent where (sign-in and license check, uploads, update checks) and what stays on your computer. Refunds and the Thumbnail Pack licence have their own pages.</p>
            <p class="desc" id="consentLine" style="margin: 12px 0 0;"></p>
            <div class="legal-row">
                <a class="legal-link" id="termsLink" href="https://spidxuploader.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service <span class="ext">&#8599;</span></a>
                <a class="legal-link" id="eulaLink" href="https://spidxuploader.com/eula" target="_blank" rel="noopener noreferrer">EULA <span class="ext">&#8599;</span></a>
                <a class="legal-link" id="privacyLink" href="https://spidxuploader.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy <span class="ext">&#8599;</span></a>
                <a class="legal-link" id="refundLink" href="https://spidxuploader.com/refund" target="_blank" rel="noopener noreferrer">Refunds <span class="ext">&#8599;</span></a>
                <a class="legal-link" id="siteLink" href="https://spidxuploader.com/" target="_blank" rel="noopener noreferrer">spidxuploader.com <span class="ext">&#8599;</span></a>
            </div>
        </div>
    </div>

    <!-- ============ HISTORY ============ -->
    <div class="page" id="page-history">
        <div class="card">
            <h2>Upload history</h2>
            <p class="desc">Your latest uploads with their links - copy a link again any time. Stored only on this computer (App\\upload-history.json), newest first, up to 500 entries.</p>
            <div class="hist-tools">
                <input type="text" id="histSearch" placeholder="Search file name, folder, client...">
                <button class="btn ghost" id="histClearBtn">Clear history</button>
            </div>
            <div id="histList"></div>
            <div class="empty" id="histEmpty" style="display:none;">No uploads yet - the next one shows up here.</div>
        </div>
    </div>

    <!-- ============ SETTINGS ============ -->
    <div class="page" id="page-settings">
        <div class="card" id="presetsCard">
            <h2>Client presets</h2>
            <p class="desc">One choice sets the destination, the Google Drive folder, image compression and the Camera Raw action. Set things up the way a client needs them, save that as a preset, then switch between clients here or from the Premiere Pro / After Effects panels.</p>
            <div class="actions" style="margin-top: 0;">
                <input type="text" id="presetName" placeholder="Preset name, e.g. Client A" maxlength="60" style="max-width: 260px;">
                <button class="btn" id="presetSaveBtn">Save current setup as preset</button>
                <span class="note" id="presetsNote" style="margin-top: 0;"></span>
            </div>
            <div id="presetList" style="margin-top: 14px;"></div>
            <div class="empty" id="presetsEmpty">No presets yet - save your current setup to create the first one.</div>
        </div>

        <div class="card" id="hotkeyCard">
            <h2>Global shortcut</h2>
            <p class="desc">Press a shortcut while After Effects, Premiere Pro, Photoshop or VEGAS Pro is in front and the current frame is sent - exactly like clicking Upload in the Spidx panel there. The panel only has to be open in that program (Window &gt; Extensions). Free for everyone.</p>
            <div class="set-group">
                <div class="set-row">
                    <div class="txt"><b>Enable the global shortcut</b><span>Works while the Spidx tray app is running.</span></div>
                    <label class="switch"><input type="checkbox" id="hotkeyEnabled"><span class="track"></span></label>
                </div>
                <div class="set-row sub" data-dep="hotkeyEnabled">
                    <div class="txt"><b>Upload</b><span>Click the box, then press the keys. Needs Ctrl, Alt, Shift or Win plus one key.</span></div>
                    <input type="text" id="hotkeySend" readonly style="max-width: 190px; text-align: center; cursor: pointer;">
                </div>
                <div class="set-row sub" data-dep="hotkeyEnabled">
                    <div class="txt"><b>Photoshop + Upload</b><span>The Camera Raw route (a Pro feature, needs an Action set in the Dashboard).</span></div>
                    <input type="text" id="hotkeySendPs" readonly style="max-width: 190px; text-align: center; cursor: pointer;">
                </div>
            </div>
            <div class="savebar">
                <button class="btn" id="hotkeySaveBtn">Save shortcut</button>
                <button class="btn ghost" id="hotkeyResetBtn">Reset to default</button>
                <span class="note" id="hotkeyNote" style="margin-top: 0;"></span>
            </div>
            <div class="note" id="hotkeyStatus" style="margin-top: 10px;"></div>
        </div>

        <div class="card" id="tourCardSettings">
            <h2>Helper settings</h2>
            <p class="desc">Written straight to helper-config.json — the helper restarts itself automatically to apply changes.</p>

            <div class="set-group">
                <div class="set-row">
                    <div class="txt"><b>Preferred browser</b><span>Used for WorkUpload uploads. Auto-detect follows your Windows default.</span></div>
                    <select id="preferredBrowser">
                        <option value="auto">Auto-detect</option>
                        <option value="chrome">Chrome</option>
                        <option value="edge">Edge</option>
                        <option value="brave">Brave</option>
                        <option value="firefox">Firefox</option>
                        <option value="opera">Opera</option>
                        <option value="opera-gx">Opera GX</option>
                    </select>
                </div>

                <div class="set-row">
                    <div class="txt"><b>System notifications</b><span>Windows toast when an upload finishes.</span></div>
                    <label class="switch"><input type="checkbox" id="notificationsEnabled"><span class="track"></span></label>
                </div>

                <div class="set-row">
                    <div class="txt"><b>Auto-retry failed uploads</b><span>Retries the whole batch when a send fails.</span></div>
                    <label class="switch"><input type="checkbox" id="autoRetryEnabled"><span class="track"></span></label>
                </div>
                <div class="set-row sub" data-dep="autoRetryEnabled">
                    <div class="txt"><b>Max attempts</b></div>
                    <input type="number" id="autoRetryMaxAttempts" min="1" max="10">
                </div>
                <div class="set-row sub" data-dep="autoRetryEnabled">
                    <div class="txt"><b>Delay between attempts (s)</b></div>
                    <input type="number" id="autoRetryDelaySeconds" min="0" max="600">
                </div>

                <div class="set-row">
                    <div class="txt"><b>Auto-clean old incoming files</b><span>Deletes already-handled exports from the incoming folder.</span></div>
                    <label class="switch"><input type="checkbox" id="cleanupEnabled"><span class="track"></span></label>
                </div>
                <div class="set-row sub" data-dep="cleanupEnabled">
                    <div class="txt"><b>After how many days</b></div>
                    <input type="number" id="cleanupAfterDays" min="1" max="365">
                </div>

                <div class="set-row">
                    <div class="txt"><b>Close idle upload tab</b><span>Frees RAM by closing the automation browser between uploads.</span></div>
                    <label class="switch"><input type="checkbox" id="browserIdleEnabled"><span class="track"></span></label>
                </div>
                <div class="set-row sub" data-dep="browserIdleEnabled">
                    <div class="txt"><b>Idle timeout (s)</b></div>
                    <input type="number" id="browserIdleTimeoutSeconds" min="30" max="3600">
                </div>

                <div class="set-row">
                    <div class="txt"><b>Batch collection timeout (s)</b><span>How long a partial batch waits before sending on its own.</span></div>
                    <input type="number" id="batchTimeoutSeconds" min="10" max="3600">
                </div>

                <div class="set-row">
                    <div class="txt"><b>Compress images before upload</b><span>Stills bigger than the target are re-encoded as JPEG to fit it. Video is never touched.</span></div>
                    <label class="switch"><input type="checkbox" id="compressionEnabled"><span class="track"></span></label>
                </div>
                <div class="set-row sub" data-dep="compressionEnabled">
                    <div class="txt"><b>Target size (MB)</b></div>
                    <input type="number" id="compressionTargetMB" min="0.3" max="25" step="0.1">
                </div>

                <div class="set-row">
                    <div class="txt"><b>Throttle between requests</b><span>Small random delay before each upload.</span></div>
                    <label class="switch"><input type="checkbox" id="throttleEnabled"><span class="track"></span></label>
                </div>
                <div class="set-row sub" data-dep="throttleEnabled">
                    <div class="txt"><b>Min delay (ms)</b></div>
                    <input type="number" id="throttleMinMs" min="0" max="60000">
                </div>
                <div class="set-row sub" data-dep="throttleEnabled">
                    <div class="txt"><b>Max delay (ms)</b></div>
                    <input type="number" id="throttleMaxMs" min="0" max="60000">
                </div>
            </div>

            <div class="savebar">
                <button class="btn" id="saveSettingsBtn">Save settings</button>
                <span class="note" id="saveStatus"></span>
            </div>
        </div>
    </div>

    <!-- ============ ACTIVITY ============ -->
    <div class="page" id="page-activity">
        <div class="card">
            <h2>Recent activity</h2>
            <p class="desc">Sign-ins, tier checks and batch uploads — most recent first.</p>
            <ul class="events" id="eventsList"></ul>
            <div class="empty" id="eventsEmpty" style="display:none;">Nothing logged yet.</div>
        </div>
    </div>

    <div class="legal-foot" id="legalFoot">
        Spidx Uploader <span id="footVersion"></span> &middot;
        <a href="https://spidxuploader.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> &middot;
        <a href="https://spidxuploader.com/eula" target="_blank" rel="noopener noreferrer">EULA</a> &middot;
        <a href="https://spidxuploader.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> &middot;
        <a href="https://spidxuploader.com/" target="_blank" rel="noopener noreferrer">spidxuploader.com</a>
    </div>
</div>

<div id="toast"></div>

<script>
let data = null;

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

function toast(message, kind) {
    const el = $("toast");
    el.textContent = message;
    el.className = "show " + (kind || "");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = kind || ""; }, 3600);
}

function setNote(id, message, kind) {
    const el = $(id);
    el.textContent = message || "";
    el.className = "note" + (kind ? " " + kind : "") + (id === "forceRefreshNote" || id === "presetNote" ? "" : "");
    if (id === "forceRefreshNote" || id === "presetNote") el.style.marginTop = "0";
}

function fmtTime(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function relTime(ms) {
    if (!ms) return "";
    const diff = Math.round((Date.now() - ms) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
    return fmtTime(ms);
}

/* ---------------- tabs ---------------- */
function switchToPage(pageName) {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.classList.toggle("active", t.dataset.page === pageName); });
    Array.prototype.forEach.call(document.querySelectorAll(".page"), function (p) { p.classList.toggle("active", p.id === "page-" + pageName); });
}
Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
    tab.addEventListener("click", function () { switchToPage(tab.dataset.page); });
});

/* ---------------- render ---------------- */
function applySubRowLocks() {
    Array.prototype.forEach.call(document.querySelectorAll(".set-row.sub"), function (row) {
        const dep = $(row.dataset.dep);
        const on = dep && dep.checked;
        row.classList.toggle("locked", !on);
        Array.prototype.forEach.call(row.querySelectorAll("input"), function (i) { i.disabled = !on; });
    });
}

function batchLabel(batch) {
    if (!batch || !batch.state || batch.state === "idle") return null;
    if (batch.state === "collecting") return "Collecting " + (batch.have || 0) + "/" + (batch.target || "?");
    if (batch.state === "uploading") return "Uploading";
    if (batch.state === "done") return "Just finished";
    return batch.state;
}

function render() {
    /* --- tier + helper pills --- */
    const tierPill = $("tierPill");
    // roles: "PRO + SPT" - the pill takes the colour of the highest one
    var pillRoles = (data.roles && data.roles.length) ? data.roles : (data.tier ? [data.tier] : []);
    var pillShown = pillRoles.filter(function (r) { return r !== "free" || pillRoles.length === 1; });
    var pillClass = ["dev", "tester", "pro", "spt", "free"].filter(function (r) { return pillRoles.indexOf(r) !== -1; })[0];
    tierPill.className = "pill " + (pillClass ? "tier-" + pillClass : "off");
    $("tierPillText").textContent = pillRoles.length
        ? pillShown.join(" + ").toUpperCase() + (data.trialDaysRemaining ? " · " + data.trialDaysRemaining + "d left" : "")
        : "tier unknown";

    const helperPill = $("helperPill");
    const fresh = data.statusUpdatedAt && (Date.now() - data.statusUpdatedAt) < 90000;
    helperPill.className = "pill " + (data.engineSeen ? (fresh ? "live" : "warn") : "off");
    $("helperPillText").textContent = data.engineSeen
        ? (fresh ? "helper running" : "helper idle")
        : "helper not seen";

    $("deviceBanner").classList.toggle("show", !!data.deviceLimitReached);

    /* --- license expiry warning: shown for the last 3 days --- */
    var EXPIRY_WARN_DAYS = 3;
    var expiring = data.tier && data.tier !== "free" && data.trialDaysRemaining && data.trialDaysRemaining <= EXPIRY_WARN_DAYS;
    $("expiryBanner").classList.toggle("show", !!expiring);
    if (expiring) {
        $("expiryText").textContent = "Your " + data.tier.toUpperCase() + " license expires in " + data.trialDaysRemaining +
            (data.trialDaysRemaining === 1 ? " day" : " days") + " (" + data.expiresAt + "), after which this app falls back to Free.";
    }

    /* --- tiles --- */
    const busy = batchLabel(data.batch);
    $("engineState").textContent = busy || (data.engineSeen ? (fresh ? "Running" : "Idle") : "Not started");
    $("engineSub").textContent = data.statusUpdatedAt
        ? "Last reported " + relTime(data.statusUpdatedAt)
        : "Start the helper from the tray to refresh this.";

    $("destValue").textContent = data.destination === "drive" ? "Google Drive" : "WorkUpload";
    $("destSub").textContent = data.driveAllowed
        ? "Both destinations available on this tier."
        : "Google Drive needs a paid tier.";

    const last = data.lastUpload;
    const lastLink = last && last.links && last.links[0];
    $("lastValue").textContent = last && last.fileNames && last.fileNames.length
        ? (last.fileNames.length === 1 ? last.fileNames[0] : last.fileNames.length + " files")
        : "—";
    const lastSub = $("lastSub");
    lastSub.textContent = "";
    if (lastLink) {
        const a = document.createElement("a");
        a.href = lastLink; a.target = "_blank"; a.textContent = lastLink;
        lastSub.appendChild(a);
        lastSub.appendChild(document.createElement("br"));
        lastSub.appendChild(document.createTextNode(relTime(last.savedAt)));
        $("copyLastBtn").style.display = "";
    } else {
        lastSub.textContent = last ? "Uploaded, but no link was detected." : "Nothing uploaded yet.";
        $("copyLastBtn").style.display = "none";
    }

    /* --- destination --- */
    $("destWorkupload").classList.toggle("active", data.destination === "workupload");
    $("destDrive").classList.toggle("active", data.destination === "drive");
    $("destDrive").disabled = !data.driveAllowed;

    /* --- preset --- */
    const setEl = $("presetActionSet");
    const nameEl = $("presetActionName");
    if (document.activeElement !== setEl && document.activeElement !== nameEl) {
        setEl.value = data.cameraRawPreset ? data.cameraRawPreset.actionSet : "";
        nameEl.value = data.cameraRawPreset ? data.cameraRawPreset.actionName : "";
    }
    $("presetClearBtn").style.display = data.cameraRawPreset ? "" : "none";
    setEl.disabled = !data.proFeaturesAllowed;
    nameEl.disabled = !data.proFeaturesAllowed;
    $("presetSaveBtn").disabled = !data.proFeaturesAllowed;
    $("presetLockedNote").style.display = data.proFeaturesAllowed ? "none" : "";

    /* --- saved Camera Raw preset slots --- */
    var slotList = $("presetSlotList");
    var slots = data.cameraRawPresets || [];
    var activeName = data.cameraRawPreset ? data.cameraRawPreset.actionSet + "\u0001" + data.cameraRawPreset.actionName : null;
    if (!slots.length) {
        slotList.innerHTML = '<p class="hint" style="margin:0;">No saved presets yet.</p>';
    } else {
        slotList.innerHTML = "";
        slots.forEach(function (slot) {
            var isActive = activeName === (slot.actionSet + "\u0001" + slot.actionName);
            var row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;";
            var txt = document.createElement("div");
            txt.style.cssText = "min-width:0;flex:1;overflow:hidden;";
            txt.innerHTML = '<b style="display:block;font-size:13px;">' + escapeHtml(slot.label) + (isActive ? ' <span style="color:#4da3ff;font-weight:600;">(active)</span>' : '') + '</b>'
                + '<span style="display:block;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(slot.actionSet || "\u2014") + ' / ' + escapeHtml(slot.actionName) + '</span>';
            var actions = document.createElement("div");
            actions.style.cssText = "display:flex;gap:6px;flex-shrink:0;";
            var useBtn = document.createElement("button");
            useBtn.className = "btn ghost";
            useBtn.style.cssText = "padding:6px 11px;font-size:11.5px;";
            useBtn.textContent = isActive ? "Active" : "Use";
            useBtn.disabled = isActive;
            useBtn.addEventListener("click", function () { useSlot(slot.id); });
            var delBtn = document.createElement("button");
            delBtn.className = "btn danger";
            delBtn.style.cssText = "padding:6px 11px;font-size:11.5px;";
            delBtn.textContent = "Delete";
            delBtn.addEventListener("click", function () { deleteSlot(slot.id); });
            actions.appendChild(useBtn);
            actions.appendChild(delBtn);
            row.appendChild(txt);
            row.appendChild(actions);
            slotList.appendChild(row);
        });
    }

    /* --- account tab --- */
    var tierLabel = data.tier ? data.tier.charAt(0).toUpperCase() + data.tier.slice(1) : "";
    var summary;
    if (!data.tier) {
        summary = "Waiting for the helper to report your license...";
    } else if (data.tier === "free") {
        summary = "Free — no license active. Enter a license code below to unlock Pro.";
    } else if (data.expiresAt) {
        var daysLeft = data.trialDaysRemaining;
        summary = tierLabel + " — expires " + data.expiresAt + (daysLeft ? " (" + daysLeft + (daysLeft === 1 ? " day" : " days") + " left)." : ".");
    } else {
        summary = tierLabel + " — lifetime, never expires.";
    }
    if (data.deviceLimitReached) {
        summary += " This computer is over the 2-device limit and is running as Free — remove an old device below.";
    }
    $("licenseSummary").textContent = summary;

    $("appVersionLine").textContent = data.appVersion ? "Current version: " + data.appVersion : "Current version unknown.";
    $("footVersion").textContent = data.appVersion ? "v" + data.appVersion : "";
    renderConsent(data.consent);
    renderPresets(data.presets);
    renderHotkey(data.hotkey);

    var aeStatus = data.plugins && data.plugins.ae;
    var pproStatus = data.plugins && data.plugins.ppro;
    var psStatus = data.plugins && data.plugins.ps;
    var vegasStatus = data.plugins && data.plugins.vegas;
    function pluginLabel(p) {
        if (!p) return "unknown";
        if (!p.installed) return "not installed";
        var s = "installed v" + p.installedVersion;
        if (p.needsUpdate) s += " (v" + p.bundledVersion + " available)";
        return s;
    }
    function installLabel(p) {
        if (!p || !p.installed) return "Install";
        return p.needsUpdate ? "Update" : "Reinstall";
    }
    $("pluginStatusAe").textContent = pluginLabel(aeStatus);
    $("pluginStatusPpro").textContent = pluginLabel(pproStatus);
    $("pluginStatusVegas").textContent = pluginLabel(vegasStatus);
    renderPluginUpdates(data.pluginUpdates);
    $("uninstallVegasBtn").disabled = !(vegasStatus && vegasStatus.installed);
    $("installVegasBtn").disabled = false;
    $("installVegasBtn").textContent = installLabel(vegasStatus);
    $("uninstallAeBtn").disabled = !(aeStatus && aeStatus.installed);
    $("uninstallPproBtn").disabled = !(pproStatus && pproStatus.installed);
    $("installAeBtn").disabled = false;
    $("installAeBtn").textContent = installLabel(aeStatus);
    if (data.pproAllowed) {
        $("installPproBtn").disabled = false;
        $("installPproBtn").textContent = installLabel(pproStatus);
    } else {
        $("installPproBtn").disabled = true;
        $("installPproBtn").textContent = "Needs Pro or the Pack";
    }
    // Real install state now comes from actually asking UPIA (/list all)
    // — see refreshPsInstallStatus() server-side. ccxAvailable/upiaAvailable
    // only ever answered "could this be installed", which is why the old
    // version showed Install as always-clickable and Uninstall as
    // available right after a successful install: neither reflected
    // whether Photoshop actually has the panel.
    if (!psStatus || !psStatus.ccxAvailable) {
        $("pluginStatusPs").textContent = "Photoshop panel (.ccx) not found";
        $("installPsBtn").disabled = true;
        $("installPsBtn").textContent = "Install";
        $("uninstallPsBtn").disabled = true;
    } else if (!psStatus.upiaAvailable) {
        $("pluginStatusPs").textContent = "Creative Cloud desktop app required";
        $("installPsBtn").disabled = true;
        $("installPsBtn").textContent = "Install";
        $("uninstallPsBtn").disabled = true;
    } else if (!psStatus.checked) {
        // status unknown (still checking, or UPIA's list isn't readable) - installing
        // doesn't depend on it, so don't lock the buttons
        $("pluginStatusPs").textContent = "checking... (use Refresh status)";
        $("installPsBtn").disabled = false;
        $("installPsBtn").textContent = "Install";
        $("uninstallPsBtn").disabled = false;
    } else if (psStatus.installed) {
        $("pluginStatusPs").textContent = "installed" + (psStatus.installedVersion ? " v" + psStatus.installedVersion : "")
            + (psStatus.needsUpdate ? " (v" + psStatus.bundledVersion + " available)" : "");
        $("installPsBtn").disabled = false;
        $("installPsBtn").textContent = psStatus.needsUpdate ? "Update" : "Reinstall";
        $("uninstallPsBtn").disabled = false;
    } else {
        $("pluginStatusPs").textContent = "not installed";
        $("installPsBtn").disabled = false;
        $("installPsBtn").textContent = "Install";
        $("uninstallPsBtn").disabled = true;
    }

    /* --- settings --- */
    const s = data.settings;
    const focused = document.activeElement;
    const inSettings = focused && focused.closest && focused.closest("#page-settings");
    if (!inSettings) {
        $("preferredBrowser").value = s.preferredBrowser;
        $("notificationsEnabled").checked = s.notifications.enabled;
        $("autoRetryEnabled").checked = s.autoRetry.enabled;
        $("autoRetryMaxAttempts").value = s.autoRetry.maxAttempts;
        $("autoRetryDelaySeconds").value = s.autoRetry.delaySeconds;
        $("cleanupEnabled").checked = s.cleanup.enabled;
        $("cleanupAfterDays").value = s.cleanup.afterDays;
        $("browserIdleEnabled").checked = s.browserIdle.enabled;
        $("browserIdleTimeoutSeconds").value = s.browserIdle.timeoutSeconds;
        $("batchTimeoutSeconds").value = s.batch.timeoutSeconds;
        $("compressionEnabled").checked = s.compression.enabled;
        $("compressionTargetMB").value = s.compression.targetMB;
        $("throttleEnabled").checked = s.throttle.enabled;
        $("throttleMinMs").value = s.throttle.minMs;
        $("throttleMaxMs").value = s.throttle.maxMs;
        applySubRowLocks();
    }

    /* --- events --- */
    const list = $("eventsList");
    list.innerHTML = "";
    $("eventsEmpty").style.display = data.events.length ? "none" : "";
    data.events.forEach(function (ev) {
        const li = document.createElement("li");

        const dot = document.createElement("span");
        dot.className = "ev-dot" + (ev.status === "fail" ? " fail" : ev.status === "ok" ? " ok" : "");

        const body = document.createElement("div");
        body.className = "ev-body";

        const summary = document.createElement("div");
        summary.className = "ev-summary" + (ev.status === "fail" ? " fail" : "");
        summary.textContent = ev.summary;

        const time = document.createElement("div");
        time.className = "ev-time";
        time.textContent = fmtTime(ev.time);

        body.appendChild(summary);
        body.appendChild(time);
        li.appendChild(dot);
        li.appendChild(body);
        list.appendChild(li);
    });
}

Array.prototype.forEach.call(document.querySelectorAll(".set-row .switch input"), function (input) {
    input.addEventListener("change", applySubRowLocks);
});

/* ---------------- data ---------------- */
async function refresh() {
    try {
        const res = await fetch("/data");
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.error || ("HTTP " + res.status));
        }
        data = await res.json();
        render();
        $("dashboardErrorBanner").classList.remove("show");
        if (!tourStarted) {
            tourStarted = true;
            if (!data.tourSeen) setTimeout(startTour, 500); // small delay so the page visibly settles first
        }
    } catch (e) {
        console.error("Dashboard refresh failed:", e);
        $("dashboardErrorText").textContent = "Couldn't load live data (" + e.message + "). Retrying...";
        $("dashboardErrorBanner").classList.add("show");
    }
}

function restartMessage(verb, restartStatus) {
    if (restartStatus === "now") return verb + " — helper is restarting now, ready in a few seconds.";
    if (restartStatus === "deferred") return verb + " — will restart once the current upload finishes.";
    return verb + " — will apply next time the helper starts.";
}

$("copyLastBtn").addEventListener("click", function () {
    const link = data && data.lastUpload && data.lastUpload.links && data.lastUpload.links.join("\\n");
    if (!link) return;
    navigator.clipboard.writeText(link).then(
        function () { toast("Link copied to clipboard", "ok"); },
        function () { toast("Could not access the clipboard", "err"); }
    );
});

$("forceRefreshBtn").addEventListener("click", async function () {
    setNote("forceRefreshNote", "Refreshing...");
    try {
        const res = await fetch("/force-refresh-tier", { method: "POST" });
        const result = await res.json();
        if (result.ok) {
            setNote("forceRefreshNote", restartMessage("Cache cleared", result.restarted), "ok");
            toast("Tier cache cleared", "ok");
        } else {
            setNote("forceRefreshNote", result.message || "Could not refresh.", "err");
        }
    } catch (e) {
        setNote("forceRefreshNote", "Could not reach the dashboard server.", "err");
    }
    refresh();
});

/* ---------------- account tab ---------------- */
$("logoutBtn").addEventListener("click", async function () {
    if (!confirm("Log out? This clears your Google sign-in and restarts Spidx Uploader — the tray icon will briefly disappear and come back, and you'll sign in again.")) return;
    setNote("logoutNote", "Logging out...");
    try {
        const res = await fetch("/logout", { method: "POST" });
        const result = await res.json();
        if (result.ok) {
            setNote("logoutNote", result.canQuit ? "Logged out — restarting..." : "Logged out. Restart the app manually from the tray.", "ok");
        } else {
            setNote("logoutNote", result.message || "Could not log out.", "err");
        }
    } catch (e) {
        // A genuine fetch failure (server unreachable, network error, etc.)
        // used to be swallowed here as if it were success, on the theory
        // that the app quitting out from under the request would also land
        // here. It won't: the server answers with ok:true a full 300ms
        // before it actually restarts, specifically so this fetch has time
        // to complete first. So if we're here, something real broke —
        // report it instead of hiding it behind a fake "restarting" message.
        setNote("logoutNote", "Could not reach the dashboard server: " + e.message, "err");
    }
});

function renderUpdateInfo(info) {
    if (!info) return;
    if (info.hasUpdate) {
        setNote("updateNote", "Version " + info.latestVersion + " is available.", "ok");
        $("openReleaseBtn").style.display = "";
        $("openReleaseBtn").onclick = function () { window.open(info.downloadUrl, "_blank"); };
        // "Install update" only shows up if the release actually has a .exe
        // asset to fetch (findInstallerAsset() in update-check.js) - if not,
        // "Open release page" is the only way, same as before.
        $("installUpdateBtn").style.display = info.installerAssetUrl ? "" : "none";
    } else {
        setNote("updateNote", info.lastError ? "Could not check (" + info.lastError + ")." : "You're up to date.", info.lastError ? "err" : "ok");
        $("openReleaseBtn").style.display = "none";
        $("installUpdateBtn").style.display = "none";
    }
}
fetch("/update-info").then(function (r) { return r.json(); }).then(renderUpdateInfo).catch(function () {});
$("checkUpdateBtn").addEventListener("click", async function () {
    setNote("updateNote", "Checking...");
    try {
        const res = await fetch("/check-update", { method: "POST" });
        renderUpdateInfo(await res.json());
    } catch (e) {
        setNote("updateNote", "Could not reach the dashboard server.", "err");
    }
});
$("installUpdateBtn").addEventListener("click", async function () {
    if (!confirm("Download and launch the installer now? Close Photoshop/After Effects/Premiere first if they're open.")) return;
    var btn = $("installUpdateBtn");
    btn.disabled = true;
    setNote("updateNote", "Downloading update...");
    try {
        const res = await fetch("/install-update", { method: "POST" });
        const data = await res.json();
        if (data.ok) {
            setNote("updateNote", "Downloaded. The installer window should open now - follow its steps to finish updating.", "ok");
        } else {
            setNote("updateNote", data.message || "Could not download the update.", "err");
        }
    } catch (e) {
        setNote("updateNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

function uninstallPlugin(key, btnId) {
    return async function () {
        if (!confirm("Uninstall this plugin? A console window will open to remove it — close the host app first if it's running.")) return;
        setNote("pluginNote", "Opening uninstaller...");
        try {
            const res = await fetch("/uninstall-plugin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plugin: key })
            });
            const result = await res.json();
            setNote("pluginNote", result.ok ? "Uninstaller opened — follow the console window." : (result.message || "Could not uninstall."), result.ok ? "ok" : "err");
        } catch (e) {
            setNote("pluginNote", "Could not reach the dashboard server.", "err");
        }
    };
}
$("uninstallAeBtn").addEventListener("click", uninstallPlugin("ae"));
$("uninstallPproBtn").addEventListener("click", uninstallPlugin("ppro"));
$("uninstallVegasBtn").addEventListener("click", uninstallPlugin("vegas"));
$("uninstallPsBtn").addEventListener("click", uninstallPlugin("ps"));

function installPlugin(key) {
    return async function () {
        setNote("pluginNote", "Opening installer...");
        try {
            const res = await fetch("/install-plugin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plugin: key })
            });
            const result = await res.json();
            const okMsg = key === "ps"
                ? "Installer opened (allow the administrator prompt) — follow the console window; this page updates by itself when it finishes."
                : "Installer opened — follow the console window.";
            setNote("pluginNote", result.ok ? okMsg : (result.message || "Could not install."), result.ok ? "ok" : "err");
        } catch (e) {
            setNote("pluginNote", "Could not reach the dashboard server.", "err");
        }
    };
}
$("installAeBtn").addEventListener("click", installPlugin("ae"));
$("installPproBtn").addEventListener("click", installPlugin("ppro"));
$("installVegasBtn").addEventListener("click", installPlugin("vegas"));
$("installPsBtn").addEventListener("click", installPlugin("ps"));
$("refreshPsStatusBtn").addEventListener("click", async function () {
    setNote("pluginNote", "Checking...");
    try {
        await fetch("/refresh-ps-status", { method: "POST" });
        setTimeout(refresh, 800); // give the UPIA /list call a moment to finish
    } catch (e) {
        setNote("pluginNote", "Could not reach the dashboard server.", "err");
    }
});

$("backupBtn").addEventListener("click", function () {
    window.open("/backup-config", "_blank");
});
$("restoreBtn").addEventListener("click", function () { $("restoreFile").click(); });
$("restoreFile").addEventListener("change", async function () {
    const file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    setNote("backupNote", "Restoring...");
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const res = await fetch("/restore-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed)
        });
        const result = await res.json();
        setNote("backupNote", result.ok ? restartMessage("Restored", result.restarted) : (result.message || "Could not restore."), result.ok ? "ok" : "err");
        if (result.ok) refresh();
    } catch (e) {
        setNote("backupNote", "That file isn't valid JSON.", "err");
    }
});


/* ---------------- global shortcut ---------------- */
var hotkeyLoadedOnce = false;
var HOTKEY_DEFAULTS = { send: "Ctrl+Alt+U", sendPs: "Ctrl+Alt+Shift+U" };
var HOTKEY_NAMED = { " ": "Space", "Tab": "Tab", "Enter": "Enter", "Insert": "Insert", "Delete": "Delete", "Home": "Home", "End": "End",
    "PageUp": "PageUp", "PageDown": "PageDown", "ArrowLeft": "Left", "ArrowUp": "Up", "ArrowRight": "Right", "ArrowDown": "Down", "PrintScreen": "PrintScreen" };

// Turns a keydown into "Ctrl+Alt+U" (null while only modifiers are held / for keys the shortcut can't use).
function hotkeyFromEvent(e) {
    var key = e.key;
    if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return null;
    var name = null;
    if (/^[a-zA-Z]$/.test(key)) name = key.toUpperCase();
    else if (/^[0-9]$/.test(key)) name = key;
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) name = key;
    else if (HOTKEY_NAMED[key]) name = HOTKEY_NAMED[key];
    if (!name) return null;
    if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return null;
    return (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.shiftKey ? "Shift+" : "") + (e.metaKey ? "Win+" : "") + name;
}

function wireHotkeyInput(id) {
    var input = $(id);
    var before = "";
    input.addEventListener("focus", function () { before = input.value; input.placeholder = "Press the keys..."; input.select(); });
    input.addEventListener("blur", function () { input.placeholder = ""; if (!input.value) input.value = before; });
    input.addEventListener("keydown", function (e) {
        e.preventDefault();
        if (e.key === "Escape") { input.value = before; input.blur(); return; }
        var combo = hotkeyFromEvent(e);
        if (combo) { input.value = combo; before = combo; input.blur(); }
    });
}
wireHotkeyInput("hotkeySend");
wireHotkeyInput("hotkeySendPs");

function renderHotkey(info) {
    if (!info) return;
    if (!hotkeyLoadedOnce) {
        hotkeyLoadedOnce = true;
        $("hotkeyEnabled").checked = info.config.enabled;
        $("hotkeySend").value = info.config.send;
        $("hotkeySendPs").value = info.config.sendPs;
        applySubRowLocks();
    }
    var el = $("hotkeyStatus");
    var s = info.status;
    var text, kind = "";
    if (!info.state.supported) { text = "The global shortcut works on Windows only."; kind = "err"; }
    else if (!info.config.enabled) { text = "Off."; }
    else if (info.state.lastError) { text = info.state.lastError; kind = "err"; }
    else if (!s) { text = "Starting... (the first start builds a small helper program - a few seconds).";}
    else if (s.error) { text = s.error + " Pick another shortcut and save."; kind = "err"; }
    else { text = "Active: " + s.send.combo + " sends a frame, " + s.sendPs.combo + " sends it through Photoshop."; kind = "ok"; }
    el.textContent = text;
    el.className = "note" + (kind ? " " + kind : "");
}

$("hotkeySaveBtn").addEventListener("click", async function () {
    var out = await presetRequest("/save-hotkey", { enabled: $("hotkeyEnabled").checked, send: $("hotkeySend").value, sendPs: $("hotkeySendPs").value });
    setNote("hotkeyNote", out.ok ? "Saved - applied in a few seconds." : (out.message || "Could not save."), out.ok ? "ok" : "err");
    if (out.ok) { hotkeyLoadedOnce = false; refresh(); }
});

$("hotkeyResetBtn").addEventListener("click", function () {
    $("hotkeySend").value = HOTKEY_DEFAULTS.send;
    $("hotkeySendPs").value = HOTKEY_DEFAULTS.sendPs;
    $("hotkeyEnabled").checked = true;
    applySubRowLocks();
    setNote("hotkeyNote", "Defaults restored - press Save to apply.", "");
});

/* ---------------- client presets ---------------- */
function presetRequest(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}

function renderPresets(info) {
    var list = $("presetList");
    list.textContent = "";
    var items = (info && info.items) || [];
    $("presetsEmpty").style.display = items.length ? "none" : "";
    items.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "hist-row";
        row.style.gridTemplateColumns = "minmax(0, 1fr) auto";

        var main = document.createElement("div");
        main.className = "hist-main";
        var name = document.createElement("div");
        name.className = "hist-files";
        name.textContent = p.name;
        main.appendChild(name);
        var chips = document.createElement("div");
        chips.className = "hist-chips";
        if (p.active) chips.appendChild(histChip(p.modified ? "Active (modified)" : "Active", p.modified ? "ps" : "src"));
        p.summary.forEach(function (s) { chips.appendChild(histChip(s)); });
        main.appendChild(chips);
        row.appendChild(main);

        var actions = document.createElement("div");
        actions.className = "hist-actions";
        function act(label, fn) {
            var b = document.createElement("button");
            b.className = "mini-btn";
            b.textContent = label;
            b.addEventListener("click", fn);
            actions.appendChild(b);
        }
        act(p.active && !p.modified ? "Applied" : "Apply", async function () {
            var out = await presetRequest("/presets/apply", { name: p.name });
            setNote("presetsNote", out.ok ? ("Preset \u201c" + p.name + "\u201d applied." + (out.message ? " " + out.message : "")) : (out.message || "Could not apply."), out.ok ? "ok" : "err");
            refresh();
        });
        act("Update from current", async function () {
            if (!confirm("Overwrite preset \u201c" + p.name + "\u201d with the current setup?")) return;
            var out = await presetRequest("/presets/save", { name: p.name, overwrite: true });
            setNote("presetsNote", out.ok ? "Preset updated." : (out.message || "Could not update."), out.ok ? "ok" : "err");
            refresh();
        });
        act("Delete", async function () {
            if (!confirm("Delete preset \u201c" + p.name + "\u201d?")) return;
            await presetRequest("/presets/delete", { name: p.name });
            refresh();
        });
        row.appendChild(actions);
        list.appendChild(row);
    });
}

$("presetSaveBtn").addEventListener("click", async function () {
    var name = ($("presetName").value || "").trim();
    if (!name) { setNote("presetsNote", "Give the preset a name first.", "err"); return; }
    var out = await presetRequest("/presets/save", { name: name });
    setNote("presetsNote", out.ok ? "Saved \u201c" + name + "\u201d." : (out.message || "Could not save."), out.ok ? "ok" : "err");
    if (out.ok) $("presetName").value = "";
    refresh();
});

/* ---------------- upload history ---------------- */
var historyItems = [];

function histChip(text, cls) {
    var c = document.createElement("span");
    c.className = "chip" + (cls ? " " + cls : "");
    c.textContent = text;
    return c;
}

function renderHistory() {
    var list = $("histList");
    var q = ($("histSearch").value || "").toLowerCase().trim();
    list.textContent = "";
    var shown = historyItems.filter(function (e) {
        if (!q) return true;
        return (e.files.join(" ") + " " + (e.folder || "") + " " + (e.preset || "") + " " + (e.destination || "") + " " + (e.source || "")).toLowerCase().indexOf(q) !== -1;
    });
    $("histEmpty").style.display = shown.length ? "none" : "";
    $("histEmpty").textContent = historyItems.length ? "Nothing matches your search." : "No uploads yet - the next one shows up here.";
    shown.forEach(function (e) {
        var row = document.createElement("div");
        row.className = "hist-row";

        var when = document.createElement("div");
        when.className = "hist-when";
        var b = document.createElement("b");
        b.textContent = relTime(e.time);
        when.appendChild(b);
        when.appendChild(document.createTextNode(fmtTime(e.time)));
        row.appendChild(when);

        var main = document.createElement("div");
        main.className = "hist-main";
        var files = document.createElement("div");
        files.className = "hist-files";
        files.textContent = e.files[0] + (e.files.length > 1 ? "  +" + (e.files.length - 1) + " more" : "");
        files.title = e.files.join(", ");
        main.appendChild(files);
        var chips = document.createElement("div");
        chips.className = "hist-chips";
        chips.appendChild(histChip(e.destination === "drive" ? "Google Drive" : "WorkUpload"));
        if (e.folder) chips.appendChild(histChip(e.folder));
        if (e.preset) chips.appendChild(histChip("Preset: " + e.preset));
        if (e.source === "vegas") chips.appendChild(histChip("VEGAS Pro", "src"));
        if (e.viaPhotoshop) chips.appendChild(histChip("via Photoshop", "ps"));
        main.appendChild(chips);
        if (e.links && e.links.length) {
            var links = document.createElement("div");
            links.className = "hist-links";
            e.links.forEach(function (url) {
                var a = document.createElement("a");
                a.href = url;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.textContent = url;
                links.appendChild(a);
            });
            main.appendChild(links);
        }
        row.appendChild(main);

        var actions = document.createElement("div");
        actions.className = "hist-actions";
        if (e.links && e.links.length) {
            var copy = document.createElement("button");
            copy.className = "mini-btn";
            copy.textContent = e.links.length > 1 ? "Copy " + e.links.length : "Copy link";
            copy.addEventListener("click", function () {
                navigator.clipboard.writeText(e.links.join("\\n")).then(function () { toast("Link copied.", "ok"); }, function () { toast("Could not copy.", "err"); });
            });
            actions.appendChild(copy);
        }
        var del = document.createElement("button");
        del.className = "mini-btn";
        del.textContent = "Remove";
        del.addEventListener("click", async function () {
            await fetch("/history/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id }) });
            loadHistory();
        });
        actions.appendChild(del);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

async function loadHistory() {
    try {
        var res = await fetch("/history");
        var out = await res.json();
        historyItems = out.items || [];
        renderHistory();
    } catch (e) { /* the next poll retries */ }
}

$("histSearch").addEventListener("input", renderHistory);
$("histClearBtn").addEventListener("click", async function () {
    if (!historyItems.length) return;
    if (!confirm("Delete the whole upload history? (The uploaded files and their links stay valid - only this list is cleared.)")) return;
    await fetch("/history/clear", { method: "POST" });
    loadHistory();
    toast("History cleared.", "ok");
});
setInterval(function () { if ($("page-history").classList.contains("active")) loadHistory(); }, 5000);
document.querySelector('.tab[data-page="history"]').addEventListener("click", loadHistory);

/* ---------------- legal consent ---------------- */
function renderConsent(consent) {
    var banner = $("legalBanner");
    if (!consent) { banner.style.display = "none"; return; }
    banner.style.display = consent.accepted ? "none" : "";
    if (!consent.accepted) {
        $("legalBannerTitle").textContent = consent.acceptedVersion
            ? "The Terms of Service or Privacy Policy changed"
            : "Please review the Terms of Service, the EULA and the Privacy Policy";
        $("legalBannerText").textContent = consent.acceptedVersion
            ? "You accepted an earlier version (" + consent.acceptedVersion + "). Please read the current texts and accept them to keep using Spidx Uploader."
            : "Spidx Uploader asks you to accept them once. Nothing is blocked while you read them.";
    }
    $("consentLine").textContent = consent.accepted
        ? "You accepted version " + consent.acceptedVersion + " on " + new Date(consent.acceptedAt).toLocaleDateString() + "."
        : "Not accepted yet.";
}

$("acceptLegalBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
        var res = await fetch("/accept-legal", { method: "POST" });
        var out = await res.json();
        if (out.ok) { renderConsent(out.consent); toast("Thanks - saved.", "ok"); }
        else toast(out.message || "Could not save.", "err");
    } catch (e) {
        toast("Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

/* ---------------- plugin updates ---------------- */
function renderPluginUpdates(info) {
    var label = $("pluginUpdatesStatus");
    var dl = $("downloadPluginUpdatesBtn");
    if (!info) { label.textContent = "unknown"; dl.style.display = "none"; return; }
    if (info.updates && info.updates.length) {
        label.textContent = "available: " + info.updates.map(function (u) { return u.label + " (" + u.remoteVersion + ")"; }).join(", ");
        dl.style.display = "";
    } else {
        label.textContent = info.error ? "couldn't check (" + info.error + ")" : "up to date";
        dl.style.display = "none";
    }
}

$("checkPluginUpdatesBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("pluginNote", "Checking GitHub...");
    try {
        var res = await fetch("/plugin-updates?force=1");
        var info = await res.json();
        renderPluginUpdates(info);
        setNote("pluginNote", info.error ? "Could not check: " + info.error : (info.updates.length ? "Plugin updates found." : "All plugins are up to date."), info.error ? "err" : "ok");
    } catch (e) {
        setNote("pluginNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

$("downloadPluginUpdatesBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("pluginNote", "Downloading plugin updates...");
    try {
        var res = await fetch("/download-plugin-updates", { method: "POST" });
        var out = await res.json();
        var failed = (out.results || []).filter(function (r) { return !r.ok; });
        if (failed.length) {
            setNote("pluginNote", "Some updates failed: " + failed.map(function (r) { return r.label + " - " + r.message; }).join("; "), "err");
        } else if (!(out.results || []).length) {
            setNote("pluginNote", out.message || "Nothing to download.", out.ok ? "ok" : "err");
        } else {
            setNote("pluginNote", "Downloaded. Now close the host app and click Update next to each plugin above to put the new version in place.", "ok");
        }
        refresh();
    } catch (e) {
        setNote("pluginNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

/* ---------------- diagnostics ---------------- */
var STATUS_COLORS = { ok: "var(--ok)", warn: "#ffb020", fail: "var(--err)", info: "var(--text-dim)" };
var STATUS_WORDS = { ok: "OK", warn: "WARN", fail: "FAIL", info: "info" };

function renderSelfTest(result) {
    var box = $("selfTestResults");
    box.textContent = "";
    var head = document.createElement("div");
    head.style.cssText = "font-size:12.5px;font-weight:600;margin-bottom:8px;";
    head.textContent = result.summary.ok + " ok, " + result.summary.warn + " warning(s), " + result.summary.fail + " failed";
    box.appendChild(head);
    result.checks.forEach(function (c) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:10px;align-items:baseline;padding:6px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:5px;font-size:12px;";
        var tag = document.createElement("span");
        tag.style.cssText = "flex-shrink:0;width:42px;font-weight:700;color:" + (STATUS_COLORS[c.status] || "inherit") + ";";
        tag.textContent = STATUS_WORDS[c.status] || c.status;
        var txt = document.createElement("span");
        txt.style.cssText = "min-width:0;word-break:break-word;";
        var strong = document.createElement("b");
        strong.textContent = c.label;
        txt.appendChild(strong);
        if (c.detail) txt.appendChild(document.createTextNode(" - " + c.detail));
        row.appendChild(tag);
        row.appendChild(txt);
        box.appendChild(row);
    });
}

$("selfTestBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("diagNote", "Running checks...");
    try {
        var res = await fetch("/self-test");
        renderSelfTest(await res.json());
        setNote("diagNote", "");
    } catch (e) {
        setNote("diagNote", "Could not run the self-test.", "err");
    }
    btn.disabled = false;
});

$("makeDiagBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("diagNote", "Collecting files...");
    try {
        var res = await fetch("/make-diagnostics", { method: "POST" });
        var out = await res.json();
        if (!out.ok) {
            setNote("diagNote", out.message || "Could not create the file.", "err");
        } else {
            setNote("diagNote", "Created: " + out.path + " - the folder is opening. Send that .zip to support.", "ok");
            fetch("/open-diagnostics-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: out.path })
            });
        }
    } catch (e) {
        setNote("diagNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

// TODO: point this at your real Discord/support URL.
// Set this to your real Discord/support URL, then this card switches
// from the "not set up yet" fallback text to a working link on its own.
var SUPPORT_URL = ""; // e.g. "https://discord.gg/yourInvite"
if (SUPPORT_URL) {
    $("supportLink").href = SUPPORT_URL;
    $("supportLink").target = "_blank";
    $("supportLink").style.display = "";
    $("supportFallback").style.display = "none";
}

function describeTier(result) {
    if (!result.tier) return "";
    var label = String(result.tier).toUpperCase().replace(/[+,| ]+/g, " + "); // "pro+spt" -> "PRO + SPT"
    // null trialDaysRemaining = no expiry (lifetime), same convention the
    // license server uses.
    return label + (result.trialDaysRemaining ? " (" + result.trialDaysRemaining + (result.trialDaysRemaining === 1 ? " day" : " days") + " left)" : " (lifetime)");
}

$("expiryEnterCode").addEventListener("click", function (e) {
    e.preventDefault();
    document.querySelector('.tab[data-page="account"]').click();
    $("licenseCodeInput").focus();
});

$("licenseRedeemBtn").addEventListener("click", async function () {
    const input = $("licenseCodeInput");
    const code = input.value.trim();

    if (!code) {
        setNote("licenseNote", "Enter a code first.", "err");
        return;
    }

    setNote("licenseNote", "Activating...");
    try {
        const res = await fetch("/redeem-license", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code })
        });
        const result = await res.json();
        if (result.ok) {
            input.value = "";
            const restartNote = result.restarted === "now"
                ? " Helper is restarting now."
                : result.restarted === "deferred" ? " Helper will restart once the current upload finishes." : "";
            const tierNote = describeTier(result);
            setNote("licenseNote", (result.ambiguous
                ? result.message + " Current license: " + tierNote + "."
                : "Activated — you now have " + tierNote + ".") + restartNote, "ok");
            toast("License activated — " + tierNote, "ok");
        } else {
            setNote("licenseNote", result.message || "Could not activate this code.", "err");
        }
    } catch (e) {
        setNote("licenseNote", "Could not reach the dashboard server.", "err");
    }
    refresh();
    loadDevices();
});
$("licenseCodeInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("licenseRedeemBtn").click();
});

/* ---------------- devices ---------------- */
function formatDeviceDate(value) {
    if (!value) return "";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
}

async function loadDevices() {
    var list = $("deviceList");
    try {
        const res = await fetch("/list-devices");
        const result = await res.json();
        if (!result.ok) {
            list.innerHTML = '<p class="hint" style="margin:0;">' + escapeHtml(result.message || "Could not load devices.") + '</p>';
            return;
        }
        var devices = result.devices || [];
        if (!devices.length) {
            list.innerHTML = '<p class="hint" style="margin:0;">No devices registered yet — a device is added the first time you use a paid license on it.</p>';
            return;
        }
        list.innerHTML = "";
        devices.forEach(function (device) {
            var row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;";
            var txt = document.createElement("div");
            txt.style.cssText = "min-width:0;flex:1;overflow:hidden;";
            var added = formatDeviceDate(device.addedAt);
            var label = device.name ? escapeHtml(device.name) : (device.isThisDevice ? "This computer" : "Another computer");
            txt.innerHTML = '<b style="display:block;font-size:13px;">' + label
                + (device.isThisDevice ? ' <span style="color:#4da3ff;font-weight:600;">(you are here)</span>' : '') + '</b>'
                + '<span style="display:block;font-size:12px;color:var(--dim);">ID ' + escapeHtml(String(device.deviceId).slice(0, 8))
                + (added ? " · added " + escapeHtml(added) : "") + '</span>';
            var btn = document.createElement("button");
            btn.className = "btn danger";
            btn.style.cssText = "padding:6px 11px;font-size:11.5px;flex-shrink:0;";
            btn.textContent = "Remove";
            btn.addEventListener("click", function () { removeDevice(device); });
            row.appendChild(txt);
            row.appendChild(btn);
            list.appendChild(row);
        });
    } catch (e) {
        list.innerHTML = '<p class="hint" style="margin:0;">Could not reach the dashboard server.</p>';
    }
}

async function removeDevice(device) {
    var warning = device.isThisDevice
        ? "Remove THIS computer from your license? It will drop to Free until it re-registers (it takes a free slot again next time the helper checks in, if one is available)."
        : "Remove this computer from your license? It will drop to Free the next time it checks in.";
    if (!confirm(warning)) return;
    setNote("devicesNote", "Removing...");
    try {
        const res = await fetch("/remove-device", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: device.deviceId })
        });
        const result = await res.json();
        setNote("devicesNote", result.ok ? "Removed." : (result.message || "Could not remove that device."), result.ok ? "ok" : "err");
        if (result.ok) { loadDevices(); refresh(); }
    } catch (e) {
        setNote("devicesNote", "Could not reach the dashboard server.", "err");
    }
}

$("devicesRefreshBtn").addEventListener("click", function () {
    setNote("devicesNote", "");
    loadDevices();
});
loadDevices();

$("destWorkupload").addEventListener("click", function () { setDestination("workupload"); });
$("destDrive").addEventListener("click", function () { setDestination("drive"); });

async function setDestination(dest) {
    setNote("destNote", "Switching...");
    try {
        const res = await fetch("/set-destination", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destination: dest })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("destNote", restartMessage("Switched", result.restarted), "ok");
            toast("Destination: " + (dest === "drive" ? "Google Drive" : "WorkUpload"), "ok");
        } else {
            setNote("destNote", result.message || "Could not save the destination.", "err");
        }
    } catch (e) {
        setNote("destNote", "Could not reach the dashboard server.", "err");
    }
    refresh();
}

$("presetSaveBtn").addEventListener("click", async function () {
    const actionSet = $("presetActionSet").value.trim();
    const actionName = $("presetActionName").value.trim();

    if (!actionSet || !actionName) {
        setNote("presetNote", "Enter both the Action Set and Action name.", "err");
        return;
    }

    setNote("presetNote", "Saving...");
    try {
        const res = await fetch("/set-preset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionSet: actionSet, actionName: actionName })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("presetNote", restartMessage("Saved", result.restarted), "ok");
            toast("Preset Action saved", "ok");
        } else {
            setNote("presetNote", result.message || "Could not save the preset.", "err");
        }
    } catch (e) {
        setNote("presetNote", "Could not save the preset.", "err");
    }
    refresh();
});

$("presetClearBtn").addEventListener("click", async function () {
    $("presetActionSet").value = "";
    $("presetActionName").value = "";
    try {
        const res = await fetch("/set-preset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionSet: "", actionName: "" })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("presetNote", restartMessage("Cleared", result.restarted), "ok");
            toast("Preset cleared", "ok");
        } else {
            setNote("presetNote", result.message || "Could not clear the preset.", "err");
        }
    } catch (e) {
        setNote("presetNote", "Could not clear the preset.", "err");
    }
    refresh();
});

/* ---------------- saved Camera Raw preset slots ---------------- */
$("presetSaveSlotBtn").addEventListener("click", async function () {
    const actionSet = $("presetActionSet").value.trim();
    const actionName = $("presetActionName").value.trim();
    if (!actionName) {
        setNote("presetSlotNote", "Fill in the Action Set/Name fields above first.", "err");
        return;
    }
    const label = prompt("Name this preset (e.g. \\"Client A\\", \\"Warm grade\\"):", "");
    if (label === null) return; // cancelled
    if (!label.trim()) {
        setNote("presetSlotNote", "Give this preset a name.", "err");
        return;
    }
    setNote("presetSlotNote", "Saving...");
    try {
        const res = await fetch("/save-preset-slot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: label.trim(), actionSet, actionName })
        });
        const result = await res.json();
        setNote("presetSlotNote", result.ok ? "Saved." : (result.message || "Could not save."), result.ok ? "ok" : "err");
        if (result.ok) refresh();
    } catch (e) {
        setNote("presetSlotNote", "Could not reach the dashboard server.", "err");
    }
});

async function useSlot(id) {
    setNote("presetSlotNote", "Switching...");
    try {
        const res = await fetch("/use-preset-slot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("presetSlotNote", restartMessage("Switched to \\"" + result.slot.label + "\\"", result.restarted), "ok");
            toast("Camera Raw preset switched", "ok");
            refresh();
        } else {
            setNote("presetSlotNote", result.message || "Could not switch.", "err");
        }
    } catch (e) {
        setNote("presetSlotNote", "Could not reach the dashboard server.", "err");
    }
}

async function deleteSlot(id) {
    if (!confirm("Delete this saved preset? This doesn't affect the active Camera Raw preset if it's currently in use.")) return;
    try {
        const res = await fetch("/delete-preset-slot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        const result = await res.json();
        if (result.ok) refresh();
        else setNote("presetSlotNote", result.message || "Could not delete.", "err");
    } catch (e) {
        setNote("presetSlotNote", "Could not reach the dashboard server.", "err");
    }
}

$("saveSettingsBtn").addEventListener("click", async function () {
    setNote("saveStatus", "Saving...");

    const payload = {
        preferredBrowser: $("preferredBrowser").value,
        notifications: { enabled: $("notificationsEnabled").checked },
        autoRetry: {
            enabled: $("autoRetryEnabled").checked,
            maxAttempts: Number($("autoRetryMaxAttempts").value),
            delaySeconds: Number($("autoRetryDelaySeconds").value)
        },
        cleanup: {
            enabled: $("cleanupEnabled").checked,
            afterDays: Number($("cleanupAfterDays").value)
        },
        browserIdle: {
            enabled: $("browserIdleEnabled").checked,
            timeoutSeconds: Number($("browserIdleTimeoutSeconds").value)
        },
        batch: { timeoutSeconds: Number($("batchTimeoutSeconds").value) },
        throttle: {
            enabled: $("throttleEnabled").checked,
            minMs: Number($("throttleMinMs").value),
            maxMs: Number($("throttleMaxMs").value)
        },
        compression: { enabled: $("compressionEnabled").checked, targetMB: Number($("compressionTargetMB").value) }
    };

    try {
        const res = await fetch("/save-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (result.ok) {
            setNote("saveStatus", restartMessage("Saved", result.restarted), "ok");
            toast("Settings saved", "ok");
        } else {
            setNote("saveStatus", result.message || "Could not save settings.", "err");
        }
    } catch (e) {
        setNote("saveStatus", "Could not reach the dashboard server.", "err");
    }
});

/* ---------------- first-run tour ---------------- */
var TOUR_STEPS = [
    { page: "overview", anchor: "tourCardDest", text: "Switch between WorkUpload and Google Drive here — it takes effect immediately, no restart needed." },
    { page: "overview", anchor: "tourCardPreset", text: "Set a Photoshop Action to run automatically on every file right before it uploads (Pro tiers)." },
    { page: "account", anchor: "tourCardPlugins", text: "Install or update your Photoshop, After Effects, Premiere Pro panels and the VEGAS Pro plugin from here." },
    { page: "settings", anchor: "tourCardSettings", text: "Auto-cleanup, retry behavior, and other advanced options live here." }
];
var tourStarted = false;
var tourIndex = 0;
var tourBackdrop = null, tourSpotlight = null, tourBubble = null;

function tourPositionOn(el) {
    var r = el.getBoundingClientRect();
    var pad = 8;
    tourSpotlight.style.top = (r.top - pad) + "px";
    tourSpotlight.style.left = (r.left - pad) + "px";
    tourSpotlight.style.width = (r.width + pad * 2) + "px";
    tourSpotlight.style.height = (r.height + pad * 2) + "px";

    var bubbleTop = r.bottom + 16;
    var bubbleLeft = Math.min(Math.max(r.left, 16), window.innerWidth - 316);
    if (bubbleTop + 160 > window.innerHeight) bubbleTop = Math.max(16, r.top - 170); // flip above if it'd overflow the bottom
    tourBubble.style.top = bubbleTop + "px";
    tourBubble.style.left = bubbleLeft + "px";
}

function tourShowStep(i) {
    var step = TOUR_STEPS[i];
    if (!step) { tourEnd(); return; }
    switchToPage(step.page);
    // wait a tick for the page switch to actually lay out before measuring the target
    requestAnimationFrame(function () {
        var el = $(step.anchor);
        if (!el) { tourIndex++; tourShowStep(tourIndex); return; }
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(function () {
            tourPositionOn(el);
            tourBubble.querySelector(".step").textContent = "Step " + (i + 1) + " of " + TOUR_STEPS.length;
            tourBubble.querySelector("p").textContent = step.text;
            tourBubble.querySelector(".next").textContent = (i === TOUR_STEPS.length - 1) ? "Done" : "Next";
        }, 220); // matches the smooth-scroll's rough settle time
    });
}

function tourEnd() {
    if (tourSpotlight) tourSpotlight.remove();
    if (tourBubble) tourBubble.remove();
    if (tourBackdrop) tourBackdrop.remove();
    tourBackdrop = tourSpotlight = tourBubble = null;
    fetch("/mark-tour-seen", { method: "POST" }).catch(function () {});
}

function startTour() {
    tourIndex = 0;

    tourBackdrop = document.createElement("div");
    tourBackdrop.className = "tour-backdrop";
    document.body.appendChild(tourBackdrop);
    requestAnimationFrame(function () { tourBackdrop.classList.add("show"); });

    tourSpotlight = document.createElement("div");
    tourSpotlight.className = "tour-spotlight";
    document.body.appendChild(tourSpotlight);

    tourBubble = document.createElement("div");
    tourBubble.className = "tour-bubble";
    tourBubble.innerHTML = '<div class="step"></div><p></p><div class="row"><button class="skip">Skip tour</button><button class="next">Next</button></div>';
    document.body.appendChild(tourBubble);

    tourBubble.querySelector(".skip").addEventListener("click", tourEnd);
    tourBubble.querySelector(".next").addEventListener("click", function () { tourIndex++; tourShowStep(tourIndex); });

    tourShowStep(tourIndex);
}

$("tourReplayBtn").addEventListener("click", function () { startTour(); });

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>
`;

// Opens the dashboard and keeps the server alive until the tab has been
// closed for a while (no /data poll for IDLE_MS). The dashboard polls
// every 4s while focused, but browsers throttle setInterval heavily in
// background/inactive tabs — a 20s cutoff was too aggressive and closed
// the server out from under people mid-task (e.g. tabbing to Photoshop
// for a few minutes to record an Action, then coming back to Save). This
// is a local server costing nothing to leave open, so err long: 30
// minutes of true inactivity before it closes itself.
const IDLE_MS = 30 * 60 * 1000;

// If a batch is currently being collected or uploaded, an immediate
// (server.js already keeps it current) and restart the moment it's no
// longer active — or after DEFER_MAX_MS, in case the state file itself
// got stuck (e.g. helper crashed mid-batch and never wrote "idle").
const ACTIVE_BATCH_STATES = new Set(["uploading", "collecting"]);
const DEFER_POLL_MS = 2000;
const DEFER_MAX_MS = 5 * 60 * 1000;

function restartLogSuffix(restartStatus) {
    if (restartStatus === "now") return " — restarting helper";
    if (restartStatus === "deferred") return " — will restart once the current batch finishes";
    return "";
}

function restartWhenIdle(log, restartHelperFn) {
    const current = readBatchStatus();
    if (!current || !ACTIVE_BATCH_STATES.has(current.state)) {
        restartHelperFn();
        return "now";
    }

    log(`Dashboard: restart deferred — a batch is currently "${current.state}".`);
    const startedAt = Date.now();
    const check = setInterval(() => {
        const s = readBatchStatus();
        const stillActive = s && ACTIVE_BATCH_STATES.has(s.state);
        const timedOut = Date.now() - startedAt > DEFER_MAX_MS;
        if (!stillActive || timedOut) {
            clearInterval(check);
            log(timedOut
                ? "Dashboard: deferred restart timed out — restarting anyway."
                : "Dashboard: batch finished — restarting helper now.");
            restartHelperFn();
        }
    }, DEFER_POLL_MS);
    return "deferred";
}

function openDashboard(log = console.log, controls = {}) {
    const isRunning = typeof controls.isRunning === "function" ? controls.isRunning : () => false;
    const restartHelperFn = typeof controls.restartHelper === "function" ? controls.restartHelper : () => {};
    const quitAppFn = typeof controls.quitApp === "function" ? controls.quitApp : null;

    refreshPsInstallStatus(log); // ask UPIA for the real state as soon as the Dashboard opens, not just after an install/uninstall click

    function restartIfRunning() {
        if (!isRunning()) return "not-running";
        return restartWhenIdle(log, restartHelperFn);
    }

    let lastSeen = Date.now();
    let closed = false;

    const server = http.createServer((req, res) => {
        lastSeen = Date.now();
        let url;
        try {
            url = new URL(req.url, "http://127.0.0.1");
        } catch {
            res.writeHead(400);
            res.end();
            return;
        }

        if (url.pathname === "/" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(DASHBOARD_HTML);
            return;
        }

        // Everything below reads/writes real files on the user's machine
        // (config, engine status, plugin manifests, backups...) — any one
        // of those can throw in a way that's fine to catch and report, but
        // is NOT fine to let crash the whole dashboard server the way an
        // uncaught exception in a request listener does in Node. This
        // wrapper is what turns "the whole Dashboard silently died" into
        // an actual JSON error the page can show.
        try {

        if (url.pathname === "/data" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(buildData()));
            return;
        }

        if (url.pathname === "/save-hotkey" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
                try {
                    const p = JSON.parse(body || "{}");
                    const send = hotkey.normalizeCombo(p.send);
                    const sendPs = hotkey.normalizeCombo(p.sendPs);
                    if (!send) return reply({ ok: false, message: "\"Upload\" needs a shortcut with Ctrl, Alt, Shift or Win plus one key, e.g. Ctrl+Alt+U." });
                    if (!sendPs) return reply({ ok: false, message: "\"Photoshop + Upload\" needs a shortcut with Ctrl, Alt, Shift or Win plus one key." });
                    if (send === sendPs) return reply({ ok: false, message: "The two actions need different shortcuts." });
                    const cfg = readHelperConfig();
                    cfg.hotkey = { enabled: !!p.enabled, send, sendPs };
                    writeHelperConfig(cfg);
                    try { hotkey.ensureRunning(msg => log(`Shortcut: ${msg}`)); } catch (err) { log(`Shortcut: ${err.message}`); }
                    log(`Dashboard: global shortcut ${cfg.hotkey.enabled ? `set to ${send} / ${sendPs}` : "turned off"}.`);
                    reply({ ok: true });
                } catch (err) {
                    reply({ ok: false, message: err.message });
                }
            });
            return;
        }

        if (url.pathname.indexOf("/presets/") === 0 && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", async () => {
                const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
                try {
                    const parsed = JSON.parse(body || "{}");
                    const name = String(parsed.name || "").trim();
                    const loaded = presetStore.loadPresets(CONFIG_FILE);
                    const find = n => loaded.presets.find(p => p.name.toLowerCase() === String(n).toLowerCase());

                    if (url.pathname === "/presets/save") {
                        if (!name) return reply({ ok: false, message: "Give the preset a name." });
                        const existing = find(name);
                        if (existing && !parsed.overwrite) return reply({ ok: false, message: `A preset called "${existing.name}" already exists - use "Update from current" to overwrite it.` });
                        const cfg = readHelperConfig();
                        const snap = presetStore.snapshotFromConfig({
                            destination: cfg.destination, drive: cfg.drive, compression: cfg.compression, cameraRawPreset: cfg.cameraRawPreset
                        }, existing ? existing.name : name);
                        const next = loaded.presets.filter(p => p !== existing).concat(snap);
                        if (!existing && next.length > presetStore.MAX_PRESETS) return reply({ ok: false, message: `At most ${presetStore.MAX_PRESETS} presets - delete one first.` });
                        presetStore.savePresets(CONFIG_FILE, next, loaded.activePreset);
                        log(`Dashboard: preset "${snap.name}" ${existing ? "updated" : "saved"}.`);
                        return reply({ ok: true });
                    }

                    if (url.pathname === "/presets/delete") {
                        const existing = find(name);
                        if (!existing) return reply({ ok: false, message: "No such preset." });
                        presetStore.savePresets(CONFIG_FILE, loaded.presets.filter(p => p !== existing), loaded.activePreset === existing.name ? null : loaded.activePreset);
                        log(`Dashboard: preset "${existing.name}" deleted.`);
                        return reply({ ok: true });
                    }

                    if (url.pathname === "/presets/apply") {
                        const preset = find(name);
                        if (!preset) return reply({ ok: false, message: "No such preset." });
                        if (engineIsFresh()) {
                            // the running helper applies it live - ask and wait for its answer
                            const id = String(Date.now());
                            try { fs.unlinkSync(PRESET_RESULT_FILE); } catch {}
                            fs.writeFileSync(PRESET_REQUEST_FILE, JSON.stringify({ id, name: preset.name }), "utf8");
                            for (let i = 0; i < 30; i++) {
                                await new Promise(r => setTimeout(r, 150));
                                try {
                                    const result = JSON.parse(fs.readFileSync(PRESET_RESULT_FILE, "utf8"));
                                    if (result.id === id) return reply({ ok: !!result.ok, message: result.message || "" });
                                } catch {}
                            }
                            return reply({ ok: false, message: "The helper didn't answer in time - try again in a moment." });
                        }
                        // helper not running: write the settings so the next start uses them
                        presetStore.applyPresetToFile(CONFIG_FILE, preset);
                        log(`Dashboard: preset "${preset.name}" applied to helper-config.json (helper not running).`);
                        return reply({ ok: true, message: "The helper isn't running - the preset is used from its next start." });
                    }

                    reply({ ok: false, message: "Unknown preset action." });
                } catch (err) {
                    reply({ ok: false, message: err.message });
                }
            });
            return;
        }

        if (url.pathname === "/history" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ items: uploadHistory.read() }));
            return;
        }

        if (url.pathname === "/history/clear" && req.method === "POST") {
            try { uploadHistory.clear(); } catch (err) { log(`Could not clear the upload history: ${err.message}`); }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (url.pathname === "/history/delete" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                let removed = false;
                try { removed = uploadHistory.remove(String(JSON.parse(body || "{}").id || "")); } catch {}
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: removed }));
            });
            return;
        }

        if (url.pathname === "/accept-legal" && req.method === "POST") {
            try {
                let email = null;
                try { email = JSON.parse(fs.readFileSync(path.join(APP_DIR, "license-cache.json"), "utf8")).email || null; } catch {}
                legal.recordConsent(email);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, consent: legal.consentSummary() }));
            } catch (err) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            }
            return;
        }

        if (url.pathname === "/self-test" && req.method === "GET") {
            diagnostics.runSelfTest().then(result => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
            }).catch(err => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            });
            return;
        }

        if (url.pathname === "/make-diagnostics" && req.method === "POST") {
            diagnostics.buildDiagnostics(log).then(result => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
            });
            return;
        }

        if (url.pathname === "/open-diagnostics-folder" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                let opened = false;
                try {
                    const parsed = JSON.parse(body || "{}");
                    const target = path.resolve(String(parsed.path || ""));
                    // only ever reveal files inside the diagnostics folder
                    if (target.startsWith(path.resolve(diagnostics.DIAG_DIR) + path.sep) && fs.existsSync(target)) {
                        const child = spawn("explorer.exe", ["/select," + target], { detached: true, windowsHide: false });
                        child.on("error", err => log(`Could not open the diagnostics folder: ${err.message}`));
                        child.unref();
                        opened = true;
                    }
                } catch (err) {
                    log(`Could not open the diagnostics folder: ${err.message}`);
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: opened }));
            });
            return;
        }

        if (url.pathname === "/plugin-updates" && req.method === "GET") {
            pluginUpdates.checkPluginUpdates(url.searchParams.get("force") === "1").then(info => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(info));
            });
            return;
        }

        if (url.pathname === "/download-plugin-updates" && req.method === "POST") {
            pluginUpdates.downloadPluginUpdates(null, log).then(out => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(out));
            }).catch(err => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, results: [], message: err.message }));
            });
            return;
        }

        if (url.pathname === "/force-refresh-tier" && req.method === "POST") {
            try {
                if (fs.existsSync(LICENSE_CACHE_FILE)) fs.unlinkSync(LICENSE_CACHE_FILE);
                const restarted = restartIfRunning();
                log(`Dashboard: license cache cleared, forcing a fresh tier check${restartLogSuffix(restarted)}.`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, restarted }));
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            }
            return;
        }

        if (url.pathname === "/redeem-license" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", async () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const code = String(parsed.code || "").trim();
                    const { redeemLicenseCode } = require("./license-actions.js");
                    const result = await redeemLicenseCode(code);

                    if (!result.ok) {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, message: result.message }));
                        return;
                    }

                    const restarted = restartIfRunning();
                    log(`Dashboard: license code redeemed — new tier "${result.tier}"${restartLogSuffix(restarted)}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, tier: result.tier, trialDaysRemaining: result.trialDaysRemaining, ambiguous: !!result.ambiguous, message: result.message || null, restarted }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/list-devices" && req.method === "GET") {
            (async () => {
                try {
                    const { listDevices } = require("./license-actions.js");
                    const result = await listDevices();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            })();
            return;
        }

        if (url.pathname === "/remove-device" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", async () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const deviceId = String(parsed.deviceId || "").trim();
                    const { removeDevice } = require("./license-actions.js");
                    const result = await removeDevice(deviceId);
                    if (result.ok) {
                        const restarted = restartIfRunning(); // so THIS machine re-checks its tier with the freed slot
                        log(`Dashboard: removed a registered device${restartLogSuffix(restarted)}.`);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, restarted }));
                        return;
                    }
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: result.message || "Could not remove that device." }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/set-destination" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const destination = VALID_DESTINATIONS.includes(parsed.destination) ? parsed.destination : "workupload";
                    const cfg = readHelperConfig();
                    cfg.destination = destination;
                    writeHelperConfig(cfg);
                    const restarted = restartIfRunning();
                    log(`Dashboard: destination set to "${destination}"${restartLogSuffix(restarted)}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, restarted }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/save-preset-slot" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const label = String(parsed.label || "").trim().slice(0, 60);
                    const actionSet = String(parsed.actionSet || "").slice(0, 200);
                    const actionName = String(parsed.actionName || "").trim().slice(0, 200);
                    if (!actionName) throw new Error("Action name can't be empty.");
                    if (!label) throw new Error("Give this preset a name.");
                    const cfg = readHelperConfig();
                    if (!Array.isArray(cfg.cameraRawPresets)) cfg.cameraRawPresets = [];
                    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                    cfg.cameraRawPresets.push({ id, label, actionSet, actionName });
                    writeHelperConfig(cfg);
                    log(`Dashboard: saved Camera Raw preset slot "${label}" ("${actionSet}" / "${actionName}").`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, id }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/use-preset-slot" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const cfg = readHelperConfig();
                    const slot = (cfg.cameraRawPresets || []).find(s => s.id === parsed.id);
                    if (!slot) throw new Error("That saved preset no longer exists.");
                    cfg.cameraRawPreset = { actionSet: slot.actionSet, actionName: slot.actionName };
                    writeHelperConfig(cfg);
                    const restarted = restartIfRunning();
                    log(`Dashboard: switched active Camera Raw preset to "${slot.label}"${restartLogSuffix(restarted)}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, restarted, slot }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/delete-preset-slot" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const cfg = readHelperConfig();
                    cfg.cameraRawPresets = (cfg.cameraRawPresets || []).filter(s => s.id !== parsed.id);
                    writeHelperConfig(cfg);
                    log("Dashboard: deleted a saved Camera Raw preset slot.");
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/set-preset" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const actionSet = String(parsed.actionSet || "").slice(0, 200);
                    const actionName = String(parsed.actionName || "").slice(0, 200);
                    const cfg = readHelperConfig();
                    cfg.cameraRawPreset = actionName.trim() ? { actionSet, actionName } : null;
                    writeHelperConfig(cfg);
                    const restarted = restartIfRunning();
                    log(`Dashboard: default Camera Raw preset ${actionName.trim() ? `saved ("${actionSet}" / "${actionName}")` : "cleared"}${restartLogSuffix(restarted)}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, restarted }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/save-settings" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const p = JSON.parse(body || "{}");
                    const cfg = readHelperConfig();

                    if (VALID_BROWSERS.includes(p.preferredBrowser)) cfg.preferredBrowser = p.preferredBrowser;

                    cfg.notifications = { enabled: !!(p.notifications && p.notifications.enabled) };

                    cfg.autoRetry = {
                        enabled: !!(p.autoRetry && p.autoRetry.enabled),
                        maxAttempts: Math.min(10, Math.max(1, Math.floor((p.autoRetry && p.autoRetry.maxAttempts) || 3))),
                        delaySeconds: Math.min(600, Math.max(0, (p.autoRetry && p.autoRetry.delaySeconds) || 10))
                    };

                    cfg.cleanup = {
                        enabled: !!(p.cleanup && p.cleanup.enabled),
                        afterDays: Math.min(365, Math.max(1, Math.floor((p.cleanup && p.cleanup.afterDays) || 7)))
                    };

                    cfg.browserIdle = {
                        enabled: !!(p.browserIdle && p.browserIdle.enabled),
                        timeoutSeconds: Math.min(3600, Math.max(30, (p.browserIdle && p.browserIdle.timeoutSeconds) || 120))
                    };

                    cfg.batch = {
                        timeoutSeconds: Math.min(3600, Math.max(10, (p.batch && p.batch.timeoutSeconds) || 120))
                    };

                    cfg.throttle = {
                        enabled: !!(p.throttle && p.throttle.enabled),
                        minMs: Math.min(60000, Math.max(0, (p.throttle && p.throttle.minMs) || 500)),
                        maxMs: Math.min(60000, Math.max(0, (p.throttle && p.throttle.maxMs) || 2000))
                    };

                    cfg.compression = presetStore.sanitizeCompression(p.compression);

                    writeHelperConfig(cfg);
                    const restarted = restartIfRunning();
                    log(`Dashboard: settings saved${restartLogSuffix(restarted)}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, restarted }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/update-info" && req.method === "GET") {
            (async () => {
                try {
                    const { checkForUpdate } = require("./update-check.js");
                    const info = await checkForUpdate(false); // cached — cheap to poll
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(info));
                } catch (err) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ hasUpdate: false, latestVersion: null, downloadUrl: null, lastError: err.message }));
                }
            })();
            return;
        }

        if (url.pathname === "/check-update" && req.method === "POST") {
            (async () => {
                try {
                    const { checkForUpdate } = require("./update-check.js");
                    const info = await checkForUpdate(true); // force — bypasses the 24h cache
                    log(`Dashboard: manual update check — ${info.hasUpdate ? `update available (${info.latestVersion})` : "up to date"}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(info));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            })();
            return;
        }

        if (url.pathname === "/install-update" && req.method === "POST") {
            (async () => {
                try {
                    const { checkForUpdate, downloadAndRunInstaller } = require("./update-check.js");
                    const info = await checkForUpdate(false); // cached info already has the asset URL
                    const savedTo = await downloadAndRunInstaller(info);
                    log(`Dashboard: downloaded update installer to ${savedTo} and launched it.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, path: savedTo }));
                } catch (err) {
                    log(`Dashboard: update install failed — ${err.message}`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            })();
            return;
        }

        if (url.pathname === "/refresh-ps-status" && req.method === "POST") {
            refreshPsInstallStatus(log);
            // The check itself is async and this doesn't block on it — the
            // client just re-polls /data a moment later via refresh().
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (url.pathname === "/install-plugin" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const plugin = PLUGINS[parsed.plugin];
                    if (!plugin) throw new Error("Unknown plugin.");
                    if (parsed.plugin === "ppro") {
                        const status = readEngineStatus();
                        const tier = status && status.tier;
                        const hasSpt = !!(status && Array.isArray(status.roles) && status.roles.indexOf("spt") !== -1);
                        if (tier && !DRIVE_TIERS.has(tier) && !hasSpt) throw new Error("The Premiere Pro panel needs a Pro license or the Spidx Thumbnail Pack.");
                    }
                    if (!fs.existsSync(plugin.installer)) throw new Error(`${plugin.label}: installer script not found next to the App folder.`);
                    log(`Dashboard: launching ${plugin.label} installer at "${plugin.installer}".`);
                    spawnBatFile(plugin.installer, log, (ok, message) => {
                        if (ok && parsed.plugin === "ps") watchPsInstall(log);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: "Windows refused to start it: " + message }));
                    });
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/uninstall-plugin" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const plugin = PLUGINS[parsed.plugin];
                    if (!plugin) throw new Error("Unknown plugin.");
                    if (!fs.existsSync(plugin.uninstaller)) throw new Error(`${plugin.label}: uninstaller script not found next to the App folder.`);
                    log(`Dashboard: launching ${plugin.label} uninstaller at "${plugin.uninstaller}".`);
                    spawnBatFile(plugin.uninstaller, log, (ok, message) => {
                        if (ok && parsed.plugin === "ps") watchPsInstall(log);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: "Windows refused to start it: " + message }));
                    });
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/backup-config" && req.method === "GET") {
            try {
                const cfg = readHelperConfig();
                const backup = { exportedAt: new Date().toISOString(), appVersion: readAppVersion(), config: cfg };
                const filename = `spidx-uploader-backup-${new Date().toISOString().slice(0, 10)}.json`;
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Content-Disposition": `attachment; filename="${filename}"`
                });
                res.end(JSON.stringify(backup, null, 2));
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            }
            return;
        }

        if (url.pathname === "/restore-config" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const incoming = parsed && typeof parsed.config === "object" && parsed.config !== null ? parsed.config : parsed;
                    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
                        throw new Error("That doesn't look like a Spidx Uploader backup file.");
                    }
                    writeHelperConfig(incoming);
                    const restarted = restartIfRunning();
                    log(`Dashboard: config restored from backup file${restartLogSuffix(restarted)}.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, restarted }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/mark-tour-seen" && req.method === "POST") {
            try {
                const cfg = readHelperConfig();
                cfg.dashboardTourSeen = true;
                writeHelperConfig(cfg);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            }
            return;
        }

        if (url.pathname === "/logout" && req.method === "POST") {
            try {
                if (fs.existsSync(GOOGLE_TOKEN_FILE)) fs.unlinkSync(GOOGLE_TOKEN_FILE);
                if (fs.existsSync(LICENSE_CACHE_FILE)) fs.unlinkSync(LICENSE_CACHE_FILE);
                log("Dashboard: logged out (Google sign-in + tier cache cleared) — restarting the app.");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, canQuit: !!quitAppFn }));
                // Respond first, then quit — the browser tab needs the response
                // to show a "logged out" message before the tray process (and
                // this server with it) disappears.
                if (quitAppFn) setTimeout(() => quitAppFn(), 300);
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            }
            return;
        }

        res.writeHead(404);
        res.end();

        } catch (err) {
            log(`Dashboard route ${url.pathname} crashed: ${err.stack || err.message}`);
            try {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            } catch {}
        }
    });

    server.on("error", err => log(`Dashboard server error: ${err.message}`));

    server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const url = `http://127.0.0.1:${port}/`;
        log(`Dashboard opened at ${url}`);
        openInBrowser(url, log);
    });

    const idleCheck = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastSeen > IDLE_MS) {
            closed = true;
            clearInterval(idleCheck);
            server.close();
            log("Dashboard closed (tab inactive).");
        }
    }, 5000);
}

module.exports = { openDashboard };
