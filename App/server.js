"use strict";

/* ========================================================================
 *  SPIDX ENGINE 2.5
 *  The helper backend behind both panels (Photoshop UXP, After Effects
 *  CEP). What changed from Spider Engine 2:
 *
 *   - Heartbeat: .engine-status.json is rewritten every 15s with a
 *     "state" field, not only when something happens. The panels use its
 *     age to tell "helper is running and idle" apart from "helper is not
 *     running at all", which they previously could not do — a stale
 *     status file looked exactly like a healthy one.
 *   - Bounded memory: the "processed" set is capped (it used to grow by
 *     one filename per upload, forever, for the lifetime of the process
 *     AND across restarts through helper-state.json).
 *   - It no longer exits on a failed startup. A failed Google sign-in or
 *     a browser that won't launch now writes an error into the status
 *     file, tells the panels about it, and retries — instead of killing
 *     the process and leaving the tray reporting "Helper exited".
 * ==================================================================== */

const fs   = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { Worker } = require("worker_threads");
const photoshopBridge = require("./photoshop-bridge");

const APP_DIR      = __dirname;
const INCOMING     = path.join(APP_DIR, "incoming");
const PROFILE_DIR  = path.join(APP_DIR, "browser-profile");
const STATE_FILE   = path.join(APP_DIR, "helper-state.json");
const CONFIG_FILE  = path.join(APP_DIR, "helper-config.json");
const EVENTS_FILE  = path.join(APP_DIR, "helper-events.jsonl");
const QUEUE_FILE   = path.join(APP_DIR, "queue.json");
const LAST_UPLOAD  = path.join(APP_DIR, "last-upload.json");
const BATCH_CONFIG_FILE     = path.join(INCOMING, ".batch-config.json");
const BATCH_STATUS_FILE     = path.join(INCOMING, ".batch-status.json");
const BATCH_FORCE_SEND      = path.join(INCOMING, ".batch-force-send");
// A panel / the Dashboard / the global shortcut asks the running helper to switch client preset by dropping
// {"id":..,"name":..} here; the answer ({"id","ok","message"}) comes back in the result file.
const PRESET_REQUEST_FILE   = path.join(INCOMING, ".preset-request.json");
const PRESET_RESULT_FILE    = path.join(INCOMING, ".preset-result.json");
const BATCH_CANCEL          = path.join(INCOMING, ".batch-cancel");
const ENGINE_STATUS_FILE    = path.join(INCOMING, ".engine-status.json");
const DEFAULT_PRESET_FILE   = path.join(INCOMING, ".default-camera-raw-preset.json");
const COMPRESS_WORKER_FILE  = path.join(APP_DIR, "compress-worker.js");

const WORKUPLOAD_URL   = "https://workupload.com/";
const POLL_MS          = 5000;
const MAX_BATCH_SIZE   = 10;
const MAX_EVENTS_BYTES = 5 * 1024 * 1024;
const DAY_MS           = 24 * 60 * 60 * 1000;
const ENGINE_NAME      = "Spidx Engine 2.5";
const ENGINE_VERSION   = "2.5.0";

// How often the engine re-stamps .engine-status.json, and the window the
// panels use to decide it's alive. The panels treat anything older than
// ~2 minutes as "helper not running", so the heartbeat has to be
// comfortably shorter than that even if a few writes get skipped while
// the process is busy uploading.
const HEARTBEAT_MS     = 15 * 1000;

// Upper bound on remembered filenames. Each entry only exists to stop the
// same file being uploaded twice; 500 is far more than any realistic
// backlog, and the oldest entries can't matter because the files
// themselves are long gone (auto-cleanup removes them after N days).
const MAX_PROCESSED    = 500;

const DRIVE_TIERS       = new Set(["pro", "dev", "tester"]);
const { decideIncoming } = require("./file-rules.js");
const uploadHistory = require("./history.js");
const presetStore = require("./presets.js");

// What we know about a file that is on its way to being uploaded (by its final
// name): which plugin it came from and whether it went through Photoshop. Only
// used to label the upload-history entry.
const fileMeta = new Map();

const MULTI_BATCH_TIERS = new Set(["pro", "dev", "tester"]);
// Same tier set gates the Camera Raw preset route ("Photoshop + Upload")
// as the real enforcement point, independent of whatever the Dashboard
// has saved in config — mirrors how Drive silently falls back below.
const PRO_FEATURE_TIERS = new Set(["pro", "dev", "tester"]);
function tierAllowsDrive(tier)  { return DRIVE_TIERS.has(tier); }
function tierMaxBatch(tier)     { return MULTI_BATCH_TIERS.has(tier) ? MAX_BATCH_SIZE : 1; }
function tierAllowsProFeatures(tier) { return PRO_FEATURE_TIERS.has(tier); }

let browser       = null;
let page          = null;
let playwright    = null;
let browserLaunching = null;
let uploading     = false;
let config        = null;
let currentTier   = "free";   // the RANK (free / pro / tester / dev) - what Drive, batches, PS route check
let lastRejection = null;     // { time, file, reason } of the last file the engine refused (shown to the panels)
let currentRoles  = ["free"]; // every role, e.g. ["pro", "spt"] - "spt" is an add-on read by the Premiere panel
let currentDeviceLimitReached = false;
let currentTrialDaysRemaining = null;
let idleCloseTimer = null;
let scanDebounce  = null;
let currentBatch  = null;
let engineState   = "starting"; // "starting" | "ready" | "error"
let engineMessage = null;       // human-readable reason when state is "error"
let heartbeatTimer = null;

// A Set preserves insertion order, so trimming = dropping from the front.
const processed = new Set();

function rememberProcessed(name) {
    processed.add(name);
    if (processed.size > MAX_PROCESSED) {
        const excess = processed.size - MAX_PROCESSED;
        let dropped = 0;
        for (const oldest of processed) {
            processed.delete(oldest);
            if (++dropped >= excess) break;
        }
    }
}
const pending   = new Set();
const queue     = [];

function log(...args) { console.log("[SE2.5]", ...args); }

function logEvent(step, status, extra = {}) {
    const entry = { ts: new Date().toISOString(), step, status, ...extra };
    try {
        if (fs.existsSync(EVENTS_FILE) && fs.statSync(EVENTS_FILE).size > MAX_EVENTS_BYTES) fs.writeFileSync(EVENTS_FILE, "");
        fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch {}
    return entry;
}

async function timedStep(step, extra, fn) {
    const t = Date.now();
    logEvent(step, "start", extra);
    try {
        const r = await fn();
        logEvent(step, "ok", { ...extra, durationMs: Date.now() - t });
        return r;
    } catch (err) {
        logEvent(step, "fail", { ...extra, durationMs: Date.now() - t, message: err && err.message });
        throw err;
    }
}

function ensureDirs() {
    fs.mkdirSync(INCOMING, { recursive: true });
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

// Mirrors whatever the dashboard last saved into helper-config.json's
// "cameraRawPreset" (a Photoshop Action Set/Action name — see dashboard.js)
// into the shared incoming folder, so the UXP panel, which can't read
// helper-config.json directly but already reads/writes other small state
// files in this same folder, can pick it up. The dashboard is the only
// place this gets set; the panel just mirrors it (syncPresetFromDashboard
// in index.js) and can be toggled on/off locally, but not changed there.
function syncDefaultCameraRawPreset() {
    try {
        const preset = config.cameraRawPreset;
        if (preset && typeof preset.actionName === "string" && preset.actionName.trim()) {
            fs.writeFileSync(DEFAULT_PRESET_FILE, JSON.stringify({
                actionSet: String(preset.actionSet || "").slice(0, 200),
                actionName: String(preset.actionName).slice(0, 200)
            }), "utf8");
        } else if (fs.existsSync(DEFAULT_PRESET_FILE)) {
            fs.unlinkSync(DEFAULT_PRESET_FILE);
        }
    } catch (err) {
        log(`Could not sync the default Camera Raw preset: ${err.message}`);
    }
}

function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        for (const f of (s.processed || []).slice(-MAX_PROCESSED)) processed.add(f);
    } catch {}
}

function saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ processed: [...processed].slice(-MAX_PROCESSED) }, null, 2), "utf8"); } catch {}
}

const VALID_BROWSERS     = ["auto","chrome","edge","brave","firefox","opera","opera-gx"];
const VALID_DESTINATIONS = ["workupload","drive"];

const DEFAULT_CONFIG = {
    destination: "workupload",
    drive:    { clientId: "", clientSecret: "", folderName: "Spidx Uploads" },
    license:  { checkUrl: "https://script.google.com/macros/s/AKfycbxU14FWyrOLfUlJCMq5vCqW1KFgqNVkHV7fqxhKnlZqQ_mGdV90m8penwmVZI7aOMuo/exec" },
    preferredBrowser: "auto",
    autoRetry:   { enabled: true, maxAttempts: 3, delaySeconds: 10 },
    notifications: { enabled: true },
    cleanup:     { enabled: true, afterDays: 7 },
    browserIdle: { enabled: true, timeoutSeconds: 120 },
    batch:       { timeoutSeconds: 120 },
    throttle:    { enabled: false, minMs: 500, maxMs: 2000 },
    compression: { enabled: true, targetMB: 1.5 }, // image size the helper aims for; a client preset can change it
    activePreset: null,   // name of the last applied client preset (the presets themselves live in helper-config.json and are read by presets.js)
    cameraRawPreset: null, // { actionSet, actionName } — set by the dashboard, mirrored to the incoming folder for the UXP panel; see syncDefaultCameraRawPreset()
    dashboardTourSeen: false // set once by the Dashboard's first-run tour (POST /mark-tour-seen) — whitelisted here too, or loadConfig()'s own rewrite below would silently drop it on the very next helper restart
};

function loadConfig() {
    const d = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    try {
        const r = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        if (VALID_DESTINATIONS.includes(r.destination)) d.destination = r.destination;
        if (r.drive && typeof r.drive === "object") {
            if (typeof r.drive.clientId     === "string") d.drive.clientId     = r.drive.clientId;
            if (typeof r.drive.clientSecret === "string") d.drive.clientSecret = r.drive.clientSecret;
            if (typeof r.drive.folderName   === "string" && r.drive.folderName.trim()) d.drive.folderName = r.drive.folderName.trim();
        }
        if (r.license && typeof r.license.checkUrl === "string") d.license.checkUrl = r.license.checkUrl.trim();
        if (VALID_BROWSERS.includes(r.preferredBrowser)) d.preferredBrowser = r.preferredBrowser;
        if (r.autoRetry) {
            if (typeof r.autoRetry.enabled === "boolean") d.autoRetry.enabled = r.autoRetry.enabled;
            if (Number.isFinite(r.autoRetry.maxAttempts)) d.autoRetry.maxAttempts = Math.max(1, Math.floor(r.autoRetry.maxAttempts));
            if (Number.isFinite(r.autoRetry.delaySeconds)) d.autoRetry.delaySeconds = Math.max(0, r.autoRetry.delaySeconds);
        }
        if (r.notifications && typeof r.notifications.enabled === "boolean") d.notifications.enabled = r.notifications.enabled;
        if (r.cleanup) {
            if (typeof r.cleanup.enabled === "boolean") d.cleanup.enabled = r.cleanup.enabled;
            if (Number.isFinite(r.cleanup.afterDays)) d.cleanup.afterDays = Math.max(1, Math.floor(r.cleanup.afterDays));
        }
        if (r.browserIdle) {
            if (typeof r.browserIdle.enabled === "boolean") d.browserIdle.enabled = r.browserIdle.enabled;
            if (Number.isFinite(r.browserIdle.timeoutSeconds)) d.browserIdle.timeoutSeconds = Math.max(30, r.browserIdle.timeoutSeconds);
        }
        if (r.batch && Number.isFinite(r.batch.timeoutSeconds)) d.batch.timeoutSeconds = Math.max(10, r.batch.timeoutSeconds);
        if (r.throttle) {
            if (typeof r.throttle.enabled === "boolean") d.throttle.enabled = r.throttle.enabled;
            if (Number.isFinite(r.throttle.minMs)) d.throttle.minMs = Math.max(0, r.throttle.minMs);
            if (Number.isFinite(r.throttle.maxMs)) d.throttle.maxMs = Math.max(0, r.throttle.maxMs);
        }
        d.compression = presetStore.sanitizeCompression(r.compression);
        if (typeof r.activePreset === "string" && r.activePreset.trim()) d.activePreset = r.activePreset.trim().slice(0, 60);
        if (r.cameraRawPreset && typeof r.cameraRawPreset === "object" && typeof r.cameraRawPreset.actionName === "string" && r.cameraRawPreset.actionName.trim()) {
            d.cameraRawPreset = { actionSet: String(r.cameraRawPreset.actionSet || "").slice(0, 200), actionName: String(r.cameraRawPreset.actionName).slice(0, 200) };
        }
    } catch {
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2), "utf8"); } catch {}
    }
    return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapePS(text) {
    return String(text).replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

function runCmd(cmd, args, stdinText) {
    return new Promise(resolve => {
        try {
            const proc = spawn(cmd, args, { windowsHide: true });
            let done = false;
            const finish = ok => { if (!done) { done = true; resolve(ok); } };
            proc.on("error", () => finish(false));
            if (stdinText !== undefined) {
                proc.stdin.on("error", () => finish(false));
                proc.stdin.write(stdinText, "utf8");
                proc.stdin.end();
            } else {
                proc.stdin.end();
            }
            proc.on("close", code => finish(code === 0));
        } catch { resolve(false); }
    });
}

function copyToClipboard(text) {
    const e = escapePS(text);
    return runCmd("clip", [], text)
        .then(ok => ok || runCmd("powershell", ["-NoProfile","-NonInteractive","-Command",`Set-Clipboard -Value "${e}"`]))
        .then(ok => ok || runCmd("powershell", ["-NoProfile","-NonInteractive","-Command",
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("${e}")`]));
}

function showNotification(title, message) {
    if (!config || !config.notifications || !config.notifications.enabled) return;
    const t = escapePS(title), m = escapePS(message);
    const script =
        `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;` +
        `$xml=New-Object Windows.Data.Xml.Dom.XmlDocument;` +
        `$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>${t}</text><text>${m}</text></binding></visual></toast>");` +
        `$toast=New-Object Windows.UI.Notifications.ToastNotification $xml;` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Spidx Uploader').Show($toast)`;
    try {
        const p = spawn("powershell",["-NoProfile","-NonInteractive","-WindowStyle","Hidden","-Command",script],{windowsHide:true});
        p.on("error",()=>{});
    } catch {}
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) { reject(err); return; }
            resolve({ stdout, stderr });
        });
    });
}

