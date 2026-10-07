"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const APP_DIR = __dirname;
const SERVER_SCRIPT = path.join(APP_DIR, "server.js");
const LOG_FILE = path.join(APP_DIR, "helper.log");
const INCOMING_DIR = path.join(APP_DIR, "incoming");
const ICON_PATH = path.join(APP_DIR, "tray-icon.ico");
const HIDDEN_LAUNCHER = path.join(APP_DIR, "start-tray-hidden.vbs");
const RESET_MARKER_NAME = ".reset-folder-request";
const GOOGLE_TOKEN_FILE = path.join(APP_DIR, "google-token.json");
const LICENSE_CACHE_FILE = path.join(APP_DIR, "license-cache.json");
const LAST_UPLOAD_FILE = path.join(APP_DIR, "last-upload.json");
const SKIP_WIZARD_MARKER = path.join(APP_DIR, ".skip-wizard-once");
const PENDING_CODE_FILE = path.join(APP_DIR, ".pending-license-code"); // written by protocol-handler.js on a spidx://activate click

const STARTUP_DIR = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
);
const STARTUP_LINK = path.join(STARTUP_DIR, "SpidxUploaderHelper.vbs");

const MAX_LOG_BYTES = 2 * 1024 * 1024; // rotate the log once it gets past 2 MB

// The tray ICON is a convenience; the helper is the product. Every
// failure path below therefore degrades to "no icon, helper still
// running" instead of exiting — an exit here is what made the app look
// completely dead ("Tray app has stopped.") when all that was actually
// broken was systray2's little helper binary (a missing install, an
// antivirus quarantine, or a blocked temp folder).
let SysTrayLib = null;
try {
    SysTrayLib = require("node-systray-v2");
    SysTrayLib = SysTrayLib.default || SysTrayLib;
} catch (error) {
    SysTrayLib = null;
    console.error(`[TRAY] Tray icon package unavailable (${error.message}) — running without a tray icon.`);
}

let trayAvailable = false;

// Anything thrown outside a try/catch used to kill the process silently
// from the user's point of view: the console window printed a stack and
// closed, or the .vbs launcher swallowed it entirely. Log it, keep the
// helper alive, and let the watchdog restart it if it was the one that
// died.
process.on("uncaughtException", error => {
    const line = `[TRAY] Uncaught error: ${error && error.stack ? error.stack : error}\n`;
    console.error(line);
    try { appendLog(line); } catch {}
});

process.on("unhandledRejection", reason => {
    const line = `[TRAY] Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}\n`;
    console.error(line);
    try { appendLog(line); } catch {}
});

// Keeps the event loop alive no matter what else happens, so the process
// can never quietly fall off the end and print "Tray app has stopped."
// while the user is still expecting it to be running.
setInterval(() => {}, 60000);

let child = null;
let status = "stopped"; // "stopped" | "running" | "error"
let systray = null;
let trayReady = false;
let pendingMenuUpdate = false;
let updateInfo = { hasUpdate: false, latestVersion: null, downloadUrl: null };
let pluginUpdateInfo = { hasUpdates: false, updates: [] };

/* ---------------------------------------------------------------------- */
/*  Log file                                                              */
/* ---------------------------------------------------------------------- */

function appendLog(text) {
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
            fs.writeFileSync(LOG_FILE, "");
        }
        fs.appendFileSync(LOG_FILE, text);
    } catch {}
}

