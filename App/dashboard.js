"use strict";

/* ========================================================================
 *  Dashboard
 *
 *  Same pattern as setup-wizard.js: a tiny local HTTP server on a random
 *  127.0.0.1 port, opened on demand in the system browser (tray menu ->
 *  "Open Dashboard"), and closed again once the tab is closed / a fresh
 *  request hasn't come in for a while. Unlike the wizard, this isn't a
 *  one-shot flow - it stays up while the tab is open and polls /data for
 *  live-ish status.
 *
 *  It reads/writes the same files server.js and tray.js already use
 *  (helper-config.json, the .engine-status.json / helper-events.jsonl /
 *  last-upload.json the running helper writes). It does NOT talk to a
 *  running server.js process directly - config changes made here take
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
const UPLOAD_PROGRESS_FILE = path.join(INCOMING, ".upload-progress.json");
const UPLOAD_CANCEL_FILE = path.join(INCOMING, ".upload-cancel");
const HOTKEY_STATUS_FILE = path.join(INCOMING, ".hotkey-status.json");
const PRESET_REQUEST_FILE = path.join(INCOMING, ".preset-request.json");
const PRESET_RESULT_FILE = path.join(INCOMING, ".preset-result.json");
const EVENTS_FILE = path.join(APP_DIR, "helper-events.jsonl");
const LICENSE_CACHE_FILE = path.join(APP_DIR, "license-cache.json");
const LAST_UPLOAD_FILE = path.join(APP_DIR, "last-upload.json");
const GOOGLE_TOKEN_FILE = path.join(APP_DIR, "google-token.json");
const PACKAGE_FILE = path.join(APP_DIR, "package.json");

// Plugin install/uninstall/version - same installer/uninstaller .bat
// files the setup wizard uses, just triggered from here too now.
const CEP_EXTENSIONS_DIR = path.join(process.env.APPDATA || "", "Adobe", "CEP", "extensions");
const upia = require("./upia.js");
const diagnostics = require("./diagnostics.js");
const legal = require("./legal.js");
const brand = require("./brand.js");
const uploadHistory = require("./history.js");
const presetStore = require("./presets.js");
const hotkey = require("./hotkey.js");
const pluginUpdates = require("./plugin-updates.js");
const i18n = require("./i18n.js");
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
        // Photoshop already has it - the button always reads "Install"
        // rather than "Update".
        return {
            label: p.label,
            kind: "upia",
            ccxAvailable: fs.existsSync(p.ccx) && fs.existsSync(p.installer),
            upiaAvailable: !!upia.getUpiaPath(),
            // Real install state, from actually asking UPIA (see
            // refreshPsInstallStatus below) - ccxAvailable/upiaAvailable
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
        // Only meaningful when both are known - a plain string compare is
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
// called - that's what made previous failures invisible.
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

// Dashboard look & feel (theme + which settings folds are open). Kept in helper-config.json because the
// Dashboard runs on a random local port, so the browser's own localStorage would be forgotten every time.
const VALID_THEMES = ["auto", "dark", "light"];
const UI_FOLD_IDS = new Set(["presets", "uploading", "images", "housekeeping", "hotkey", "language"]);

function sanitizeUi(raw) {
    const out = { theme: "auto", folds: {} };
    if (raw && typeof raw === "object") {
        if (VALID_THEMES.includes(raw.theme)) out.theme = raw.theme;
        if (raw.folds && typeof raw.folds === "object") {
            for (const k of Object.keys(raw.folds)) if (UI_FOLD_IDS.has(k)) out.folds[k] = !!raw.folds[k];
        }
    }
    return out;
}

/* ---------------------------------------------------------------------- *
 *  Templates (After Effects SPT tab) - the Thumbnail Pack content
 *
 *  The ready-made templates, presets and MOGRT are NOT in the installer any more: the helper downloads them
 *  from the licence server into %APPDATA%\\Spidx Uploader\\pack, only for an account that has the Pack
 *  (pack-content.js). This page shows what is there and lets that account add its OWN templates (.aep +
 *  composition + text layer). Entries the server manages are marked "pack" and cannot be edited here.
 * ---------------------------------------------------------------------- */