function saveLastUpload(links, fileNames) {
    try { fs.writeFileSync(LAST_UPLOAD, JSON.stringify({ links, fileNames, savedAt: Date.now() }, null, 2), "utf8"); } catch {}
}

function writeBatchStatus(status) {
    try { fs.writeFileSync(BATCH_STATUS_FILE, JSON.stringify({ ...status, updatedAt: Date.now() }), "utf8"); } catch {}
}

function presetNames() {
    try { return presetStore.loadPresetsCached(CONFIG_FILE).presets.map(p => p.name); } catch { return []; }
}

// "Preset X (modified)": the helper's current settings no longer equal the active preset
function activePresetIsModified() {
    try {
        if (!config || !config.activePreset) return false;
        const preset = presetStore.loadPresetsCached(CONFIG_FILE).presets.find(p => p.name === config.activePreset);
        return preset ? !presetStore.matchesConfig(preset, config) : false;
    } catch { return false; }
}

function writeEngineStatus() {
    try {
        fs.mkdirSync(INCOMING, { recursive: true });
        fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify({
            engine: ENGINE_NAME,
            engineVersion: ENGINE_VERSION,
            pid: process.pid,
            state: engineState,
            message: engineMessage,
            destination: config ? config.destination : null,
            tier: currentTier,
            roles: currentRoles,
            lastRejection,
            presets: presetNames(),
            activePreset: config ? (config.activePreset || null) : null,
            activePresetModified: activePresetIsModified(),
            deviceLimitReached: currentDeviceLimitReached,
            trialDaysRemaining: currentTrialDaysRemaining,
            updatedAt: Date.now()
        }), "utf8");
    } catch {}
}

function setEngineState(state, message = null) {
    engineState = state;
    engineMessage = message;
    writeEngineStatus();
}

// The heartbeat is what lets a panel say "helper not running" honestly.
// Without it, .engine-status.json was only rewritten on tier/destination
// changes, so a file written three days ago by a process that has since
// died was indistinguishable from a healthy idle engine.
function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(writeEngineStatus, HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

/* ---------------------------------------------------------------------- */
/*  Persistent queue                                                      */
/* ---------------------------------------------------------------------- */

function loadQueue() {
    try {
        const saved = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
        if (Array.isArray(saved)) {
            for (const entry of saved) queue.push(entry);
            if (queue.length > 0) log(`Restored ${queue.length} pending batch(es) from the previous session.`);
        }
    } catch {}
}

function persistQueue() {
    try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue), "utf8"); } catch {}
}

/* ---------------------------------------------------------------------- */
/*  Worker Threads compression                                           */
/* ---------------------------------------------------------------------- */

function compressInWorker(filePath) {
    const compression = presetStore.sanitizeCompression(config && config.compression);
    return new Promise((resolve, reject) => {
        const worker = new Worker(COMPRESS_WORKER_FILE);
        worker.on("message", result => {
            worker.terminate();
            if (result.ok) resolve(result);
            else reject(new Error(result.message || "Compression failed in worker."));
        });
        worker.on("error", err => { worker.terminate(); reject(err); });
        worker.postMessage({ filePath, options: { enabled: compression.enabled, targetBytes: Math.round(compression.targetMB * 1024 * 1024) } });
    });
}

/* ---------------------------------------------------------------------- */
/*  Browser detection + launch                                           */
/* ---------------------------------------------------------------------- */

function extractExeFromCommandLine(stdout) {
    const match = stdout.match(/REG_SZ\s+(.+)/i);
    if (!match) return null;
    let raw = match[1].trim();
    if (raw.startsWith('"')) {
        const end = raw.indexOf('"', 1);
        if (end > 0) return raw.slice(1, end);
    }
    const spaceIdx = raw.search(/\s+-/);
    return (spaceIdx > 0 ? raw.slice(0, spaceIdx) : raw).trim();
}

async function readDefaultProgId() {
    try {
        const r = await run("reg", ["QUERY","HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice","/v","ProgId"]);
        const m = r.stdout.match(/ProgId\s+REG_SZ\s+(.+)/i);
        return m ? m[1].trim() : null;
    } catch { return null; }
}

async function readCommandForProgId(progId) {
    try {
        const r = await run("reg", ["QUERY", `HKCR\\${progId}\\shell\\open\\command`, "/ve"]);
        return extractExeFromCommandLine(r.stdout);
    } catch { return null; }
}

async function readFallbackHttpCommand() {
    try {
        const r = await run("reg", ["QUERY","HKCR\\http\\shell\\open\\command","/ve"]);
        return extractExeFromCommandLine(r.stdout);
    } catch { return null; }
}

function classifyBrowser(progId, exePath) {
    const hay = `${progId || ""} ${exePath || ""}`.toLowerCase();
    if (hay.includes("operagx") || hay.includes("opera gx")) return "opera-gx";
    if (hay.includes("opera"))  return "opera";
    if (hay.includes("brave"))  return "brave";
    if (hay.includes("firefox")) return "firefox";
    if (hay.includes("msedge") || hay.includes("edge")) return "edge";
    if (hay.includes("chrome")) return "chrome";
    return "unknown";
}

async function getDefaultBrowserInfo() {
    const progId = await readDefaultProgId();
    let exePath = progId ? await readCommandForProgId(progId) : null;
    if (!exePath) exePath = await readFallbackHttpCommand();
    return { name: classifyBrowser(progId, exePath), exePath: exePath && fs.existsSync(exePath) ? exePath : null };
}

function browserCandidates(name) {
    const local = process.env.LOCALAPPDATA || "";
    const pf  = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return ({
        chrome:     [path.join(pf,"Google\\Chrome\\Application\\chrome.exe"), path.join(pf86,"Google\\Chrome\\Application\\chrome.exe"), path.join(local,"Google\\Chrome\\Application\\chrome.exe")],
        edge:       [path.join(pf,"Microsoft\\Edge\\Application\\msedge.exe"), path.join(pf86,"Microsoft\\Edge\\Application\\msedge.exe")],
        brave:      [path.join(pf,"BraveSoftware\\Brave-Browser\\Application\\brave.exe"), path.join(pf86,"BraveSoftware\\Brave-Browser\\Application\\brave.exe"), path.join(local,"BraveSoftware\\Brave-Browser\\Application\\brave.exe")],
        firefox:    [path.join(pf,"Mozilla Firefox\\firefox.exe"), path.join(pf86,"Mozilla Firefox\\firefox.exe")],
        opera:      [path.join(local,"Programs\\Opera\\opera.exe"), path.join(pf,"Opera\\opera.exe")],
        "opera-gx": [path.join(local,"Programs\\Opera GX\\opera.exe"), path.join(pf,"Opera GX\\opera.exe")]
    })[name] || [];
}

function findExecutable(name, exePathHint) {
    if (exePathHint && fs.existsSync(exePathHint)) return exePathHint;
    for (const c of browserCandidates(name)) if (fs.existsSync(c)) return c;
    return null;
}

async function ensurePlaywright() {
    if (playwright) return playwright;
    try { playwright = require("playwright"); } catch {
        throw new Error("Playwright is missing. Run: npm install playwright && npx playwright install chromium firefox");
    }
    return playwright;
}