function escapeForPowerShellDoubleQuoted(text) {
    return String(text)
        .replace(/`/g, "``")
        .replace(/"/g, '`"')
        .replace(/\$/g, "`$");
}

// How many times to retry a pending code before giving up (each retry is
// one tick of the 4s interval below, so ~20s total) — covers the normal
// "helper just started, still signing in to Google" window without
// retrying forever if the person was never signed in at all.
const PENDING_CODE_MAX_ATTEMPTS = 5;
let pendingCodeAttempts = 0;

// Checks for a code dropped by protocol-handler.js (a spidx://activate
// click) and redeems it using the exact same logic as the Dashboard's
// "Enter a license code" field. Safe to call often: it's just an
// fs.existsSync() when there's nothing pending.
async function checkPendingLicenseCode() {
    if (!fs.existsSync(PENDING_CODE_FILE)) {
        pendingCodeAttempts = 0;
        return;
    }

    let code;
    try {
        code = fs.readFileSync(PENDING_CODE_FILE, "utf8").trim();
    } catch {
        return; // transient read error - try again next tick
    }
    if (!code) {
        try { fs.unlinkSync(PENDING_CODE_FILE); } catch {}
        return;
    }

    pendingCodeAttempts++;

    let result;
    try {
        const { redeemLicenseCode } = require("./license-actions.js");
        result = await redeemLicenseCode(code);
    } catch (error) {
        result = { ok: false, message: error.message };
    }

    // "Could not get a Google sign-in token" is the one failure worth
    // retrying — it means the helper (or the sign-in flow) is still
    // starting up. Anything else (bad code, already redeemed, server
    // unreachable) won't fix itself by waiting.
    const looksLikeStillStarting = !result.ok && /sign-in token/i.test(result.message || "");
    if (looksLikeStillStarting && pendingCodeAttempts < PENDING_CODE_MAX_ATTEMPTS) {
        appendLog(`[TRAY] Pending license code: not ready yet (attempt ${pendingCodeAttempts}/${PENDING_CODE_MAX_ATTEMPTS}) - ${result.message}\n`);
        return; // leave the file in place, try again next tick
    }

    try { fs.unlinkSync(PENDING_CODE_FILE); } catch {}
    pendingCodeAttempts = 0;

    if (result.ok) {
        const tierText = result.tier ? result.tier.toUpperCase() : "your new";
        appendLog(`[TRAY] License code activated from Discord link - tier: ${result.tier}\n`);
        showMessageBox("Spidx Uploader", `License activated! You're now on the ${tierText} tier.`);
        // Force a fresh tier check right away (cache is already cleared).
        restartHelperWhenIdle();
    } else {
        appendLog(`[TRAY] Pending license code failed: ${result.message}\n`);
        showMessageBox("Spidx Uploader", `Couldn't activate that license code: ${result.message}\n\nYou can also paste it directly in Dashboard > Account.`);
    }
}

// Same as the Dashboard's "Force refresh tier": the license cache is
// already cleared by redeemLicenseCode(), but server.js only reads the
// tier at startup, so restart the helper to make it re-check right now.
// If a batch is mid-upload, wait until it's done (max 5 min) first.
function restartHelperWhenIdle() {
    const batchFile = path.join(INCOMING_DIR, ".batch-status.json");
    const active = () => {
        try {
            const s = JSON.parse(fs.readFileSync(batchFile, "utf8"));
            return s && (s.state === "uploading" || s.state === "collecting");
        } catch { return false; }
    };
    if (!active()) { restartHelper(); return; }

    appendLog("[TRAY] Tier refresh deferred - a batch is in progress.\n");
    const startedAt = Date.now();
    const timer = setInterval(() => {
        if (!active() || Date.now() - startedAt > 5 * 60 * 1000) {
            clearInterval(timer);
            restartHelper();
        }
    }, 2000);
}

// Small confirmation popup for menu actions that would otherwise be
// silent (e.g. "Change incoming folder…" just drops a marker file — with
// no visible feedback, clicking it looks like it did nothing at all).
function showMessageBox(title, message) {
    const t = escapeForPowerShellDoubleQuoted(title);
    const m = escapeForPowerShellDoubleQuoted(message);
    const script =
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
        `[System.Windows.Forms.MessageBox]::Show("${m}", "${t}", 'OK', 'Information') | Out-Null`;

    try {
        const proc = spawn(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
            { windowsHide: true, detached: true }
        );
        proc.on("error", error => appendLog(`[TRAY] Could not show message box: ${error.message}\n`));
        proc.unref();
    } catch (error) {
        appendLog(`[TRAY] Could not show message box: ${error.message}\n`);
    }
}

/* ---------------------------------------------------------------------- */
/*  Helper process control                                                */
/* ---------------------------------------------------------------------- */

let stopRequested = false;
let crashCount = 0;
const MAX_CRASH_RESTARTS = 5;

function startHelper() {
    if (child) return;
    stopRequested = false;

    status = "running";
    updateMenu();
    appendLog(`\n[TRAY] Starting helper — ${new Date().toISOString()}\n`);

    // process.execPath = the exact node.exe already running this tray app,
    // so there's no need to re-detect Node's location like start-helper.bat
    // does — we already know it.
    child = spawn(process.execPath, [SERVER_SCRIPT], {
        cwd: APP_DIR,
        windowsHide: true
    });

    child.stdout.on("data", data => appendLog(data.toString()));
    child.stderr.on("data", data => appendLog(data.toString()));

    child.on("exit", code => {
        appendLog(`[TRAY] Helper exited (code ${code}) — ${new Date().toISOString()}\n`);
        child = null;
        status = code === 0 || code === null ? "stopped" : "error";
        updateMenu();

        // Crash-only restart, and only if the user didn't stop it on
        // purpose (stopHelper() clears stopRequested's counterpart by
        // setting it true first). Backs off after repeated crashes so a
        // permanently broken install doesn't spin forever.
        if (!stopRequested && code !== 0 && code !== null) {
            crashCount += 1;
            if (crashCount <= MAX_CRASH_RESTARTS) {
                const delay = Math.min(30000, 2000 * crashCount);
                appendLog(`[TRAY] Restarting the helper in ${Math.round(delay / 1000)}s (crash ${crashCount}/${MAX_CRASH_RESTARTS}).\n`);
                setTimeout(() => { if (!child) startHelper(); }, delay);
            } else {
                appendLog("[TRAY] Helper keeps crashing — giving up on auto-restart. Open the log to see why.\n");
            }
        }
    });

    child.on("error", error => {
        appendLog(`[TRAY] Failed to start helper: ${error.message}\n`);
        child = null;
        status = "error";
        updateMenu();
    });
}

function stopHelper() {
    stopRequested = true;
    if (!child) return;
    appendLog(`[TRAY] Stopping helper — ${new Date().toISOString()}\n`);
    try {
        child.kill();
    } catch {}
    child = null;
    status = "stopped";
    updateMenu();
}

function restartHelper() {
    stopHelper();
    setTimeout(startHelper, 600);
}

function readLastUpload() {
    try {
        return JSON.parse(fs.readFileSync(LAST_UPLOAD_FILE, "utf8"));
    } catch {
        return null;
    }
}

function hasLastUpload() {
    const last = readLastUpload();
    return !!(last && Array.isArray(last.links) && last.links.length > 0);
}

function escapePS(text) {
    return String(text).replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

function runClipboardCmd(cmd, args, stdinText) {
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
        } catch {
            resolve(false);
        }
    });
}