const packContent = require("./pack-content.js");
const TEMPLATE_AEP_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,78}\.aep$/i;
const TEMPLATE_MAX_BYTES = 150 * 1024 * 1024;
const PACK_SYNC_REQUEST_FILE = path.join(INCOMING, ".pack-sync-request");

function packEntitledFromStatus(status) {
    const roles = (status && Array.isArray(status.roles)) ? status.roles : [];
    return roles.includes("spt") || roles.includes("dev") || roles.includes("tester") || !!(status && (status.tier === "dev" || status.tier === "tester"));
}

function readJsonFile(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

// Best effort: is this composition name somewhere in the .aep? (the format is binary, so a plain search
// of the file for the name - as UTF-8 and as UTF-16 - is the cheap honest check; null = could not tell)
function compositionInAep(file, comp) {
    try {
        const st = fs.statSync(file);
        if (st.size > 80 * 1024 * 1024) return null;
        const buf = fs.readFileSync(file);
        return buf.includes(Buffer.from(comp, "utf8")) || buf.includes(Buffer.from(comp, "utf16le")) || buf.includes(Buffer.from(comp, "latin1"));
    } catch { return null; }
}

function buildTemplatesInfo() {
    const status = readEngineStatus();
    const entitled = packEntitledFromStatus(status);
    const pack = (status && status.pack) || null;
    if (!entitled) return { ok: true, entitled: false, pack, items: [], files: [], presets: [], mogrts: 0 };

    const root = packContent.packRoot();
    const tplDir = path.join(root, "ae", "templates");
    const managed = new Set(Object.keys((packContent._readState().files)).map(rel => path.basename(rel)));

    const items = readJsonFile(path.join(tplDir, "templates.json"), []).map((t, i) => {
        const file = String(t.file || "");
        const full = TEMPLATE_AEP_RE.test(file) ? path.join(tplDir, file) : null;
        const fileExists = !!(full && fs.existsSync(full));
        return {
            id: i, name: String(t.name || t.comp || ""), file, comp: String(t.comp || ""), textLayer: String(t.textLayer || ""),
            source: t.source === "user" ? "user" : "pack", fileExists,
            compFound: fileExists && t.comp ? compositionInAep(full, String(t.comp)) : null
        };
    });

    let files = [];
    try {
        files = fs.readdirSync(tplDir).filter(f => TEMPLATE_AEP_RE.test(f)).map(f => ({ name: f, size: fs.statSync(path.join(tplDir, f)).size, managed: managed.has(f) }));
    } catch {}

    const presetDir = path.join(root, "ae", "presets");
    const presets = readJsonFile(path.join(presetDir, "spt.json"), []).map(p => {
        let size = null;
        try { size = fs.statSync(path.join(presetDir, String(p.file || ""))).size; } catch {}
        return { name: String(p.name || p.file), file: String(p.file || ""), exists: size !== null, size };
    });

    const mogrts = readJsonFile(path.join(root, "ppro", "mogrts", "mogrts.json"), []).length;
    return { ok: true, entitled: true, pack, items, files, presets, mogrts };
}

function readBodyLimited(req, limit, cb) {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on("data", c => {
        if (dead) return;
        size += c.length;
        if (size > limit) { dead = true; req.destroy(); cb(new Error("The file is too large.")); return; }
        chunks.push(c);
    });
    req.on("end", () => { if (!dead) cb(null, Buffer.concat(chunks)); });
    req.on("error", err => { if (!dead) { dead = true; cb(err); } });
}

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

// Live progress of a big upload (video); only trusted while the engine keeps refreshing it.
function readUploadProgress() {
    try {
        const p = JSON.parse(fs.readFileSync(UPLOAD_PROGRESS_FILE, "utf8"));
        if (!p || !p.updatedAt || Date.now() - p.updatedAt > 30000) return null;
        return p;
    } catch { return null; }
}

function readLastUpload() {
    try {
        return JSON.parse(fs.readFileSync(LAST_UPLOAD_FILE, "utf8"));
    } catch {
        return null;
    }
}

// helper-events.jsonl already exists (server.js writes one line per
// pipeline step) - this just tails it and turns each line into a short,
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
        // glance - skip the fine-grained per-attempt/per-step noise.
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
            if (e.status === "start") return i18n.t("Batch started - {count} file(s)", { count: extra.count || "?" });
            if (e.status === "ok") return i18n.t("Batch uploaded - {count} file(s), {links} link(s) found", { count: extra.count || "?", links: extra.linksFound || 0 });
            if (e.status === "fail") return i18n.t("Batch failed - {count} file(s) could not be sent", { count: (extra.failedFiles || []).length });
            return i18n.t("Batch event");
        case "queue":
            return i18n.t("{count} file(s) queued ({queue} in queue)", { count: extra.count || "?", queue: extra.queueLength || "?" });
        case "google_signin":
            if (e.status === "ok") return i18n.t("Signed in as {email}", { email: extra.email || i18n.t("unknown") });
            if (e.status === "fail") return i18n.t("Google sign-in failed");
            return i18n.t("Google sign-in");
        case "license_check":
            if (e.status === "ok") return i18n.t("Tier check completed");
            if (e.status === "fail") return i18n.t("Tier check failed - using cached/default tier");
            return i18n.t("Tier check");
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
        proFeaturesAllowed: tier === null || DRIVE_TIERS.has(tier), // same tier set - Camera Raw preset routing
        pproAllowed: true, // since 3.0 the Premiere Pro panel (and VEGAS Pro) are on every plan; the free plan has a monthly video-render allowance instead
        engineSeen: !!status,
        statusUpdatedAt: (status && status.updatedAt) || null,
        appVersion: readAppVersion(),
        consent: legal.consentSummary(),
        plugins: { ae: readPluginStatus("ae"), ppro: readPluginStatus("ppro"), vegas: readPluginStatus("vegas"), ps: readPluginStatus("ps") },
        pluginUpdates: pluginUpdates.readCachedPluginUpdates(),
        failedUploads: (status && Number(status.failedUploads)) || 0,   // uploads that did not go through (can be retried)
        renders: (status && status.renders) || null,   // { used, limit (null = unlimited), remaining, month } from the helper
        destination,
        cameraRawPreset: cfg.cameraRawPreset && cfg.cameraRawPreset.actionName
            ? { actionSet: cfg.cameraRawPreset.actionSet || "", actionName: cfg.cameraRawPreset.actionName }
            : null,
        // Saved slots so switching which Action runs doesn't mean retyping
        // Set/Name every time - "activate" just copies a slot's values into
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
        uploadProgress: readUploadProgress(),
        lastUpload: readLastUpload(),
        events: readRecentEvents(12),
        tourSeen: !!cfg.dashboardTourSeen
    };
}

