"use strict";

/* ========================================================================
 *  Diagnostics + self-test
 *
 *  runSelfTest()        -> a list of checks (ok / warn / fail / info) with a
 *                          plain-language reason for each, so "it doesn't
 *                          work" turns into "Node is fine, but the helper
 *                          isn't running because ...".
 *  buildDiagnostics()   -> one .zip with the self-test report, logs, versions
 *                          and settings - with emails, user names, tokens and
 *                          secrets removed - ready to send to support.
 *
 *  Never throws to the caller: every check is isolated, one broken check
 *  shows up as a failed check instead of breaking the whole report.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { spawnSync } = require("child_process");
const { writeZip } = require("./zip-util.js");

const APP_DIR = __dirname;
const ROOT_DIR = path.join(APP_DIR, "..");
const INCOMING_DIR = path.join(APP_DIR, "incoming");
const DIAG_DIR = path.join(APP_DIR, "diagnostics");
const LOG_FILE = path.join(APP_DIR, "helper.log");
const EVENTS_FILE = path.join(APP_DIR, "helper-events.jsonl");
const CONFIG_FILE = path.join(APP_DIR, "helper-config.json");
const GOOGLE_TOKEN_FILE = path.join(APP_DIR, "google-token.json");
const LICENSE_CACHE_FILE = path.join(APP_DIR, "license-cache.json");
const PID_FILE = path.join(APP_DIR, ".tray.pid");
const ENGINE_STATUS_FILE = path.join(INCOMING_DIR, ".engine-status.json");
const BATCH_STATUS_FILE = path.join(INCOMING_DIR, ".batch-status.json");
const CAMERA_RAW_FILE = path.join(INCOMING_DIR, ".default-camera-raw-preset.json");
const UPDATE_CACHE_FILE = path.join(APP_DIR, "update-cache.json");
const PLUGIN_UPDATE_CACHE_FILE = path.join(APP_DIR, "plugin-updates-cache.json");
const PACKAGE_FILE = path.join(APP_DIR, "package.json");
const STARTUP_LINK = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "SpidxUploaderHelper.vbs");
const CEP_EXTENSIONS_DIR = path.join(process.env.APPDATA || "", "Adobe", "CEP", "extensions");
const VEGAS_RECORD_FILE = path.join(process.env.APPDATA || "", "Spidx Uploader", "vegas-install.json");
const VEGAS_PANEL_CONFIG_FILE = path.join(process.env.APPDATA || "", "Spidx Uploader", "vegas-panel-config.json");

const ENGINE_STALE_MS = 2 * 60 * 1000;
const PID_STALE_MS = 30 * 1000;
const KEEP_DIAGNOSTIC_FILES = 5;

/* ---------------------------------------------------------------------- */
/*  small helpers                                                         */
/* ---------------------------------------------------------------------- */

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readText(file) {
    try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function tailText(file, maxBytes) {
    try {
        const stat = fs.statSync(file);
        const fd = fs.openSync(file, "r");
        try {
            const size = Math.min(stat.size, maxBytes);
            const buffer = Buffer.alloc(size);
            fs.readSync(fd, buffer, 0, size, stat.size - size);
            let text = buffer.toString("utf8");
            if (stat.size > maxBytes) text = "[... earlier part cut off ...]\n" + text.slice(text.indexOf("\n") + 1);
            return text;
        } finally { fs.closeSync(fd); }
    } catch { return null; }
}

function isProcessAlive(pid) {
    if (!pid || Number.isNaN(pid)) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function readManifestVersion(manifestPath) {
    const xml = readText(manifestPath);
    const m = xml && xml.match(/ExtensionBundleVersion\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
}

function appVersion() {
    const pkg = readJson(PACKAGE_FILE);
    return pkg && pkg.version ? pkg.version : "unknown";
}

function hostStatuses() {
    const ae = readManifestVersion(path.join(CEP_EXTENSIONS_DIR, "com.spidx.uploader.ae", "CSXS", "manifest.xml"));
    const ppro = readManifestVersion(path.join(CEP_EXTENSIONS_DIR, "com.spidx.uploader.ppro", "CSXS", "manifest.xml"));
    const record = readJson(VEGAS_RECORD_FILE);
    const vegasDlls = record && Array.isArray(record.dlls) ? record.dlls.filter(f => fs.existsSync(f)) : [];
    return {
        ae: { installedVersion: ae, bundledVersion: readManifestVersion(path.join(ROOT_DIR, "CEP-AE", "CSXS", "manifest.xml")) },
        ppro: { installedVersion: ppro, bundledVersion: readManifestVersion(path.join(ROOT_DIR, "CEP-PPRO", "CSXS", "manifest.xml")) },
        vegas: {
            installedVersion: vegasDlls.length ? (record.version || "unknown") : null,
            bundledVersion: (readText(path.join(ROOT_DIR, "VEGAS-Plugin", "version.txt")) || "").trim() || null,
            dlls: vegasDlls
        }
    };
}

/* ---------------------------------------------------------------------- */
/*  Redaction - nothing personal or secret goes into the zip              */
/* ---------------------------------------------------------------------- */

function redact(text) {
    if (text == null) return text;
    let out = String(text);
    // JSON-ish "key": "value" for anything that looks like a secret
    out = out.replace(/("(?:access_token|refresh_token|id_token|token|clientSecret|client_secret|password|secret|checkUrl|authorization)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"');
    out = out.replace(/GOCSPX-[\w-]+/g, "<redacted-secret>");
    out = out.replace(/ya29\.[\w.-]+/g, "<redacted-token>");
    out = out.replace(/\b1\/\/[\w-]{20,}/g, "<redacted-token>");
    out = out.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "<redacted-jwt>");
    out = out.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2");
    // user names inside paths (Windows and POSIX)
    out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, "$1<user>");
    out = out.replace(/(\/home\/)[^/\s"']+/g, "$1<user>");
    // Google Drive / share links and long ids
    out = out.replace(/https?:\/\/(?:drive|docs)\.google\.com\/[^\s"']+/g, "<google-drive-link>");
    return out;
}

/* ---------------------------------------------------------------------- */
/*  Self-test                                                             */
/* ---------------------------------------------------------------------- */

function check(id, label, status, detail) {
    return { id, label, status, detail: detail || "" };
}

function httpReachable(urlString, timeoutMs) {
    return new Promise(resolve => {
        let done = false;
        const finish = result => { if (!done) { done = true; resolve(result); } };
        try {
            const url = new URL(urlString);
            const lib = url.protocol === "http:" ? http : https;
            const req = lib.request({
                method: "HEAD", hostname: url.hostname, port: url.port || undefined, path: url.pathname || "/",
                headers: { "User-Agent": "spidx-uploader-selftest" }, timeout: timeoutMs
            }, res => { res.resume(); finish({ ok: true, status: res.statusCode }); });
            req.on("timeout", () => { req.destroy(); finish({ ok: false, error: "timed out" }); });
            req.on("error", err => finish({ ok: false, error: err.code || err.message }));
            req.end();
        } catch (err) {
            finish({ ok: false, error: err.message });
        }
    });
}

function cepDebugModeEnabled() {
    if (process.platform !== "win32") return null;
    for (const v of [9, 10, 11, 12, 13]) {
        try {
            const res = spawnSync("reg", ["query", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode"], { encoding: "utf8", windowsHide: true });
            if (/PlayerDebugMode\s+REG_SZ\s+1\b/i.test(res.stdout || "")) return true;
        } catch { /* try next */ }
    }
    return false;
}

const LOG_ERROR_PATTERN = /Uncaught error|Unhandled rejection|Helper exited \(code [1-9]|Failed to start helper|keeps crashing|Startup failed/;

async function runSelfTest() {
    const checks = [];
    const safe = (id, label, fn) => {
        try { checks.push(fn()); } catch (err) { checks.push(check(id, label, "fail", "Check crashed: " + err.message)); }
    };

    safe("node", "Node.js", () => {
        const major = parseInt(process.versions.node.split(".")[0], 10);
        return major >= 18
            ? check("node", "Node.js", "ok", "v" + process.versions.node)
            : check("node", "Node.js", "fail", "v" + process.versions.node + " is too old - install the current LTS from nodejs.org");
    });

    safe("deps", "Required packages", () => {
        const missing = [];
        const optional = [];
        for (const name of ["googleapis", "playwright"]) {
            try { require.resolve(name, { paths: [APP_DIR] }); } catch { missing.push(name); }
        }
        for (const name of ["sharp", "node-systray-v2"]) {
            try { require.resolve(name, { paths: [APP_DIR] }); } catch { optional.push(name); }
        }
        if (missing.length) return check("deps", "Required packages", "fail", "Missing: " + missing.join(", ") + " - run App\\start-tray.bat once with internet to install them");
        if (optional.length) return check("deps", "Required packages", "warn", "Missing optional: " + optional.join(", ") + (optional.includes("sharp") ? " (images won't be compressed)" : "") + (optional.includes("node-systray-v2") ? " (no tray icon)" : ""));
        return check("deps", "Required packages", "ok", "googleapis, playwright, sharp, tray support present");
    });

    safe("trayBinary", "Tray icon program", () => {
        if (process.platform !== "win32") return check("trayBinary", "Tray icon program", "info", "Windows only");
        const exe = path.join(APP_DIR, "node_modules", "node-systray-v2", "traybin", "tray_windows_release.exe");
        return fs.existsSync(exe)
            ? check("trayBinary", "Tray icon program", "ok", "tray_windows_release.exe present")
            : check("trayBinary", "Tray icon program", "warn", "tray_windows_release.exe is missing (antivirus quarantine?) - the helper still runs, just without a tray icon");
    });

    safe("tray", "Tray app", () => {
        let pid = null;
        let ageMs = Infinity;
        try { pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10); ageMs = Date.now() - fs.statSync(PID_FILE).mtimeMs; } catch {}
        if (pid && isProcessAlive(pid) && ageMs < PID_STALE_MS) return check("tray", "Tray app", "ok", "running (pid " + pid + ")");
        return check("tray", "Tray app", "warn", "not running (or its heartbeat is stale) - start it with Spidx Uploader.vbs");
    });

    safe("helper", "Upload helper (engine)", () => {
        const status = readJson(ENGINE_STATUS_FILE);
        if (!status || !status.updatedAt) return check("helper", "Upload helper (engine)", "fail", "no status file - the helper has never started or incoming\\ was cleared");
        const age = Date.now() - status.updatedAt;
        if (age > ENGINE_STALE_MS) return check("helper", "Upload helper (engine)", "fail", "last heartbeat " + Math.round(age / 60000) + " min ago - the helper is not running. Start Spidx Uploader.vbs");
        const parts = [status.engine || "engine", status.state ? "state: " + status.state : null, status.pid ? "pid " + status.pid : null].filter(Boolean);
        if (status.state === "error") return check("helper", "Upload helper (engine)", "fail", parts.join(", ") + (status.message ? " - " + status.message : ""));
        return check("helper", "Upload helper (engine)", "ok", parts.join(", "));
    });

    safe("incoming", "Incoming folder", () => {
        try {
            fs.mkdirSync(INCOMING_DIR, { recursive: true });
            const probe = path.join(INCOMING_DIR, ".selftest-" + process.pid);
            fs.writeFileSync(probe, "ok");
            fs.unlinkSync(probe);
            return check("incoming", "Incoming folder", "ok", "exists and is writable (" + redact(INCOMING_DIR) + ")");
        } catch (err) {
            return check("incoming", "Incoming folder", "fail", "cannot write to " + redact(INCOMING_DIR) + " - " + err.message);
        }
    });

    safe("config", "Settings file", () => {
        if (!fs.existsSync(CONFIG_FILE)) return check("config", "Settings file", "warn", "helper-config.json missing - defaults are used");
        const cfg = readJson(CONFIG_FILE);
        if (!cfg) return check("config", "Settings file", "fail", "helper-config.json is not valid JSON - restore a backup from the Dashboard or delete the file");
        return check("config", "Settings file", "ok", "destination: " + (cfg.destination || "workupload") + ", browser: " + (cfg.preferredBrowser || "auto"));
    });

    safe("google", "Google sign-in", () => fs.existsSync(GOOGLE_TOKEN_FILE)
        ? check("google", "Google sign-in", "ok", "signed in")
        : check("google", "Google sign-in", "warn", "not signed in - the helper opens your browser to sign in when it starts"));

    safe("license", "License / tier", () => {
        const cache = readJson(LICENSE_CACHE_FILE);
        if (!cache) return check("license", "License / tier", "info", "no tier checked yet (it is checked after Google sign-in)");
        const ageH = cache.checkedAt ? Math.round((Date.now() - cache.checkedAt) / 3600000) : null;
        return check("license", "License / tier", "ok", "tier: " + (cache.tier || "unknown") + (ageH != null ? " (checked " + ageH + " h ago)" : ""));
    });

    // network (async) - run in parallel
    const cfg = readJson(CONFIG_FILE) || {};
    const licenseUrl = cfg.license && cfg.license.checkUrl;
    const [licenseNet, githubNet, googleNet] = await Promise.all([
        licenseUrl ? httpReachable(licenseUrl, 6000) : Promise.resolve(null),
        httpReachable(process.env.SPIDX_GITHUB_API || "https://api.github.com", 6000),
        httpReachable("https://accounts.google.com", 6000)
    ]);
    const net = (id, label, result, what) => result
        ? (result.ok ? check(id, label, "ok", "reachable") : check(id, label, "fail", "cannot reach " + what + " (" + result.error + ") - check internet / firewall / VPN"))
        : check(id, label, "info", "not configured");
    checks.push(net("netLicense", "Internet: license server", licenseNet, "the license server"));
    checks.push(net("netGoogle", "Internet: Google sign-in", googleNet, "accounts.google.com"));
    checks.push(net("netGithub", "Internet: GitHub (updates)", githubNet, "api.github.com"));

    const hosts = hostStatuses();
    const hostLine = (label, h) => {
        if (!h.installedVersion) return "not installed";
        return "installed v" + h.installedVersion + (h.bundledVersion && h.bundledVersion !== h.installedVersion ? " (v" + h.bundledVersion + " available)" : "");
    };
    safe("hostAe", "After Effects panel", () => check("hostAe", "After Effects panel", "info", hostLine("AE", hosts.ae)));
    safe("hostPpro", "Premiere Pro panel", () => check("hostPpro", "Premiere Pro panel", "info", hostLine("PPro", hosts.ppro)));
    safe("hostVegas", "VEGAS Pro plugin", () => check("hostVegas", "VEGAS Pro plugin", "info", hostLine("VEGAS", hosts.vegas)));

    safe("cepDebug", "Adobe panels allowed (PlayerDebugMode)", () => {
        if (!hosts.ae.installedVersion && !hosts.ppro.installedVersion) return check("cepDebug", "Adobe panels allowed (PlayerDebugMode)", "info", "no Adobe panel installed");
        const enabled = cepDebugModeEnabled();
        if (enabled === null) return check("cepDebug", "Adobe panels allowed (PlayerDebugMode)", "info", "Windows only");
        return enabled
            ? check("cepDebug", "Adobe panels allowed (PlayerDebugMode)", "ok", "enabled")
            : check("cepDebug", "Adobe panels allowed (PlayerDebugMode)", "warn", "off - unsigned Adobe panels won't show up; reinstall the AE/PPro panel from the Dashboard");
    });

    safe("logErrors", "Recent errors in the log", () => {
        const text = tailText(LOG_FILE, 300 * 1024);
        if (!text) return check("logErrors", "Recent errors in the log", "info", "no log yet");
        const lines = text.split(/\r?\n/).filter(l => LOG_ERROR_PATTERN.test(l));
        if (!lines.length) return check("logErrors", "Recent errors in the log", "ok", "none in the last part of helper.log");
        return check("logErrors", "Recent errors in the log", "warn", lines.length + " error line(s); last: " + redact(lines[lines.length - 1]).slice(0, 220));
    });

    safe("autostart", "Start with Windows", () => check("autostart", "Start with Windows", "info", fs.existsSync(STARTUP_LINK) ? "on" : "off"));

    const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
    return { generatedAt: new Date().toISOString(), appVersion: appVersion(), checks, summary };
}

function formatReport(result) {
    const icon = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]", info: "[ .. ]" };
    const lines = [
        "Spidx Uploader - self-test",
        "Generated: " + result.generatedAt + "   App version: " + result.appVersion,
        "Result: " + result.summary.ok + " ok, " + result.summary.warn + " warning(s), " + result.summary.fail + " failed",
        ""
    ];
    for (const c of result.checks) lines.push(`${icon[c.status] || "[ ?? ]"} ${c.label}${c.detail ? " - " + c.detail : ""}`);
    return lines.join("\n") + "\n";
}

/* ---------------------------------------------------------------------- */
/*  Diagnostics zip                                                       */
/* ---------------------------------------------------------------------- */

function sanitizeConfig(cfg) {
    if (!cfg) return null;
    const copy = JSON.parse(JSON.stringify(cfg));
    if (copy.drive) { delete copy.drive.clientSecret; if (copy.drive.clientId) copy.drive.clientId = "<set>"; }
    if (copy.license && copy.license.checkUrl) copy.license.checkUrl = "<set>";
    return copy;
}

function timestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pruneOldDiagnostics() {
    try {
        const files = fs.readdirSync(DIAG_DIR).filter(f => /^spidx-diagnostics-.*\.zip$/.test(f)).sort();
        while (files.length > KEEP_DIAGNOSTIC_FILES) fs.unlinkSync(path.join(DIAG_DIR, files.shift()));
    } catch { /* not important */ }
}

async function buildDiagnostics(log = () => {}) {
    try {
        const entries = [];
        const add = (name, text) => { if (text != null) entries.push({ name, data: String(text) }); };

        const selfTest = await runSelfTest();
        add("self-test.txt", formatReport(selfTest));

        const hosts = hostStatuses();
        const licenseCache = readJson(LICENSE_CACHE_FILE);
        add("versions.json", JSON.stringify({
            generatedAt: selfTest.generatedAt,
            appVersion: appVersion(),
            node: process.version,
            platform: `${os.platform()} ${os.release()} ${os.arch()}`,
            totalMemoryMB: Math.round(os.totalmem() / 1048576),
            plugins: hosts,
            tier: licenseCache ? { tier: licenseCache.tier || null, trialDaysRemaining: licenseCache.trialDaysRemaining ?? null, checkedAt: licenseCache.checkedAt || null } : null,
            updateCache: readJson(UPDATE_CACHE_FILE),
            pluginUpdateCache: readJson(PLUGIN_UPDATE_CACHE_FILE)
        }, null, 2));

        add("helper.log", redact(tailText(LOG_FILE, 600 * 1024)));
        add("helper-events.jsonl", redact(tailText(EVENTS_FILE, 200 * 1024)));
        add("helper-config.json", redact(JSON.stringify(sanitizeConfig(readJson(CONFIG_FILE)), null, 2)));
        add("engine-status.json", redact(readText(ENGINE_STATUS_FILE)));
        add("batch-status.json", redact(readText(BATCH_STATUS_FILE)));
        add("camera-raw-preset.json", redact(readText(CAMERA_RAW_FILE)));
        add("vegas-install.json", redact(readText(VEGAS_RECORD_FILE)));
        add("vegas-panel-config.json", redact(readText(VEGAS_PANEL_CONFIG_FILE)));
        add("README.txt",
            "Spidx Uploader diagnostics\n\n" +
            "Created: " + selfTest.generatedAt + "\n" +
            "Emails, user names in paths, tokens, secrets and Drive links are removed.\n" +
            "No sign-in tokens, uploaded files or upload links are included.\n" +
            "Send this .zip to support.\n");

        fs.mkdirSync(DIAG_DIR, { recursive: true });
        const file = path.join(DIAG_DIR, `spidx-diagnostics-${timestamp()}.zip`);
        const bytes = writeZip(file, entries);
        pruneOldDiagnostics();
        log(`Diagnostics written: ${file} (${bytes} bytes, ${entries.length} files).`);
        return { ok: true, path: file, bytes, files: entries.map(e => e.name), summary: selfTest.summary };
    } catch (err) {
        log(`Could not create diagnostics: ${err.message}`);
        return { ok: false, message: err.message };
    }
}

module.exports = { runSelfTest, formatReport, buildDiagnostics, redact, DIAG_DIR };