function copyTextToClipboard(text) {
    const escaped = escapePS(text);
    return runClipboardCmd("clip", [], text)
        .then(ok => ok || runClipboardCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value "${escaped}"`]))
        .then(ok => ok || runClipboardCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("${escaped}")`]));
}

/* ---------------------------------------------------------------------- */
/*  Start with Windows                                                    */
/* ---------------------------------------------------------------------- */

function isAutostartEnabled() {
    return fs.existsSync(STARTUP_LINK);
}

function toggleAutostart() {
    try {
        if (isAutostartEnabled()) {
            fs.unlinkSync(STARTUP_LINK);
        } else {
            fs.mkdirSync(STARTUP_DIR, { recursive: true });
            const vbs =
                'Set shell = CreateObject("WScript.Shell")\r\n' +
                `shell.Run """${HIDDEN_LAUNCHER}""", 0, False\r\n`;
            fs.writeFileSync(STARTUP_LINK, vbs, "utf8");
        }
    } catch (error) {
        appendLog(`[TRAY] Autostart toggle failed: ${error.message}\n`);
    }
    updateMenu();
}

/* ---------------------------------------------------------------------- */
/*  Tray menu                                                             */
/* ---------------------------------------------------------------------- */

function statusLabel() {
    if (status === "running") return "Running";
    if (status === "error") return "Stopped (error — check log)";
    return "Stopped";
}

