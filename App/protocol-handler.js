"use strict";

/* ========================================================================
 *  spidx:// deep-link handler
 *
 *  Windows invokes this (via protocol-handler.bat, registered in
 *  Installer\SpidxUploader.iss) when someone clicks a spidx:// link — the
 *  Discord bot sends spidx://activate?code=XXXX-XXXX-XXXX alongside a
 *  license code (see CommandHandler.java's handleSendCode()).
 *
 *  This process is short-lived: it only extracts the code, drops it where
 *  the long-running tray process will find it, and makes sure that tray
 *  process is actually up. tray.js (checkPendingLicenseCode(), polled the
 *  same way as updateMenu()) does the real work — reading the file,
 *  calling license-actions.js, and reporting the result — since it's the
 *  process that's already signed in to Google and already has a tray icon
 *  to pop a message box from.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const APP_DIR = __dirname;
const ROOT_DIR = path.dirname(APP_DIR);
const ENGINE_STATUS_FILE = path.join(APP_DIR, "incoming", ".engine-status.json");
const PENDING_CODE_FILE = path.join(APP_DIR, ".pending-license-code");
const VBS_LAUNCHER = path.join(ROOT_DIR, "Spidx Uploader.vbs");

// server.js re-stamps ENGINE_STATUS_FILE every 15s while it's alive (see
// server.js's own comment on that heartbeat) — a recent mtime is a good
// enough signal that tray.js (which spawns server.js as its child) is
// already running, without needing a dedicated lock file.
const HEARTBEAT_FRESH_MS = 25000;

function isHelperLikelyRunning() {
    try {
        const stat = fs.statSync(ENGINE_STATUS_FILE);
        return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
    } catch {
        return false;
    }
}

function main() {
    const raw = process.argv[2] || "";
    let code = null;
    try {
        const uri = new URL(raw);
        if (uri.protocol === "spidx:") code = uri.searchParams.get("code");
    } catch {
        // Not a valid spidx:// URI — nothing sane to do, just exit quietly.
    }

    if (!code || !code.trim()) return;
    code = code.trim().toUpperCase();

    try {
        fs.writeFileSync(PENDING_CODE_FILE, code, "utf8");
    } catch (err) {
        // Can't hand the code off to tray.js at all — nothing more this
        // short-lived process can usefully do.
        console.error("Could not write pending license code:", err.message);
        return;
    }

    if (isHelperLikelyRunning()) return; // tray.js's own poll will pick it up within a few seconds

    // Not running yet — start it the same way the desktop shortcut does.
    // tray.js checks for a pending code once at startup too (not just on
    // its interval), so this still activates automatically once it's up.
    try {
        const launcher = spawn("wscript.exe", [VBS_LAUNCHER], { detached: true, stdio: "ignore", windowsHide: true });
        launcher.on("error", err => console.error("Could not start Spidx Uploader:", err.message));
        launcher.unref();
    } catch (err) {
        console.error("Could not start Spidx Uploader:", err.message);
    }
}

main();
