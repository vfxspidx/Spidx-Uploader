"use strict";

/* ========================================================================
 *  UPIA (Unified Plugin Installer Agent) - read-only helpers
 *
 *  Installing / removing the Photoshop panel is done by the elevated
 *  scripts UXP\Install PS Panel.bat and UXP\Uninstall PS Panel.bat - they
 *  run Adobe's UnifiedPluginInstallerAgent.exe as Administrator, exactly
 *  like typing the command in an Administrator Command Prompt. (Run without
 *  admin rights, UPIA rejects the .ccx with errors such as status = -432.)
 *
 *  What stays here is only what works fine WITHOUT admin rights:
 *    getUpiaPath()      where Adobe's installer lives (Creative Cloud needed)
 *    listInstalled()    "/list all" -> is the panel installed under Photoshop?
 *    readCcxVersion()   the version inside the bundled .ccx
 *
 *  "/list all" groups plugins per Adobe app, like:
 *      4 extensions installed for After Effects (ver 26.5.0)
 *      Status    Extension Name    Version
 *      =======   ===============   =======
 *      ...rows...
 *      2 extensions installed for Photoshop (ver 27.x)
 *      ...rows...
 *  The After Effects CEP panel is ALSO called "Spidx Uploader", so matching
 *  the name anywhere in the output would wrongly report the Photoshop panel
 *  as installed. Rows are therefore only counted inside the Photoshop section.
 * ==================================================================== */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { readZip } = require("./zip-util.js");

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

const LIST_TIMEOUT_MS = 15 * 1000;

function getUpiaPath() {
    if (process.env.SPIDX_UPIA_PATH) return fs.existsSync(process.env.SPIDX_UPIA_PATH) ? process.env.SPIDX_UPIA_PATH : null; // tests
    for (const p of CANDIDATE_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// The version inside the bundled .ccx (its manifest.json), or null.
function readCcxVersion(ccxPath) {
    try {
        const entry = readZip(fs.readFileSync(ccxPath)).find(e => e.name === "manifest.json");
        return entry ? (JSON.parse(entry.data.toString("utf8")).version || null) : null;
    } catch {
        return null;
    }
}

const SECTION_HEADER = /^\s*\d+\s+extensions?\s+installed\s+for\s+(.+?)\s*(?:\(\s*ver[^)]*\))?\s*$/i;

// Finds the panel in "/list all" output - only inside the Photoshop section
// when the output is grouped per app (see the note at the top). If the output
// has no section headers at all (an unknown/older format), falls back to a
// whole-output match on the id or name.
function findPluginInList(stdout, pluginId, names) {
    const lines = String(stdout || "").split(/\r?\n/);
    const id = String(pluginId || "").toLowerCase();
    const wanted = (names || []).map(n => String(n).toLowerCase()).filter(Boolean);
    const matches = lower => (id && lower.indexOf(id) !== -1) || wanted.some(n => lower.indexOf(n) !== -1);

    const hasSections = lines.some(l => SECTION_HEADER.test(l));
    let currentApp = null;

    for (let i = 0; i < lines.length; i++) {
        const header = lines[i].match(SECTION_HEADER);
        if (header) { currentApp = header[1].toLowerCase(); continue; }
        if (!matches(lines[i].toLowerCase())) continue;
        if (hasSections && !(currentApp && currentApp.indexOf("photoshop") !== -1)) continue; // e.g. the AE panel

        let version = null;
        const lookahead = lines.slice(i, i + 4);
        for (const l of lookahead) {
            const labelled = l.match(/version\D{0,4}(\d+(?:\.\d+){1,3})/i);
            if (labelled) { version = labelled[1]; break; }
        }
        if (!version) {
            const loose = lines[i].match(/\b(\d+\.\d+(?:\.\d+){0,2})\b/);
            if (loose) version = loose[1];
        }
        return { installed: true, version };
    }
    return { installed: false, version: null };
}

// cb(installed: true|false|null, message, info?) - null = couldn't find out.
// Works without admin rights.
function listInstalled(pluginId, log, cb, opts) {
    const names = (opts && opts.names) || [];
    const upiaPath = getUpiaPath();
    if (!upiaPath) { cb(null, "Creative Cloud desktop app not found."); return; }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (installed, message, info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cb(installed, message, info);
    };

    let child;
    try {
        // stdin closed so a prompting UPIA can't hang the check
        child = spawn(upiaPath, ["/list", "all"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
        finish(null, err.message);
        return;
    }
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", err => { log(`Could not run UPIA /list: ${err.message}`); finish(null, err.message); });
    child.once("close", code => {
        if (code !== 0) {
            log(`UPIA /list all exited with code ${code}${stderr ? ` - ${stderr.trim()}` : ""}.`);
            finish(null, stderr.trim() || `exit code ${code}`);
            return;
        }
        // The raw output is logged: it is the only way to see the real format.
        log(`UPIA /list all output:\n${stdout.trim() || "(empty)"}`);
        const found = findPluginInList(stdout, pluginId, names);
        finish(found.installed, null, { version: found.version });
    });
    timer = setTimeout(() => {
        try { child.kill(); } catch {}
        log("UPIA /list all timed out.");
        finish(null, "UPIA /list timed out.");
    }, LIST_TIMEOUT_MS);
}

module.exports = { getUpiaPath, listInstalled, readCcxVersion, findPluginInList };