// Each entry's position in this array is its seq_id, matching what
// node-systray reports back in onClick. Keep the order stable.
function itemDefs() {
    return [
        { key: "status", title: `Status: ${statusLabel()}`, enabled: false },
        // ALWAYS present (hidden until an update exists). The tray binary fixes the
        // item list when it starts and reports clicks by position, so the list must
        // never grow/shrink later — adding this item on the fly used to shift every
        // index below it and make clicks trigger the wrong menu entry.
        {
            key: "checkUpdate",
            title: updateInfo.hasUpdate ? `\u2B06 Update available \u2014 ${updateInfo.latestVersion}` : "Update available",
            enabled: !!updateInfo.hasUpdate,
            hidden: !updateInfo.hasUpdate
        },
        // Hidden until plugin updates exist - always present for the same
        // reason as the app-update item above (stable positions).
        {
            key: "pluginUpdates",
            title: pluginUpdateInfo.hasUpdates ? "\u2B06 Plugin updates available \u2014 open Dashboard" : "Plugin updates",
            enabled: !!pluginUpdateInfo.hasUpdates,
            hidden: !pluginUpdateInfo.hasUpdates
        },
        { separator: true },
        { key: "start", title: "Start helper", enabled: status !== "running" },
        { key: "stop", title: "Stop helper", enabled: status === "running" },
        { key: "restart", title: "Restart helper", enabled: status === "running" },
        { separator: true },
        { key: "changeFolder", title: "Change incoming folder\u2026", enabled: true },
        { key: "openLog", title: "Open log", enabled: true },
        { key: "diagnostics", title: "Create diagnostics file\u2026", enabled: true },
        { key: "copyLastLink", title: "Copy last upload link", enabled: hasLastUpload() },
        { separator: true },
        { key: "dashboard", title: "Open Dashboard", enabled: true },
        { separator: true },
        { key: "resetDriveLogin", title: "Reset Google sign-in", enabled: true },
        { separator: true },
        {
            key: "autostart",
            title: isAutostartEnabled() ? "\u2713 Start with Windows" : "Start with Windows",
            enabled: true
        },
        { separator: true },
        { key: "quit", title: "Quit", enabled: true }
    ];
}

let currentDefs = itemDefs();

function buildTrayItems(defs) {
    return defs.map(def =>
        def.separator
            ? SysTrayLib.separator
            : { title: def.title, tooltip: "", checked: false, enabled: def.enabled, hidden: !!def.hidden }
    );
}

function updateMenu() {
    if (!systray) return;
    currentDefs = itemDefs();
    if (!trayReady) {
        // The tray's underlying process hasn't finished starting yet —
        // sendAction would throw. Remember to push this once it's ready.
        pendingMenuUpdate = true;
        return;
    }
    const items = buildTrayItems(currentDefs);
    items.forEach((item, seq_id) => {
        try {
            systray.sendAction({ type: "update-item", item, seq_id });
        } catch (error) {
            appendLog(`[TRAY] Failed to update menu item: ${error.message}\n`);
        }
    });
}