async function resolveBrowserChoice() {
    let browserName, exePath = null;
    if (config.preferredBrowser && config.preferredBrowser !== "auto") {
        browserName = config.preferredBrowser;
        try {
            const det = await getDefaultBrowserInfo();
            if (det.name === browserName && det.exePath) exePath = det.exePath;
        } catch {}
    } else {
        const det = await getDefaultBrowserInfo();
        browserName = det.name;
        exePath = det.exePath;
        if (browserName === "unknown") {
            log("Default browser not detected — falling back to Edge.");
            log('Tip: set "preferredBrowser" in helper-config.json, e.g. "preferredBrowser": "opera-gx"');
        }
    }
    return { browserName: browserName === "unknown" ? "edge" : browserName, exePath };
}

async function launchBrowser(browserName, exePathHint) {
    const pw = await ensurePlaywright();
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    if (browserName === "firefox") {
        const ctx = await pw.firefox.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
        wireUpContext(ctx);
        return ctx;
    }

    const executablePath = findExecutable(browserName, exePathHint);
    if (!executablePath) throw new Error(`Could not find an executable for ${browserName}.`);

    log(`Launching ${browserName}: ${executablePath}`);
    const ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false, executablePath,
        args: ["--disable-features=Translate","--no-first-run"],
        viewport: null
    });
    wireUpContext(ctx);
    return ctx;
}

function wireUpContext(ctx) {
    page = ctx.pages()[0] || null;
    ctx.on("page", p => { page = p; });
    ctx.on("close", () => { browser = null; page = null; });
    const autoAccept = pg => pg.on("dialog", async d => { try { await d.accept(); } catch {} });
    ctx.pages().forEach(autoAccept);
    ctx.on("page", autoAccept);
}

function isBrowserAlive() {
    return !!(browser && typeof browser.isClosed === "function" ? !browser.isClosed() : !!browser);
}

async function ensureBrowser() {
    if (isBrowserAlive()) {
        const pages = browser.pages();
        if (!page || page.isClosed()) page = pages[0] || await browser.newPage();
        return page;
    }
    if (browserLaunching) return browserLaunching;
    browserLaunching = (async () => {
        const { browserName, exePath } = await resolveBrowserChoice();
        const ctx = await timedStep("launch_browser", { browser: browserName }, () => launchBrowser(browserName, exePath));
        browser = ctx;
        if (!page) page = ctx.pages()[0] || await ctx.newPage();
        return page;
    })();
    try { return await browserLaunching; } finally { browserLaunching = null; }
}

function clearIdleClose() {
    if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; }
}

function scheduleIdleClose() {
    clearIdleClose();
    if (!config || !config.browserIdle || !config.browserIdle.enabled) return;
    idleCloseTimer = setTimeout(async () => {
        if (isBrowserAlive()) {
            try { await browser.close(); } catch {}
        }
    }, config.browserIdle.timeoutSeconds * 1000);
}

async function warmUpBrowser() {
    try {
        const p = await ensureBrowser();
        await timedStep("warm_up_navigate", {}, () => p.goto(WORKUPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 30000 }));
        log("Browser is up and WorkUpload is loaded — ready for uploads.");
    } catch (err) {
        log("Could not warm up the browser at startup:", err.message);
    }
}

