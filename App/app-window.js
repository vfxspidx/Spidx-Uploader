"use strict";

/* Opens a page in a small app-style window (Edge or Chrome in --app mode: no tabs, no address bar) when one is
 * installed, otherwise lets the caller fall back to the normal browser. Used by the Updater window and the
 * setup wizard. */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function findAppBrowser() {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    const candidates = [
        path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        local && path.join(local, "Google", "Chrome", "Application", "chrome.exe")
    ].filter(Boolean);
    return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/**
 * @param fallback  function(url) called when no app-capable browser exists or it fails to start
 */
function openAppWindow(url, width, height, log, fallback) {
    const say = typeof log === "function" ? log : () => {};
    const exe = findAppBrowser();
    if (!exe) { if (fallback) fallback(url); return; }
    try {
        // its own profile folder: an already running Edge/Chrome would otherwise swallow --app and ignore the size
        const profile = path.join(process.env.LOCALAPPDATA || require("os").tmpdir(), "Spidx Uploader", "app-window-profile");
        const child = spawn(exe, [`--app=${url}`, `--window-size=${width},${height}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore" });
        child.on("error", err => { say(`Could not open the app window (${err.message}) - using the browser.`); if (fallback) fallback(url); });
        child.unref();
    } catch (err) {
        say(`Could not open the app window (${err.message}) - using the browser.`);
        if (fallback) fallback(url);
    }
}

module.exports = { openAppWindow, findAppBrowser };