function handleClick(seqId) {
    const def = currentDefs[seqId];
    if (!def || def.separator) return;

    switch (def.key) {
        case "start":
            startHelper();
            break;
        case "stop":
            stopHelper();
            break;
        case "restart":
            restartHelper();
            break;
        case "changeFolder":
            try {
                fs.mkdirSync(INCOMING_DIR, { recursive: true });
                fs.writeFileSync(path.join(INCOMING_DIR, RESET_MARKER_NAME), "");
                appendLog(`[TRAY] Folder change requested — open the Spidx panel in Photoshop to pick a new folder.\n`);
                showMessageBox(
                    "Spidx Uploader",
                    "Folder change requested.\n\nOpen (or switch to) the Spidx panel in Photoshop — it will ask you to pick a new folder within a few seconds, or the next time you click Upload."
                );
            } catch (error) {
                appendLog(`[TRAY] Could not request a folder change: ${error.message}\n`);
            }
            break;
        case "openLog":
            try {
                if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");
                const notepadProc = spawn("notepad.exe", [LOG_FILE], { detached: true });
                notepadProc.on("error", error => {
                    appendLog(`[TRAY] Could not open the log file: ${error.message}\n`);
                });
                notepadProc.unref();
            } catch (error) {
                appendLog(`[TRAY] Could not open the log file: ${error.message}\n`);
            }
            break;
        case "diagnostics":
            (async () => {
                try {
                    const { buildDiagnostics } = require("./diagnostics.js");
                    const result = await buildDiagnostics(msg => appendLog(`[TRAY][Diagnostics] ${msg}\n`));
                    if (!result.ok) {
                        showMessageBox("Spidx Uploader", `Could not create the diagnostics file: ${result.message}`);
                        return;
                    }
                    try {
                        const child = spawn("explorer.exe", ["/select," + result.path], { detached: true, windowsHide: false });
                        child.on("error", () => {});
                        child.unref();
                    } catch {}
                    showMessageBox("Spidx Uploader", `Diagnostics file created (${result.summary.fail} failed, ${result.summary.warn} warning checks).\n\nSend this file to support:\n${result.path}`);
                } catch (error) {
                    appendLog(`[TRAY] Diagnostics failed: ${error.message}\n`);
                    showMessageBox("Spidx Uploader", `Could not create the diagnostics file: ${error.message}`);
                }
            })();
            break;
        case "copyLastLink":
            (async () => {
                const last = readLastUpload();
                if (!last || !Array.isArray(last.links) || last.links.length === 0) {
                    showMessageBox("Spidx Uploader", "No upload link saved yet.");
                    return;
                }
                const ok = await copyTextToClipboard(last.links.join("\n"));
                if (!ok) {
                    appendLog(`[TRAY] Could not copy last upload link to clipboard.\n`);
                    showMessageBox("Spidx Uploader", "Could not copy the link to the clipboard.");
                }
            })();
            break;
        case "pluginUpdates":
        case "dashboard":
            try {
                const { openDashboard } = require("./dashboard.js");
                openDashboard(msg => appendLog(`[TRAY][Dashboard] ${msg}\n`), {
                    isRunning: () => status === "running",
                    restartHelper: () => {
                        appendLog(`[TRAY] Restarting helper (requested by Dashboard) — ${new Date().toISOString()}\n`);
                        restartHelper();
                    },
                    quitApp: () => {
                        appendLog(`[TRAY] Logging out (requested by Dashboard) — relaunching fresh, then quitting — ${new Date().toISOString()}\n`);
                        stopHelper();
                        // Logout just deleted google-token.json, which would
                        // otherwise make the relaunched process think this is
                        // a brand-new install and block startHelper() behind
                        // the full first-run wizard (sign-in + destination +
                        // panel installs) until someone clicks all the way
                        // through it in a browser tab. This marker tells the
                        // next main() to skip straight to startHelper() —
                        // the normal Google sign-in prompt still happens on
                        // its own via google-auth.js once the helper starts.
                        try { fs.writeFileSync(SKIP_WIZARD_MARKER, ""); } catch (err) {
                            appendLog(`[TRAY] Could not write skip-wizard marker: ${err.message}\n`);
                        }
                        try {
                            // Was: wscript.exe running start-tray-hidden.vbs,
                            // which runs start-tray.bat, which finally starts
                            // node. That chain goes through a script file
                            // (start-tray-hidden.vbs) that — unlike the main
                            // Spidx Uploader.vbs a user double-clicks and
                            // Windows learns to trust over time — had never
                            // been executed before on a fresh install, which
                            // is exactly when Windows SmartScreen/Defender is
                            // most likely to throw up a silent scan/warning
                            // on first run and stall the whole relaunch for
                            // minutes with no visible sign anything is wrong.
                            // Spawning node directly on tray.js — the same
                            // way startHelper() already spawns server.js —
                            // skips wscript.exe, the .vbs and the .bat
                            // entirely, so there's no script layer left for
                            // Windows to flag.
                            const relaunch = spawn(process.execPath, [__filename], {
                                cwd: APP_DIR,
                                detached: true,
                                windowsHide: true,
                                stdio: "ignore"
                            });
                            relaunch.on("error", err => appendLog(`[TRAY] Could not relaunch after logout: ${err.message}\n`));
                            relaunch.unref();
                        } catch (err) {
                            appendLog(`[TRAY] Could not relaunch after logout: ${err.message}\n`);
                        }
                        try { systray.kill(false); } catch {}
                        process.exit(0);
                    }
                });
            } catch (error) {
                appendLog(`[TRAY] Could not open the dashboard: ${error.message}\n`);
                showMessageBox("Spidx Uploader", `Could not open the dashboard: ${error.message}`);
            }
            break;
        case "checkUpdate":
            if (updateInfo.installerAssetUrl) {
                const { downloadAndRunInstaller, openReleasePage } = require("./update-check.js");
                appendLog(`[TRAY] Downloading update installer (${updateInfo.installerAssetName})...\n`);
                downloadAndRunInstaller(updateInfo)
                    .then(savedTo => appendLog(`[TRAY] Update installer launched from ${savedTo}.\n`))
                    .catch(error => {
                        appendLog(`[TRAY] Could not download the installer (${error.message}); opening the release page instead.\n`);
                        if (updateInfo.downloadUrl) openReleasePage(updateInfo.downloadUrl, msg => appendLog(`[TRAY] ${msg}\n`));
                    });
            } else if (updateInfo.downloadUrl) {
                const { openReleasePage } = require("./update-check.js");
                openReleasePage(updateInfo.downloadUrl, msg => appendLog(`[TRAY] ${msg}\n`));
            }
            break;
        case "autostart":
            toggleAutostart();
            break;
        case "resetDriveLogin":
            try {
                const existed = fs.existsSync(GOOGLE_TOKEN_FILE);
                if (existed) fs.unlinkSync(GOOGLE_TOKEN_FILE);
                if (fs.existsSync(LICENSE_CACHE_FILE)) fs.unlinkSync(LICENSE_CACHE_FILE);
                appendLog(`[TRAY] Google sign-in + tier cache reset (login existed: ${existed}) — ${new Date().toISOString()}\n`);

                if (status === "running") {
                    showMessageBox(
                        "Spidx Uploader",
                        "Google sign-in reset (this also affects Drive uploads and your Free/Pro tier check). Restarting the helper now — your browser will open for a fresh login."
                    );
                    restartHelper();
                } else {
                    showMessageBox(
                        "Spidx Uploader",
                        "Google sign-in reset. Starting the helper now — your browser will open for a fresh login."
                    );
                    startHelper();
                }
            } catch (error) {
                appendLog(`[TRAY] Could not reset Google sign-in: ${error.message}\n`);
                showMessageBox("Spidx Uploader", `Could not reset the Google sign-in: ${error.message}`);
            }
            break;
        case "quit":
            stopHelper();
            try {
                systray.kill(false);
            } catch {}
            process.exit(0);
            break;
    }
}