// The page itself lives in App\\dashboard-ui\\ (index.html, dashboard.css, client.js) - plain files that can be
// edited, linted and syntax-checked on their own. They are stitched together per request, so a change shows up
// on the next page reload without restarting anything.
const UI_DIR = path.join(APP_DIR, "dashboard-ui");

function readUiFile(name) {
    return fs.readFileSync(path.join(UI_DIR, name), "utf8");
}

function buildDashboardHtml(htmlFile = "index.html") {
    // placeholders first, then the big files - so text inside them can never be mistaken for a placeholder
    return readUiFile(htmlFile)
        .split("{{LOGO}}").join(brand.LOGO)
        .split("{{FAVICON}}").join(brand.FAVICON)
        .split("{{SUPPORT_EMAIL}}").join(legal.SUPPORT_EMAIL)
        .replace("/*__CSS__*/", () => readUiFile(htmlFile === "index.html" ? "dashboard.css" : "updater.css"))
        .replace("/*__CLIENT__*/", () => readUiFile(htmlFile === "index.html" ? "client.js" : "updater.js"));
}

// The Updater window: a small app-style window (Edge/Chrome --app, no tabs or address bar) when one is
// installed, the normal browser otherwise (see app-window.js).
function openAppWindow(url, width, height, log) {
    require("./app-window.js").openAppWindow(url, width, height, log, u => openInBrowser(u, log));
}

// Progress of the update download, polled by the Updater window.
let updateJob = { state: "idle", received: 0, total: 0, startedAt: 0, error: null };