async function openWorkUpload() {
    const p = await ensureBrowser();
    if (!p.url().startsWith("https://workupload.com")) {
        await p.goto(WORKUPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    return p;
}

/* ---------------------------------------------------------------------- */
/*  Selector fallback chains                                             */
/* ---------------------------------------------------------------------- */

const FILE_INPUT_SELECTORS = [
    '[data-testid="file-input"]',
    'input[type="file"][aria-label]',
    'input[type="file"]'
];

const SAVE_FILE_SELECTORS = [
    '[data-testid="save-now"]',
    'button:has-text("Save now!")',
    'button:has-text("Save now")',
    '[role="button"]:has-text("Save now")',
    'button:has-text("Save file")',
    'text=/save now/i',
    'text=/save file/i'
];

async function findFirstMatch(p, selectors) {
    for (const s of selectors) {
        try { const l = p.locator(s).first(); if (await l.count() > 0) return l; } catch {}
    }
    return null;
}

async function findVisibleMatch(p, selectors) {
    for (const s of selectors) {
        try {
            const l = p.locator(s).first();
            if (await l.count() === 0) continue;
            if (await l.isVisible()) return l;
        } catch {}
    }
    return null;
}

async function waitForFileInput(p, timeoutMs = 120000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const input = await findFirstMatch(p, FILE_INPUT_SELECTORS);
        if (input) return input;
        await sleep(1000);
    }
    return null;
}

async function clickSaveFile(p, timeoutMs = 120000) {
    const started = Date.now();
    let attempts = 0;
    while (Date.now() - started < timeoutMs) {
        const btn = await findVisibleMatch(p, SAVE_FILE_SELECTORS);
        if (!btn) { await sleep(500); continue; }
        try {
            if (await btn.isDisabled().catch(() => false)) { await sleep(500); continue; }
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await btn.click({ timeout: 5000 });
            attempts++;
            await sleep(1500);
            const still = await findVisibleMatch(p, SAVE_FILE_SELECTORS);
            if (!still || await still.isDisabled().catch(() => false)) return true;
        } catch { await sleep(500); }
    }
    return attempts > 0;
}

async function waitForShareLink(p, timeoutMs = 20000) {
    const started = Date.now();
    const re = /https?:\/\/(www\.)?workupload\.com\/[a-zA-Z0-9\/_-]+/;
    while (Date.now() - started < timeoutMs) {
        try {
            const els = await p.locator('a[href*="workupload.com"],input[value*="workupload.com"],textarea:has-text("workupload.com")').all();
            for (const el of els) {
                const href = await el.getAttribute("href").catch(() => null);
                const value = await el.inputValue().catch(() => null);
                const text = href || value || await el.textContent().catch(() => null);
                if (text) { const m = text.match(re); if (m) return m[0]; }
            }
        } catch {}
        await sleep(1000);
    }
    return null;
}

/* ---------------------------------------------------------------------- */
/*  Failure reasons + retry strategy                                     */
/* ---------------------------------------------------------------------- */

const FAILURE_REASON = {
    SECURITY_CHECK:       "security_check",
    SAVE_BUTTON_NOT_FOUND:"save_button_not_found",
    NAVIGATION:           "navigation",
    DRIVE_AUTH:           "drive_auth",
    DRIVE_QUOTA:          "drive_quota",
    DRIVE_NETWORK:        "drive_network",
    DRIVE_UNKNOWN:        "drive_unknown",
    UNKNOWN:              "unknown"
};

const RETRY_STRATEGY = {
    [FAILURE_REASON.SECURITY_CHECK]:        { delayMultiplier: 3, hint: "Looks like a Security Check — complete it manually in the browser." },
    [FAILURE_REASON.SAVE_BUTTON_NOT_FOUND]: { delayMultiplier: 2, hint: "Could not find the Save button — WorkUpload's page may have changed." },
    [FAILURE_REASON.NAVIGATION]:            { delayMultiplier: 1, hint: "Network/navigation hiccup — usually resolves itself on retry." },
    [FAILURE_REASON.DRIVE_AUTH]:            { delayMultiplier: 4, hint: "Google Drive auth issue — check helper-config.json or reset sign-in." },
    [FAILURE_REASON.DRIVE_QUOTA]:           { delayMultiplier: 6, hint: "Google Drive storage looks full." },
    [FAILURE_REASON.DRIVE_NETWORK]:         { delayMultiplier: 1, hint: "Network hiccup talking to Google Drive — usually resolves on retry." },
    [FAILURE_REASON.DRIVE_UNKNOWN]:         { delayMultiplier: 1, hint: null },
    [FAILURE_REASON.UNKNOWN]:               { delayMultiplier: 1, hint: null }
};

function classifyError(err) {
    const msg = (err && err.message || "").toLowerCase();
    if (msg.includes("net::") || msg.includes("econnrefused") || msg.includes("enotfound") ||
        (msg.includes("timeout") && (msg.includes("goto") || msg.includes("navigat")))) return FAILURE_REASON.NAVIGATION;
    return FAILURE_REASON.UNKNOWN;
}

/* ---------------------------------------------------------------------- */
/*  Throttle                                                             */
/* ---------------------------------------------------------------------- */

function throttleDelayMs() {
    if (!config || !config.throttle || !config.throttle.enabled) return 0;
    const { minMs, maxMs } = config.throttle;
    return Math.round(minMs + Math.random() * (maxMs - minMs));
}

/* ---------------------------------------------------------------------- */
/*  Upload — WorkUpload path (Playwright)                               */
/* ---------------------------------------------------------------------- */

async function attemptUploadWorkUpload(filePaths) {
    const delay = throttleDelayMs();
    if (delay > 0) await sleep(delay);

    let p;
    try {
        p = await timedStep("open_workupload", { files: filePaths.map(f => path.basename(f)) }, () => openWorkUpload());
    } catch (err) {
        return { ok: false, reason: classifyError(err), message: err.message, linksByFile: new Map() };
    }

    // Start ALL compression jobs in parallel worker threads NOW, while
    // also waiting for the WorkUpload file input to appear — the two
    // happen simultaneously instead of back to back.
    const compressionJobs = new Map(
        filePaths.map(fp => [fp, timedStep("compress", { file: path.basename(fp) }, () => compressInWorker(fp)).catch(err => ({ ok: false, message: err.message, path: fp }))])
    );

    log("Waiting for the file input...");
    const input = await timedStep("wait_file_input", {}, () => waitForFileInput(p, 120000));

    if (!input) {
        // Cancel workers — nothing we can do if the page never loaded a file input
        log("File input not found (Security Check?).");
        return { ok: false, reason: FAILURE_REASON.SECURITY_CHECK, message: "File input not found.", linksByFile: new Map() };
    }

    // Collect compression results (most should already be done by now)
    const uploadPaths = [];
    for (const fp of filePaths) {
        const result = await compressionJobs.get(fp);
        if (!result || !result.ok) {
            log(`Compression failed for ${path.basename(fp)}, using original:`, result && result.message);
            uploadPaths.push(fp);
        } else {
            if (result.compressed) {
                const pct = Math.round((1 - result.finalSize / result.originalSize) * 100);
                log(`Compressed ${path.basename(fp)}: ${(result.originalSize/1024/1024).toFixed(2)}MB → ${(result.finalSize/1024/1024).toFixed(2)}MB (-${pct}%)`);
            }
            uploadPaths.push(result.path);
        }
    }

    await timedStep("select_files", {}, () => input.setInputFiles(uploadPaths));
    log("File(s) selected. Waiting for Save button...");

    const saved = await timedStep("click_save", {}, () => clickSaveFile(p, 120000));
    if (!saved) {
        return { ok: false, reason: FAILURE_REASON.SAVE_BUTTON_NOT_FOUND, message: "Could not click Save.", linksByFile: new Map() };
    }

    log("Save clicked. Waiting for link...");
    const link = await timedStep("wait_link", {}, () => waitForShareLink(p, 20000));
    const linksByFile = new Map();
    if (link) {
        filePaths.forEach(fp => linksByFile.set(path.basename(fp), link));
        log("Link:", link);
    } else {
        log("Could not read the link automatically — check the browser tab.");
    }

    return { ok: true, linksByFile };
}

/* ---------------------------------------------------------------------- */
/*  Upload — Drive path (API, no browser)                               */
/* ---------------------------------------------------------------------- */

async function attemptUploadDrive(filePaths, folderName) {
    const driveApi = require("./drive.js");
    const linksByFile = new Map();
    const useBatchFolder = filePaths.length > 1;
    let batchFolder = null;

    if (useBatchFolder) {
        const displayName = (folderName && folderName.trim())
            ? folderName.trim().slice(0, 150)
            : `Batch ${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
        try {
            batchFolder = await timedStep("drive_create_batch_folder", { name: displayName }, () => driveApi.createBatchFolder(displayName));
            log(`Drive folder created: "${displayName}"`);
        } catch (err) {
            return { ok: false, reason: driveApi.classifyDriveError(err), message: err.message, linksByFile };
        }
    }

    // Compress all files in parallel workers, then upload in sequence
    const compressionJobs = new Map(
        filePaths.map(fp => [fp, timedStep("compress", { file: path.basename(fp) }, () => compressInWorker(fp)).catch(err => ({ ok: false, message: err.message, path: fp }))])
    );

    for (const fp of filePaths) {
        const name = path.basename(fp);
        const compResult = await compressionJobs.get(fp);
        const uploadPath = (!compResult || !compResult.ok) ? fp : compResult.path;

        if (compResult && compResult.compressed) {
            const pct = Math.round((1 - compResult.finalSize / compResult.originalSize) * 100);
            log(`Compressed ${name}: ${(compResult.originalSize/1024/1024).toFixed(2)}MB → ${(compResult.finalSize/1024/1024).toFixed(2)}MB (-${pct}%)`);
        }

        try {
            if (batchFolder) {
                await timedStep("drive_upload", { file: name }, () => driveApi.uploadFileToFolder(uploadPath, name, batchFolder.folderId));
                linksByFile.set(name, batchFolder.link);
            } else {
                const result = await timedStep("drive_upload", { file: name }, () => driveApi.uploadFileToDrive(uploadPath, name));
                linksByFile.set(name, result.link);
                log(`Uploaded to Drive: ${name} →`, result.link);
            }
        } catch (err) {
            return { ok: false, reason: driveApi.classifyDriveError(err), message: err.message, linksByFile };
        }
    }

    if (batchFolder) log("Batch folder link:", batchFolder.link);
    return { ok: true, linksByFile };
}

function attemptUpload(filePaths, folderName) {
    return config.destination === "drive"
        ? attemptUploadDrive(filePaths, folderName)
        : attemptUploadWorkUpload(filePaths);
}

/* ---------------------------------------------------------------------- */
/*  Batch success / failure                                             */
/* ---------------------------------------------------------------------- */

function finalizeBatchSuccess(filePaths, linksByFile, folderName) {
    const rawLinks = filePaths.map(f => linksByFile.get(path.basename(f))).filter(Boolean);
    const links = [...new Set(rawLinks)];
    const clipText = links.join("\n");

    if (clipText) {
        copyToClipboard(clipText).then(ok => {
            log(ok ? `Link(s) copied to clipboard (${links.length}).` : "Could not copy link(s) to clipboard.");
        });
    } else {
        log("No link detected automatically — check the browser tab.");
    }

    saveLastUpload(links, filePaths.map(f => path.basename(f)));

    const metas = filePaths.map(f => fileMeta.get(path.basename(f)) || {});
    uploadHistory.append({
        files: filePaths.map(f => path.basename(f)),
        links,
        destination: config.destination,
        folder: folderName || null,
        source: metas.map(m => m.source).find(Boolean) || null,
        viaPhotoshop: metas.some(m => m.ps),
        preset: config.activePreset || null
    });
    for (const f of filePaths) fileMeta.delete(path.basename(f));

    showNotification(
        "Spidx Uploader",
        filePaths.length === 1
            ? `Uploaded ${path.basename(filePaths[0])}${links.length ? " — link copied." : " — link not detected."}`
            : `Uploaded ${filePaths.length} files${links.length ? ` — ${links.length} link(s) copied.` : " — links not detected."}`
    );

    logEvent("batch", "ok", { count: filePaths.length, linksFound: links.length });
    writeBatchStatus({ state: "done", have: filePaths.length, target: filePaths.length, links });
    setTimeout(() => writeBatchStatus({ state: "idle" }), 5000);
}

/* ---------------------------------------------------------------------- */
/*  Queue + processBatch                                                 */
/* ---------------------------------------------------------------------- */

async function processBatch(filePaths, folderName) {
    const retryCfg = config.autoRetry || {};
    const maxAttempts = retryCfg.enabled ? Math.max(1, retryCfg.maxAttempts || 3) : 1;
    const baseDelay = Number.isFinite(retryCfg.delaySeconds) ? retryCfg.delaySeconds : 10;
    const linksByFile = new Map();
    let remaining = filePaths.slice();

    logEvent("batch", "start", { files: filePaths.map(f => path.basename(f)), count: filePaths.length });
    writeBatchStatus({ state: "uploading", have: filePaths.length, target: filePaths.length });

    for (let attempt = 1; attempt <= maxAttempts && remaining.length > 0; attempt++) {
        if (attempt > 1) log(`Retry ${attempt}/${maxAttempts} — ${remaining.length} file(s) remaining.`);

        try {
            const result = await attemptUpload(remaining, folderName);
            for (const [name, link] of result.linksByFile || []) linksByFile.set(name, link);
            remaining = remaining.filter(f => !linksByFile.has(path.basename(f)));
            if (remaining.length === 0) break;

            const strategy = RETRY_STRATEGY[result.reason] || RETRY_STRATEGY[FAILURE_REASON.UNKNOWN];
            log(`Attempt ${attempt}/${maxAttempts} incomplete [${result.reason}]: ${result.message}`);
            if (strategy.hint) log(strategy.hint);
            logEvent("batch_attempt", "fail", { attempt, reason: result.reason, message: result.message });

            if (attempt < maxAttempts) {
                const d = Math.round(baseDelay * strategy.delayMultiplier);
                log(`Waiting ${d}s before retry...`);
                await sleep(d * 1000);
            }
        } catch (err) {
            const reason = classifyError(err);
            const strategy = RETRY_STRATEGY[reason] || RETRY_STRATEGY[FAILURE_REASON.UNKNOWN];
            log(`Attempt ${attempt}/${maxAttempts} failed [${reason}]: ${err.message}`);
            if (strategy.hint) log(strategy.hint);
            logEvent("batch_attempt", "fail", { attempt, reason, message: err.message });

            if (attempt < maxAttempts) {
                const d = Math.round(baseDelay * strategy.delayMultiplier);
                log(`Waiting ${d}s before retry...`);
                await sleep(d * 1000);
            }
        }
    }

    if (remaining.length === 0) {
        finalizeBatchSuccess(filePaths, linksByFile, folderName);
        return;
    }

    log(`Gave up after ${maxAttempts} attempt(s). ${remaining.length} file(s) not uploaded.`);
    logEvent("batch", "fail", { failedFiles: remaining.map(f => path.basename(f)), attempts: maxAttempts });
    showNotification("Spidx Uploader — Failed", `Could not upload ${remaining.length} file(s). Check App\\helper.log.`);
    writeBatchStatus({ state: "error", have: filePaths.length - remaining.length, target: filePaths.length });
}

function enqueue(filePaths, folderName) {
    queue.push({ files: filePaths, folderName: folderName || null });
    persistQueue();
    log(`Queued: ${filePaths.length === 1 ? path.basename(filePaths[0]) : `batch of ${filePaths.length}`} (${queue.length} in queue).`);
    logEvent("queue", "info", { count: filePaths.length, queueLength: queue.length });
    if (!uploading) processQueue();
}

async function processQueue() {
    if (uploading) return;
    uploading = true;
    clearIdleClose();

    try {
        while (queue.length > 0) {
            const entry = queue.shift();
            persistQueue();
            const filePaths = entry.files;

            log("");
            log("========================================");
            log(filePaths.length === 1 ? "NEW UPLOAD" : `NEW BATCH (${filePaths.length} files)`);
            log("========================================");
            if (queue.length > 0) log(`${queue.length} more in queue.`);

            await processBatch(filePaths, entry.folderName);
        }
    } finally {
        uploading = false;
        if (config.destination !== "drive") scheduleIdleClose();
    }
}

/* ---------------------------------------------------------------------- */
/*  Batch collection (panel → engine handshake)                         */
/* ---------------------------------------------------------------------- */

function readBatchTargetCount() {
    const cap = tierMaxBatch(currentTier);
    try {
        const raw = JSON.parse(fs.readFileSync(BATCH_CONFIG_FILE, "utf8"));
        const n = Math.floor(raw.targetCount);
        if (Number.isFinite(n) && n >= 1 && n <= MAX_BATCH_SIZE) return Math.min(n, cap);
    } catch {}
    return 1;
}

function readBatchFolderName() {
    try {
        const raw = JSON.parse(fs.readFileSync(BATCH_CONFIG_FILE, "utf8"));
        if (typeof raw.folderName === "string" && raw.folderName.trim()) return raw.folderName.trim().slice(0, 150);
    } catch {}
    return null;
}

function clearBatchTimeoutTimer() {
    if (currentBatch && currentBatch.timeoutTimer) { clearTimeout(currentBatch.timeoutTimer); currentBatch.timeoutTimer = null; }
}

function finalizeBatchCollection() {
    if (!currentBatch || currentBatch.files.length === 0) return;
    clearBatchTimeoutTimer();
    const files = currentBatch.files.slice();
    const folderName = currentBatch.folderName;
    currentBatch = null;
    try { if (fs.existsSync(BATCH_FORCE_SEND)) fs.unlinkSync(BATCH_FORCE_SEND); } catch {}
    enqueue(files, folderName);
}

function addFileToBatch(fullPath) {
    if (!currentBatch) {
        currentBatch = { target: readBatchTargetCount(), folderName: readBatchFolderName(), files: [], timeoutTimer: null };
        logEvent("batch_collection", "start", { target: currentBatch.target });
    }
    if (currentBatch.files.includes(fullPath)) return;
    currentBatch.files.push(fullPath);

    writeBatchStatus({ state: "collecting", have: currentBatch.files.length, target: currentBatch.target });

    if (currentBatch.files.length >= currentBatch.target) {
        finalizeBatchCollection();
        return;
    }

    clearBatchTimeoutTimer();
    currentBatch.timeoutTimer = setTimeout(() => {
        log(`Batch timeout — sending ${currentBatch.files.length}/${currentBatch.target} file(s).`);
        finalizeBatchCollection();
    }, (config.batch.timeoutSeconds || 120) * 1000);
}

function checkForceSendMarker() {
    if (!currentBatch || currentBatch.files.length === 0) {
        try { if (fs.existsSync(BATCH_FORCE_SEND)) fs.unlinkSync(BATCH_FORCE_SEND); } catch {}
        return;
    }
    if (fs.existsSync(BATCH_FORCE_SEND)) {
        log("Force-send requested — sending partial batch now.");
        finalizeBatchCollection();
    }
}

// ---- client presets -------------------------------------------------------
// Applies a preset to the RUNNING helper (no restart) and to helper-config.json.
function applyPresetLive(name) {
    const { presets } = presetStore.loadPresets(CONFIG_FILE);
    const preset = presets.find(p => p.name.toLowerCase() === String(name || "").trim().toLowerCase());
    if (!preset) return { ok: false, message: `There is no preset called "${name}".` };

    presetStore.applyPresetToConfigObject(config, preset);
    try { presetStore.applyPresetToFile(CONFIG_FILE, preset); }
    catch (err) { log(`Preset "${preset.name}" applied in memory, but saving helper-config.json failed: ${err.message}`); }
    syncDefaultCameraRawPreset();

    const warnings = [];
    if (preset.destination === "drive" && !tierAllowsDrive(currentTier)) warnings.push("Google Drive needs a Pro plan - uploads use WorkUpload until then.");
    if (preset.cameraRawPreset && !tierAllowsProFeatures(currentTier)) warnings.push("Photoshop + Upload needs a Pro plan.");

    log(`Client preset "${preset.name}" applied (${presetStore.describePreset(preset).join(", ")}).`);
    logEvent("preset", "ok", { name: preset.name, destination: preset.destination });
    writeEngineStatus();
    return { ok: true, name: preset.name, warnings, message: warnings.length ? warnings.join(" ") : "" };
}

function checkPresetRequest() {
    if (!fs.existsSync(PRESET_REQUEST_FILE)) return;
    let request = null;
    try { request = JSON.parse(fs.readFileSync(PRESET_REQUEST_FILE, "utf8")); } catch {}
    try { fs.unlinkSync(PRESET_REQUEST_FILE); } catch {}
    if (!request || !request.name) return;

    let result;
    try { result = applyPresetLive(request.name); }
    catch (err) { result = { ok: false, message: err.message }; }
    try { fs.writeFileSync(PRESET_RESULT_FILE, JSON.stringify({ id: request.id || null, ...result, time: Date.now() }), "utf8"); } catch {}
}

function checkCancelMarker() {
    if (!fs.existsSync(BATCH_CANCEL)) return;
    try { fs.unlinkSync(BATCH_CANCEL); } catch {}
    if (!currentBatch) return;
    log("Batch cancelled.");
    clearBatchTimeoutTimer();
    currentBatch = null;
    writeBatchStatus({ state: "idle" });
}

/* ---------------------------------------------------------------------- */
/*  File detection helpers                                               */
/* ---------------------------------------------------------------------- */

// Accepted incoming media. JPG is what the Photoshop panel exports; the
// After Effects panel adds PNG (saveFrameToPng) and rendered video files,
// which are uploaded as-is (only raster stills go through compression).
const UPLOADABLE_RE = /\.(jpe?g|png|webp|tiff?|mp4|mov|avi|mkv|webm|gif)$/i;
function isJpg(name) { return UPLOADABLE_RE.test(name); }
function isCompressedByproduct(name) { return /\.compressed\.jpg$/i.test(name); }

// The ".ps.png" suffix is the AE panel's explicit "route this through
// Photoshop" choice (its "Photoshop + Upload" button) — a plain ".png"
// is its "Upload" button and always goes straight through, even if a
// preset is configured. Vegas's script only ever writes plain ".png",
// so it's unaffected by this and always uploads direct for now.
function needsCameraRaw(name) {
    return /\.ps\.png$/i.test(name)
        && !!(config.cameraRawPreset && config.cameraRawPreset.actionName)
        && tierAllowsProFeatures(currentTier);
}

// Routes a raw AE frame through the already-running Photoshop (see
// photoshop-bridge.js) to play the Dashboard-configured Camera Raw
// Action before it gets queued for upload. On any failure (Photoshop
// not open, Action not found, etc.) this deliberately still uploads the
// original frame rather than dropping the capture — the capture matters
// more than the edit.
async function routeThroughPhotoshop(fullPath) {
    const name = path.basename(fullPath);
    log(`Routing ${name} through Photoshop (Camera Raw Action)...`);
    logEvent("camera_raw", "start", { file: name });

    const result = await photoshopBridge.runCameraRaw(fullPath, config.cameraRawPreset);

    if (result.ok) {
        const outName = path.basename(result.outputPath);
        log(`Camera Raw applied — continuing with ${outName}.`);
        logEvent("camera_raw", "ok", { file: name, output: outName });
        rememberProcessed(outName);
        saveState();
        fileMeta.set(outName, { ...(fileMeta.get(name) || {}), ps: true });
        addFileToBatch(result.outputPath);
    } else {
        log(`Camera Raw step failed for ${name}: ${result.error} — uploading the original frame instead.`);
        logEvent("camera_raw", "fail", { file: name, message: result.error });
        showNotification("Spidx Uploader — Camera Raw skipped", `${result.error} Uploading the original frame instead.`);
        addFileToBatch(fullPath);
    }
}

/* ---------------------------------------------------------------------- */
/*  Scan incoming folder                                                 */
/* ---------------------------------------------------------------------- */

function seedExistingFiles() {
    let files = [];
    try { files = fs.readdirSync(INCOMING); } catch { return; }
    let seeded = 0;
    for (const name of files) {
        if (!isJpg(name) || isCompressedByproduct(name) || processed.has(name)) continue;
        rememberProcessed(name);
        seeded++;
    }
    if (seeded > 0) {
        log(`Skipped ${seeded} file(s) already present before the engine started.`);
        saveState();
    }
}

// A refused file is moved to incoming\\rejected (not deleted - the user can still
// take it) and the user is told why. Remembered as processed so it isn't retried.
function rejectIncoming(fullPath, name, reason) {
    log(`Refused ${name}: ${reason}`);
    logEvent("incoming_gate", "rejected", { file: name, reason });
    lastRejection = { time: Date.now(), file: name, reason };
    try {
        const dir = path.join(INCOMING, "rejected");
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(fullPath, path.join(dir, name));
    } catch (err) {
        log(`Could not move ${name} to the rejected folder: ${err.message}`);
    }
    showNotification("Spidx Uploader - Pro feature", reason);
    writeEngineStatus();
}

function scan() {
    let files = [];
    try { files = fs.readdirSync(INCOMING); } catch { return; }

    checkCancelMarker();
    checkForceSendMarker();
    checkPresetRequest();

    for (const name of files) {
        if (!isJpg(name) || isCompressedByproduct(name) || processed.has(name) || pending.has(name)) continue;

        const full = path.join(INCOMING, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;

        pending.add(name);
        const size1 = stat.size;

        setTimeout(() => {
            pending.delete(name);
            try {
                const size2 = fs.statSync(full).size;
                if (size1 !== size2 || processed.has(name)) return;
                rememberProcessed(name);
                saveState();

                // VEGAS files carry a ".vg" tag: refuse them without Pro, strip the tag otherwise.
                const verdict = decideIncoming(name, tierAllowsProFeatures(currentTier));
                if (verdict.action === "reject") {
                    rejectIncoming(full, name, verdict.reason);
                    return;
                }
                let target = full;
                if (verdict.cleanName !== name) {
                    const cleanFull = path.join(INCOMING, verdict.cleanName);
                    rememberProcessed(verdict.cleanName);
                    saveState();
                    try {
                        if (fs.existsSync(cleanFull)) fs.unlinkSync(cleanFull);
                        fs.renameSync(full, cleanFull);
                        target = cleanFull;
                    } catch (err) {
                        log(`Could not strip the VEGAS tag from ${name}: ${err.message} - uploading it as is.`);
                    }
                }
                const targetName = path.basename(target);
                fileMeta.set(targetName, { source: verdict.source, ps: false });

                if (needsCameraRaw(targetName)) {
                    routeThroughPhotoshop(target);
                } else {
                    addFileToBatch(target);
                }
            } catch {}
        }, 700);
    }
}

function startWatching() {
    try { fs.watch(INCOMING, () => scheduleScan()); } catch { log("fs.watch unavailable, using polling only."); }
}

function scheduleScan() {
    if (scanDebounce) return;
    scanDebounce = setTimeout(() => { scanDebounce = null; scan(); }, 150);
}

/* ---------------------------------------------------------------------- */
/*  Auto-cleanup                                                         */
/* ---------------------------------------------------------------------- */

function cleanupOldFiles() {
    const cfg = config.cleanup || {};
    if (!cfg.enabled) return;
    const afterDays = Number.isFinite(cfg.afterDays) && cfg.afterDays > 0 ? cfg.afterDays : 7;
    const cutoff = Date.now() - afterDays * DAY_MS;
    let files = [];
    try { files = fs.readdirSync(INCOMING); } catch { return; }
    let removed = 0;
    for (const name of files) {
        if (!isJpg(name)) continue;
        if (!isCompressedByproduct(name) && !processed.has(name)) continue;
        try {
            const stat = fs.statSync(path.join(INCOMING, name));
            if (stat.mtimeMs < cutoff) { fs.unlinkSync(path.join(INCOMING, name)); removed++; }
        } catch {}
    }
    if (removed > 0) log(`Auto-cleanup: removed ${removed} old file(s).`);
}

/* ---------------------------------------------------------------------- */
/*  Google sign-in + tier                                               */
/* ---------------------------------------------------------------------- */

async function checkGoogleSignInAndTier() {
    try {
        const googleAuth = require("./google-auth.js");
        const license    = require("./license.js");
        const email   = await timedStep("google_signin", {}, () => googleAuth.getUserEmail());
        const idToken = await timedStep("google_id_token", {}, () => googleAuth.getIdToken());
        const result  = await timedStep("license_check", { email }, () => license.checkTier(idToken, email));
        log(`Signed in as ${email} — tier: ${result.tier}${result.deviceLimitReached ? " (device limit reached)" : ""}.`);
        return result;
    } catch (err) {
        log("Could not sign in with Google (continuing as free):", err.message);
        return { tier: "free", deviceLimitReached: false };
    }
}

/* ---------------------------------------------------------------------- */
/*  main()                                                               */
/* ---------------------------------------------------------------------- */

async function main() {
    ensureDirs();
    loadState();
    seedExistingFiles();
    config = loadConfig();
    syncDefaultCameraRawPreset();

    console.log("");
    console.log("========================================");
    console.log(`   SPIDX UPLOADER — ${ENGINE_NAME.toUpperCase()}`);
    console.log("========================================");
    console.log("");

    // Say "I exist" before anything that can fail or take time (Google
    // sign-in, browser launch). Otherwise both panels sit on "helper not
    // running" for the whole startup and the user assumes it's broken.
    setEngineState("starting");
    startHeartbeat();

    log("Folder:", INCOMING);
    log("Destination:", config.destination === "drive" ? "Google Drive" : "WorkUpload");
    log("Auto-retry:", config.autoRetry.enabled ? `on (${config.autoRetry.maxAttempts} attempts, ${config.autoRetry.delaySeconds}s base)` : "off");
    log("Throttle:", config.throttle.enabled ? `on (${config.throttle.minMs}–${config.throttle.maxMs}ms)` : "off");
    log("Config:", CONFIG_FILE);
    log("");

    log("Signing in with Google...");
    try {
        const licenseResult = await checkGoogleSignInAndTier();
        currentTier = licenseResult.tier;
        currentRoles = Array.isArray(licenseResult.roles) && licenseResult.roles.length ? licenseResult.roles : [licenseResult.tier];
        currentDeviceLimitReached = licenseResult.deviceLimitReached;
        currentTrialDaysRemaining = licenseResult.trialDaysRemaining || null;
    } catch (error) {
        // Free tier + WorkUpload is a perfectly usable fallback, and it
        // beats the old behaviour by a mile: this used to reject out of
        // main() and exit(1), so a flaky network on startup looked like
        // "the app is dead" rather than "you're on Free until it can
        // check again".
        log(`Google sign-in / tier check failed: ${error.message} — continuing on free.`);
        setEngineState("error", `Sign-in failed: ${error.message}`);
        currentTier = "free";
        currentRoles = ["free"];
        currentDeviceLimitReached = false;
        currentTrialDaysRemaining = null;
        config.destination = "workupload";
    }

    if (config.destination === "drive" && !tierAllowsDrive(currentTier)) {
        log(`Drive not available on tier "${currentTier}" — using WorkUpload.`);
        config.destination = "workupload";
    }

    writeBatchStatus({ state: "idle" });
    writeEngineStatus();
    loadQueue();

    try {
        if (config.destination === "drive") {
            log("Connecting to Google Drive...");
            await require("./drive.js").warmUpDrive();
        } else {
            log("Starting browser...");
            await warmUpBrowser();
        }
    } catch (error) {
        // Warm-up is an optimisation, not a requirement — the per-upload
        // path opens what it needs anyway. Failing here used to abort
        // startup entirely.
        log(`Warm-up failed (${error.message}) — will connect on the first upload instead.`);
    }

    setEngineState("ready");
    log(`Ready. Watching for new files from Photoshop and After Effects — ${INCOMING}`);

    setInterval(scan, POLL_MS);
    startWatching();
    scan();
    cleanupOldFiles();
    setInterval(cleanupOldFiles, 6 * 60 * 60 * 1000);

    if (queue.length > 0) {
        log(`Processing ${queue.length} batch(es) from the previous session...`);
        processQueue();
    }
}

process.on("SIGINT", async () => {
    log("Shutting down...");
    try { if (browser) await browser.close(); } catch {}
    process.exit(0);
});

main().catch(err => {
    // Absolute last resort. Even here the process stays up: the file
    // watcher may still be running, the panels can still see a status
    // file, and the tray's watchdog restarting a process that would just
    // fail the same way again helps nobody.
    console.error(err);
    try { setEngineState("error", err && err.message ? err.message : String(err)); } catch {}
    try { startHeartbeat(); } catch {}
    log("Startup did not complete — see the error above. The engine stays up so you can fix it without restarting.");
});

process.on("unhandledRejection", reason => {
    log("Unhandled rejection:", reason && reason.stack ? reason.stack : reason);
});
