"use strict";

/* ========================================================================
 *  UPIA (Unified Plugin Installer Agent)
 *
 *  Adobe's own command-line tool for installing/removing packaged UXP
 *  plugins (.ccx files) -- the Photoshop-panel equivalent of what the
 *  CEP-AE / CEP-PPRO .bat installers do for After Effects and Premiere
 *  Pro. It ships as part of the Creative Cloud desktop app, not as
 *  something Spidx Uploader bundles, so every function here can fail
 *  simply because CCD isn't installed on this machine -- that's a normal,
 *  expected outcome, not a bug, and callers should show it as such.
 *
 *  Shared between setup-wizard.js and dashboard.js so both "Install the
 *  Photoshop panel" buttons behave identically.
 * ==================================================================== */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// Checked at both possible Common Files locations because Adobe's own
// components can land in the 32-bit Common Files folder on a machine
// even when Photoshop itself is 64-bit.
const CANDIDATE_PATHS = [
    path.join(process.env["CommonProgramFiles"] || "C:\\Program Files\\Common Files",
        "Adobe", "Adobe Desktop Common", "RemoteComponents", "UPI",
        "UnifiedPluginInstallerAgent", "UnifiedPluginInstallerAgent.exe"),
    path.join(process.env["CommonProgramFiles(x86)"] || "C:\\Program Files (x86)\\Common Files",
        "Adobe", "Adobe Desktop Common", "RemoteComponents", "UPI",
        "UnifiedPluginInstallerAgent", "UnifiedPluginInstallerAgent.exe")
];

function getUpiaPath() {
    for (const p of CANDIDATE_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Same "wait for spawn/error, but don't hang forever" pattern as
// spawnBatFile() in setup-wizard.js / dashboard.js -- UPIA runs and
// exits quickly (it's not an interactive console window like the CEP
// .bat installers), so the timeout here is shorter.
function runUpia(args, log, cb) {
    const upiaPath = getUpiaPath();
    if (!upiaPath) {
        cb(false, "Creative Cloud desktop app (which provides the Photoshop plugin installer) was not found on this computer.");
        return;
    }
    let done = false;
    const finish = (ok, message) => {
        if (done) return;
        done = true;
        cb(ok, message);
    };
    try {
        const child = spawn(upiaPath, args, { windowsHide: true, detached: true });
        let stderr = "";
        child.stderr && child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.once("spawn", () => finish(true, null));
        child.once("error", err => {
            log(`Could not start UPIA: ${err.message}`);
            finish(false, err.message);
        });
        child.on("exit", code => log(`UPIA ${args[0]} exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ""}.`));
        child.unref();
        setTimeout(() => finish(true, null), 1200);
    } catch (err) {
        finish(false, err.message);
    }
}

function installCcx(ccxPath, log, cb) {
    if (!fs.existsSync(ccxPath)) {
        cb(false, "The Photoshop panel (.ccx) was not found next to the App folder.");
        return;
    }
    log(`Installing Photoshop panel via UPIA from "${ccxPath}".`);
    runUpia(["/install", ccxPath], log, cb);
}

function removeCcx(pluginId, log, cb) {
    log(`Removing Photoshop panel via UPIA (id "${pluginId}").`);
    runUpia(["/remove", pluginId], log, cb);
}

// Unlike installCcx/removeCcx (fire-and-forget: we only care that Windows
// accepted the request), this needs the real stdout -- "/list all" prints
// every installed CEP/UXP plugin, one per line, and this just checks
// whether our plugin id shows up in it. That's the only reliable way to
// know if the Photoshop panel is actually installed, since a .ccx sitting
// next to the App folder and UPIA being present (what readPluginStatus()
// used to check) say nothing about whether /install actually succeeded
// or was ever run.
function listInstalled(pluginId, log, cb) {
    const upiaPath = getUpiaPath();
    if (!upiaPath) {
        cb(null, "Creative Cloud desktop app not found.");
        return;
    }
    let done = false;
    const finish = (installed, message) => {
        if (done) return;
        done = true;
        cb(installed, message);
    };
    try {
        const child = spawn(upiaPath, ["/list", "all"], { windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout && child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr && child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.once("error", err => {
            log(`Could not run UPIA /list: ${err.message}`);
            finish(null, err.message);
        });
        child.once("close", code => {
            if (code !== 0) {
                log(`UPIA /list all exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ""}.`);
                finish(null, stderr || `exit code ${code}`);
                return;
            }
            // Log the raw output every time, not just on failure — this is
            // the only way to see the real format UPIA prints (name vs id
            // vs GUID) if the substring match below turns out wrong.
            log(`UPIA /list all output:\n${stdout.trim() || "(empty)"}`);
            finish(stdout.toLowerCase().indexOf(pluginId.toLowerCase()) !== -1, null);
        });
        // /list all is a quick, synchronous-ish query (not an installer
        // window) -- if it hasn't closed in 5s something's wrong, don't
        // hang the Dashboard's status check forever.
        setTimeout(() => finish(null, "UPIA /list timed out."), 5000);
    } catch (err) {
        finish(null, err.message);
    }
}

module.exports = { getUpiaPath, installCcx, removeCcx, listInstalled };