// Opens the dashboard and keeps the server alive until the tab has been
// closed for a while (no /data poll for IDLE_MS). The dashboard polls
// every 4s while focused, but browsers throttle setInterval heavily in
// background/inactive tabs - a 20s cutoff was too aggressive and closed
// the server out from under people mid-task (e.g. tabbing to Photoshop
// for a few minutes to record an Action, then coming back to Save). This
// is a local server costing nothing to leave open, so err long: 30
// minutes of true inactivity before it closes itself.
const IDLE_MS = 30 * 60 * 1000;

// If a batch is currently being collected or uploaded, an immediate
// (server.js already keeps it current) and restart the moment it's no
// longer active - or after DEFER_MAX_MS, in case the state file itself
// got stuck (e.g. helper crashed mid-batch and never wrote "idle").
const ACTIVE_BATCH_STATES = new Set(["uploading", "collecting"]);
const DEFER_POLL_MS = 2000;
const DEFER_MAX_MS = 5 * 60 * 1000;

function restartLogSuffix(restartStatus) {
    if (restartStatus === "now") return " - restarting helper";
    if (restartStatus === "deferred") return " - will restart once the current batch finishes";
    return "";
}

function restartWhenIdle(log, restartHelperFn) {
    const current = readBatchStatus();
    if (!current || !ACTIVE_BATCH_STATES.has(current.state)) {
        restartHelperFn();
        return "now";
    }

    log(`Dashboard: restart deferred - a batch is currently "${current.state}".`);
    const startedAt = Date.now();
    const check = setInterval(() => {
        const s = readBatchStatus();
        const stillActive = s && ACTIVE_BATCH_STATES.has(s.state);
        const timedOut = Date.now() - startedAt > DEFER_MAX_MS;
        if (!stillActive || timedOut) {
            clearInterval(check);
            log(timedOut
                ? "Dashboard: deferred restart timed out - restarting anyway."
                : "Dashboard: batch finished - restarting helper now.");
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
            let page;
            try {
                page = buildDashboardHtml();
            } catch (err) {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("The Dashboard files are missing (App\\dashboard-ui): " + err.message);
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(page
                .replace("/*__I18N__*/", () => i18n.clientScript())
                .replace("/*__UI__*/{}", () => JSON.stringify(sanitizeUi(readHelperConfig().ui))));
            return;
        }

        // Everything below reads/writes real files on the user's machine
        // (config, engine status, plugin manifests, backups...) - any one
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
                    if (!send) return reply({ ok: false, message: i18n.t("\"Upload\" needs a shortcut with Ctrl, Alt, Shift or Win plus one key, e.g. Ctrl+Alt+U.") });
                    if (!sendPs) return reply({ ok: false, message: i18n.t("\"Photoshop + Upload\" needs a shortcut with Ctrl, Alt, Shift or Win plus one key.") });
                    if (send === sendPs) return reply({ ok: false, message: i18n.t("The two actions need different shortcuts.") });
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
                        if (!name) return reply({ ok: false, message: i18n.t("Give the preset a name.") });
                        const existing = find(name);
                        if (existing && !parsed.overwrite) return reply({ ok: false, message: i18n.t("A preset called \"{name}\" already exists - use \"Update from current\" to overwrite it.", { name: existing.name }) });
                        const cfg = readHelperConfig();
                        const snap = presetStore.snapshotFromConfig({
                            destination: cfg.destination, drive: cfg.drive, compression: cfg.compression, cameraRawPreset: cfg.cameraRawPreset
                        }, existing ? existing.name : name);
                        const next = loaded.presets.filter(p => p !== existing).concat(snap);
                        if (!existing && next.length > presetStore.MAX_PRESETS) return reply({ ok: false, message: i18n.t("At most {max} presets - delete one first.", { max: presetStore.MAX_PRESETS }) });
                        presetStore.savePresets(CONFIG_FILE, next, loaded.activePreset);
                        log(`Dashboard: preset "${snap.name}" ${existing ? "updated" : "saved"}.`);
                        return reply({ ok: true });
                    }

                    if (url.pathname === "/presets/delete") {
                        const existing = find(name);
                        if (!existing) return reply({ ok: false, message: i18n.t("No such preset.") });
                        presetStore.savePresets(CONFIG_FILE, loaded.presets.filter(p => p !== existing), loaded.activePreset === existing.name ? null : loaded.activePreset);
                        log(`Dashboard: preset "${existing.name}" deleted.`);
                        return reply({ ok: true });
                    }

                    if (url.pathname === "/presets/apply") {
                        const preset = find(name);
                        if (!preset) return reply({ ok: false, message: i18n.t("No such preset.") });
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
                            return reply({ ok: false, message: i18n.t("The helper didn't answer in time - try again in a moment.") });
                        }
                        // helper not running: write the settings so the next start uses them
                        presetStore.applyPresetToFile(CONFIG_FILE, preset);
                        log(`Dashboard: preset "${preset.name}" applied to helper-config.json (helper not running).`);
                        return reply({ ok: true, message: i18n.t("The helper isn't running - the preset is used from its next start.") });
                    }

                    reply({ ok: false, message: i18n.t("Unknown preset action.") });
                } catch (err) {
                    reply({ ok: false, message: err.message });
                }
            });
            return;
        }

        // Language choice: just a config value - the page reloads itself, the helper is NOT restarted.
        if (url.pathname === "/updater" && req.method === "GET") {
            let page;
            try {
                page = buildDashboardHtml("updater.html");
            } catch (err) {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("The Updater files are missing (App\\dashboard-ui): " + err.message);
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(page
                .replace("/*__I18N__*/", () => i18n.clientScript())
                .replace("/*__UI__*/{}", () => JSON.stringify(sanitizeUi(readHelperConfig().ui))));
            return;
        }

        if (url.pathname === "/update-progress" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(updateJob));
            return;
        }

        if (url.pathname === "/cancel-update" && req.method === "POST") {
            let cancelled = false;
            try { cancelled = require("./update-check.js").cancelDownload(); } catch {}
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, cancelled }));
            return;
        }

        if (url.pathname === "/open-updater" && req.method === "POST") {
            const origin = `http://127.0.0.1:${server.address().port}`;
            openAppWindow(origin + "/updater", 680, 560, log);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (url.pathname === "/set-language" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
                try {
                    const parsed = JSON.parse(body || "{}");
                    const language = String(parsed.language || "");
                    if (!i18n.isValidPreference(language)) return reply(400, { ok: false, message: i18n.t("Unknown language.") });
                    const cfg = readHelperConfig();
                    cfg.language = language;
                    writeHelperConfig(cfg);
                    log(`Dashboard: language set to "${language}".`);
                    reply(200, { ok: true });
                } catch (err) {
                    reply(400, { ok: false, message: err.message });
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

        if (url.pathname === "/cancel-upload" && req.method === "POST") {
            try {
                fs.writeFileSync(UPLOAD_CANCEL_FILE, "1", "utf8");   // the engine picks this up within a second or two
                log("Dashboard: upload cancel requested.");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, message: err.message }));
            }
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
                    log(`Dashboard: license code redeemed - new tier "${result.tier}"${restartLogSuffix(restarted)}.`);
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
                    res.end(JSON.stringify({ ok: false, message: result.message || i18n.t("Could not remove that device.") }));
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
                    if (!actionName) throw new Error(i18n.t("Action name can't be empty."));
                    if (!label) throw new Error(i18n.t("Give this preset a name."));
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
                    if (!slot) throw new Error(i18n.t("That saved preset no longer exists."));
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
                    const info = await checkForUpdate(false); // cached - cheap to poll
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
                    const info = await checkForUpdate(true); // force - bypasses the 24h cache
                    log(`Dashboard: manual update check - ${info.hasUpdate ? `update available (${info.latestVersion})` : "up to date"}.`);
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
                    updateJob = { state: "downloading", received: 0, total: Number(info && info.installerAssetSize) || 0, startedAt: Date.now(), error: null };
                    const savedTo = await downloadAndRunInstaller(info, (received, total) => {
                        updateJob.received = received;
                        if (total) updateJob.total = total;
                    });
                    updateJob.state = "launched";
                    log(`Dashboard: downloaded update installer to ${savedTo} and launched it.`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, path: savedTo }));
                } catch (err) {
                    updateJob = { state: /cancel/i.test(err.message) ? "cancelled" : "error", received: updateJob.received, total: updateJob.total, startedAt: updateJob.startedAt, error: err.message };
                    log(`Dashboard: update install failed - ${err.message}`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
            })();
            return;
        }

        if (url.pathname === "/refresh-ps-status" && req.method === "POST") {
            refreshPsInstallStatus(log);
            // The check itself is async and this doesn't block on it - the
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
                    if (!plugin) throw new Error(i18n.t("Unknown plugin."));
                    if (!fs.existsSync(plugin.installer)) throw new Error(i18n.t("{plugin}: installer script not found next to the App folder.", { plugin: plugin.label }));
                    log(`Dashboard: launching ${plugin.label} installer at "${plugin.installer}".`);
                    spawnBatFile(plugin.installer, log, (ok, message) => {
                        if (ok && parsed.plugin === "ps") watchPsInstall(log);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: i18n.t("Windows refused to start it: {error}", { error: message }) }));
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
                    if (!plugin) throw new Error(i18n.t("Unknown plugin."));
                    if (!fs.existsSync(plugin.uninstaller)) throw new Error(i18n.t("{plugin}: uninstaller script not found next to the App folder.", { plugin: plugin.label }));
                    log(`Dashboard: launching ${plugin.label} uninstaller at "${plugin.uninstaller}".`);
                    spawnBatFile(plugin.uninstaller, log, (ok, message) => {
                        if (ok && parsed.plugin === "ps") watchPsInstall(log);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: i18n.t("Windows refused to start it: {error}", { error: message }) }));
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
                        throw new Error(i18n.t("That doesn't look like a Spidx Uploader backup file."));
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

        if (url.pathname === "/templates" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(buildTemplatesInfo()));
            return;
        }

        if (url.pathname === "/retry-failed" && req.method === "POST") {
            // the helper (another process) polls for this marker and sends the failed uploads again
            let ok = true;
            try { fs.mkdirSync(INCOMING, { recursive: true }); fs.writeFileSync(path.join(INCOMING, ".retry-failed-request"), String(Date.now())); } catch { ok = false; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok }));
            return;
        }

        if (url.pathname === "/pack-sync" && req.method === "POST") {
            // the helper (another process) polls for this marker and re-syncs the Pack content
            let ok = true;
            try { fs.mkdirSync(INCOMING, { recursive: true }); fs.writeFileSync(PACK_SYNC_REQUEST_FILE, String(Date.now())); } catch { ok = false; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok }));
            return;
        }

        if (url.pathname === "/templates/add-file" && req.method === "POST") {
            const name = String(url.searchParams.get("filename") || "");
            const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
            if (!packEntitledFromStatus(readEngineStatus())) return reply(403, { ok: false, message: i18n.t("Templates are part of the Thumbnail Pack.") });
            if (!TEMPLATE_AEP_RE.test(name)) return reply(400, { ok: false, message: i18n.t("Only .aep files with a simple name (letters, numbers, spaces, - _ .) can be added.") });
            const managed = new Set(Object.keys(packContent._readState().files).map(rel => path.basename(rel).toLowerCase()));
            if (managed.has(name.toLowerCase())) return reply(400, { ok: false, message: i18n.t("That name belongs to a Thumbnail Pack file. Rename your file.") });
            readBodyLimited(req, TEMPLATE_MAX_BYTES, (err, body) => {
                if (err) return reply(400, { ok: false, message: err.message });
                // an .aep is a RIFF container: refuse anything else instead of trusting the extension
                if (!body || body.length < 12 || body.slice(0, 4).toString("latin1") !== "RIFX") return reply(400, { ok: false, message: i18n.t("That does not look like an After Effects project (.aep).") });
                try {
                    const dir = path.join(packContent.packRoot(), "ae", "templates");
                    fs.mkdirSync(dir, { recursive: true });
                    const target = path.join(dir, name);
                    fs.writeFileSync(target + ".tmp", body);
                    fs.renameSync(target + ".tmp", target);
                    log(`Dashboard: template file "${name}" added (${body.length} bytes).`);
                    reply(200, { ok: true, name });
                } catch (e) {
                    reply(400, { ok: false, message: e.message });
                }
            });
            return;
        }

        if (url.pathname === "/templates/save" && req.method === "POST") {
            readBodyLimited(req, 256 * 1024, (err, body) => {
                const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
                if (err) return reply(400, { ok: false, message: err.message });
                if (!packEntitledFromStatus(readEngineStatus())) return reply(403, { ok: false, message: i18n.t("Templates are part of the Thumbnail Pack.") });
                try {
                    const parsed = JSON.parse(body.toString("utf8") || "{}");
                    const incoming = Array.isArray(parsed.items) ? parsed.items : null;
                    if (!incoming || incoming.length > 100) return reply(400, { ok: false, message: i18n.t("Invalid template list.") });
                    const list = [];
                    for (const t of incoming) {
                        if (t && t.source === "pack") continue;                    // the server's entries are not edited here
                        const file = String((t && t.file) || "");
                        const comp = String((t && t.comp) || "").trim().slice(0, 120);
                        const name = String((t && t.name) || "").trim().slice(0, 80) || comp;
                        const textLayer = String((t && t.textLayer) || "").trim().slice(0, 120);
                        if (!TEMPLATE_AEP_RE.test(file)) return reply(400, { ok: false, message: i18n.t("Invalid template file name.") });
                        if (!comp) return reply(400, { ok: false, message: i18n.t("Every template needs the name of its composition.") });
                        list.push({ file, comp, name, textLayer: textLayer || "NICK" });
                    }
                    packContent.saveUserTemplates(list);
                    reply(200, { ok: true, count: list.length });
                } catch (e) {
                    reply(400, { ok: false, message: e.message });
                }
            });
            return;
        }

        if (url.pathname === "/templates/delete-file" && req.method === "POST") {
            readBodyLimited(req, 4096, (err, body) => {
                const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
                if (err) return reply(400, { ok: false, message: err.message });
                try {
                    const file = String(JSON.parse(body.toString("utf8") || "{}").file || "");
                    if (!TEMPLATE_AEP_RE.test(file)) return reply(400, { ok: false, message: i18n.t("Invalid template file name.") });
                    const managed = new Set(Object.keys(packContent._readState().files).map(rel => path.basename(rel).toLowerCase()));
                    if (managed.has(file.toLowerCase())) return reply(400, { ok: false, message: i18n.t("That file belongs to the Thumbnail Pack and is managed automatically.") });
                    const dir = path.join(packContent.packRoot(), "ae", "templates");
                    const used = readJsonFile(path.join(dir, "templates.user.json"), []).some(t => t.file === file);
                    if (used) return reply(400, { ok: false, message: i18n.t("Remove the templates that use this file first.") });
                    try { fs.unlinkSync(path.join(dir, file)); } catch {}
                    reply(200, { ok: true });
                } catch (e) {
                    reply(400, { ok: false, message: e.message });
                }
            });
            return;
        }

        if (url.pathname === "/set-ui" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
                try {
                    const parsed = JSON.parse(body || "{}");
                    const cfg = readHelperConfig();
                    const cur = sanitizeUi(cfg.ui);
                    if (VALID_THEMES.includes(parsed.theme)) cur.theme = parsed.theme;
                    if (parsed.folds && typeof parsed.folds === "object") cur.folds = sanitizeUi({ folds: parsed.folds }).folds;
                    cfg.ui = cur;
                    writeHelperConfig(cfg);
                    reply(200, { ok: true });
                } catch (err) {
                    reply(400, { ok: false, message: err.message });
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
                log("Dashboard: logged out (Google sign-in + tier cache cleared) - restarting the app.");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, canQuit: !!quitAppFn }));
                // Respond first, then quit - the browser tab needs the response
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
        if (controls.page === "updater") {
            log(`Updater opened at ${url}updater`);
            openAppWindow(url + "updater", 680, 560, log);
        } else {
            log(`Dashboard opened at ${url}`);
            openInBrowser(url, log);
        }
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