/* ---------------------------------------------------------------------- */
/*  Boot                                                                  */
/* ---------------------------------------------------------------------- */

// Brings up the tray icon, or reports why it couldn't and returns false.
// Never throws — see the SysTrayLib comment at the top.
async function startTrayIcon() {
    if (!SysTrayLib) return false;

    let iconBase64;
    try {
        iconBase64 = fs.readFileSync(ICON_PATH).toString("base64");
    } catch (error) {
        appendLog(`[TRAY] Could not read the tray icon (${error.message}) — running without an icon.\n`);
        return false;
    }

    try {
        systray = new SysTrayLib({
            menu: {
                icon: iconBase64,
                title: "",
                tooltip: "Spidx Uploader Helper",
                items: buildTrayItems(currentDefs)
            },
            debug: false,
            copyDir: true
        });

        systray.onClick(action => handleClick(action.seq_id));

        if (typeof systray.ready === "function") {
            // systray2's ready() can hang forever if its bundled binary
            // was quarantined or blocked — a hang here used to mean the
            // helper never started at all, so it's raced against a
            // timeout and treated as "no icon" if it loses.
            await Promise.race([
                systray.ready(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 15s")), 15000))
            ]);
        }

        trayReady = true;
        if (pendingMenuUpdate) {
            pendingMenuUpdate = false;
            updateMenu();
        }
        if (typeof systray.onExit === "function") {
            try { systray.onExit(() => process.exit(0)); } catch {}
        }
        return true;
    } catch (error) {
        appendLog(`[TRAY] Tray icon unavailable (${error.message}) — the helper itself will still run.\n`);
        try { if (systray && typeof systray.kill === "function") systray.kill(false); } catch {}
        systray = null;
        trayReady = false;
        return false;
    }
}

// Written on every startup so (a) a second launch can tell a live copy is
// already running instead of opening a duplicate tray icon + a second
// server.js, and (b) the installer (see Installer\\SpidxUploader.iss ->
// CurStepChanged(ssInstall)) can read this PID and close the running app
// before it overwrites App\\*.js.
//
// IMPORTANT: a PID alone proves nothing. Windows reuses PIDs aggressively
// (after a reboot or crash the number in this file very often belongs to a
// completely unrelated process), and the old check "is that PID alive?" then
// made every launch bail out with "already running" while no tray existed.
// So a copy only counts as running if its PID is alive AND the file's
// modification time is fresh: the running tray re-writes the file every few
// seconds (heartbeat), and removes it again on a clean exit.
const PID_FILE = path.join(APP_DIR, ".tray.pid");
const HEARTBEAT_MS = 5000;
const HEARTBEAT_STALE_MS = 30000;

function isProcessAlive(pid) {
    if (!pid || Number.isNaN(pid)) return false;
    try {
        process.kill(pid, 0); // signal 0: existence/permission check only, doesn't actually signal anything
        return true;
    } catch (error) {
        return error.code === "EPERM"; // exists, just not ours to signal — still alive
    }
}

// True if ANOTHER live tray owns the PID file right now.
function otherInstanceRunning() {
    let existingPid = null;
    let ageMs = Infinity;
    try {
        existingPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
        ageMs = Date.now() - fs.statSync(PID_FILE).mtimeMs;
    } catch { /* no PID file yet — first run, or a cleared one */ }

    return !!(existingPid && existingPid !== process.pid && isProcessAlive(existingPid) && ageMs < HEARTBEAT_STALE_MS);
}

function writePidFile() {
    try {
        fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
    } catch (error) {
        appendLog(`[TRAY] Could not write .tray.pid: ${error.message}\n`);
    }
}

function removeOwnPidFile() {
    try {
        if (parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10) === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
}

// Waits briefly for a previous copy to go away (e.g. the Dashboard's logout
// relaunches the app and the old process is still exiting), then reports
// whether another copy is genuinely still running.
async function anotherCopyIsRunning() {
    const deadline = Date.now() + 3000;
    while (otherInstanceRunning()) {
        if (Date.now() > deadline) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
}

function claimSingleInstance() {
    writePidFile();
    setInterval(writePidFile, HEARTBEAT_MS); // heartbeat: keeps the mtime fresh while we run
    process.on("exit", removeOwnPidFile);
}

async function main() {
    if (await anotherCopyIsRunning()) {
        appendLog(`\n[TRAY] Another copy is already running — exiting this extra launch — ${new Date().toISOString()}\n`);
        showMessageBox("Spidx Uploader", "Spidx Uploader is already running — check your system tray.");
        // The keep-alive interval at the top of this file would otherwise leave
        // this extra process alive (invisible) forever. Give the message box a
        // moment to spawn, then exit for real.
        setTimeout(() => process.exit(0), 500);
        return;
    }
    claimSingleInstance();

    appendLog(`\n[TRAY] Launcher started — ${new Date().toISOString()}\n`);

    // Make sure the Discord "Activate" button (spidx://activate?code=...)
    // opens THIS copy of the app, even when it runs from a plain folder
    // instead of the installer. Idempotent; never blocks startup.
    try {
        const { ensureProtocolRegistered } = require("./protocol-register.js");
        ensureProtocolRegistered(msg => appendLog(`[TRAY] ${msg}\n`));
    } catch (error) {
        appendLog(`[TRAY] Could not register spidx:// link: ${error.message}\n`);
    }

    trayAvailable = await startTrayIcon();
    if (!trayAvailable) {
        console.error("[TRAY] No tray icon this session — the helper runs anyway. Details are in helper.log.");
    }

    // First run (no saved Google login yet) — walk through the setup
    // wizard in a full browser tab before ever starting server.js, so
    // the helper never runs with an unconfigured account. On every
    // later start, the token already exists and this is skipped
    // entirely — normal startup, same as before.
    let skipWizard = false;
    if (fs.existsSync(SKIP_WIZARD_MARKER)) {
        skipWizard = true;
        try { fs.unlinkSync(SKIP_WIZARD_MARKER); } catch {}
        appendLog(`[TRAY] Skipping the first-run wizard (this is a post-logout relaunch, not a fresh install) — ${new Date().toISOString()}\n`);
    }

    if (!skipWizard && !fs.existsSync(GOOGLE_TOKEN_FILE)) {
        appendLog(`[TRAY] First run detected — launching the setup wizard — ${new Date().toISOString()}\n`);
        try {
            const wizard = require("./setup-wizard.js");
            await wizard.runSetupWizard(msg => appendLog(`[TRAY][Setup] ${msg}\n`));
        } catch (error) {
            appendLog(`[TRAY] Setup wizard failed, starting normally: ${error.message}\n`);
        }
    }

    startHelper();

    // Update check: doesn't block startup, and checkForUpdate() has its
    // own on-disk daily cache, so this call (and the repeating one below)
    // usually just reads that cache instead of hitting the network.
    async function refreshUpdateInfo() {
        try {
            const { checkForUpdate } = require("./update-check.js");
            updateInfo = await checkForUpdate();
            updateMenu();
        } catch (error) {
            appendLog(`[TRAY] Update check failed: ${error.message}\n`);
        }
        try {
            const { checkPluginUpdates } = require("./plugin-updates.js");
            pluginUpdateInfo = await checkPluginUpdates();
            updateMenu();
        } catch (error) {
            appendLog(`[TRAY] Plugin update check failed: ${error.message}\n`);
        }
    }
    refreshUpdateInfo();
    setInterval(refreshUpdateInfo, 6 * 60 * 60 * 1000); // re-check a few times a day; the module itself only actually calls GitHub once every 24h

    // The engine (server.js) writes .engine-status.json on its own —
    // e.g. once Google sign-in + the tier check finish, a few seconds
    // after startup — with no way to directly tell the tray "refresh
    // now". Without this, the menu only updates in response to clicking
    // something in the tray itself, so it can sit showing a stale
    // destination/tier (like Drive still grayed out right after a tier
    // upgrade) until the next unrelated click. A cheap periodic refresh
    // avoids that.
    if (trayAvailable) setInterval(updateMenu, 4000);
    setInterval(checkPendingLicenseCode, 4000);
    checkPendingLicenseCode(); // also catch a code dropped just before this process started

    console.log("[TRAY] Ready — helper running" + (trayAvailable ? " (tray icon active)." : " (no tray icon)."));
}

process.on("SIGINT", () => {
    stopHelper();
    process.exit(0);
});

main().catch(error => {
    const line = `[TRAY] Startup failed: ${error && error.stack ? error.stack : error}\n`;
    console.error(line);
    try { appendLog(line); } catch {}
    // Last resort: the icon/menu may be gone, but the uploader itself can
    // still work, so start it rather than leaving the user with nothing.
    try { startHelper(); } catch {}
});
