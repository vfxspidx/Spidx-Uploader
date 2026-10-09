"use strict";

/* ========================================================================
 *  Global shortcut manager (the "send frame from the active program" keys).
 *
 *  Hotkey\SpidxHotkey.cs is a tiny background program that registers the
 *  system-wide shortcuts. This module (used by the tray app):
 *    - compiles it with csc.exe on first use (ships with Windows, no Visual Studio),
 *    - starts it with the shortcuts from helper-config.json ("hotkey": {...}),
 *    - restarts / stops it within ~5 s when those settings change,
 *    - restarts it if it dies (bounded, so a broken setup can't loop forever).
 *
 *  Settings (helper-config.json):
 *      "hotkey": { "enabled": true, "send": "Ctrl+Alt+U", "sendPs": "Ctrl+Alt+Shift+U" }
 *  It is a FREE feature.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const APP_DIR = __dirname;
const HOTKEY_DIR = path.join(APP_DIR, "..", "Hotkey");
const SOURCE_FILE = path.join(HOTKEY_DIR, "SpidxHotkey.cs");
const CONFIG_FILE = path.join(APP_DIR, "helper-config.json");
const INCOMING_DIR = path.join(APP_DIR, "incoming");

const DEFAULTS = { enabled: true, send: "Ctrl+Alt+U", sendPs: "Ctrl+Alt+Shift+U" };
const CONFIG_POLL_MS = 5000;
const MAX_RESTARTS = 5;                 // within RESTART_WINDOW_MS
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const EXIT_ALREADY_RUNNING = 3;         // the program's own "one copy only" exit code

function exePath() {
    return process.env.SPIDX_HOTKEY_EXE || path.join(HOTKEY_DIR, "SpidxHotkey.exe");
}

/* ------------------------- combos (mirror of HotkeyLogic.TryParseCombo) ------------------------- */

const NAMED_KEYS = ["space", "tab", "enter", "insert", "delete", "home", "end", "pageup", "pagedown", "left", "up", "right", "down", "printscreen"];
const NAMED_DISPLAY = { pageup: "PageUp", pagedown: "PageDown", printscreen: "PrintScreen" };

// "ctrl + alt + u" -> "Ctrl+Alt+U"; null when it is not a usable shortcut
// (needs at least one modifier and exactly one key).
function normalizeCombo(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const mods = { ctrl: false, alt: false, shift: false, win: false };
    let key = null;
    for (const raw of text.split("+")) {
        const part = raw.trim();
        if (!part) return null;
        const lower = part.toLowerCase();
        if (lower === "ctrl" || lower === "control") { mods.ctrl = true; continue; }
        if (lower === "alt") { mods.alt = true; continue; }
        if (lower === "shift") { mods.shift = true; continue; }
        if (lower === "win" || lower === "windows" || lower === "meta") { mods.win = true; continue; }
        if (key) return null;                                   // two keys
        if (/^[a-z]$/i.test(part)) key = part.toUpperCase();
        else if (/^[0-9]$/.test(part)) key = part;
        else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) key = part.toUpperCase();
        else if (NAMED_KEYS.includes(lower)) key = NAMED_DISPLAY[lower] || lower.charAt(0).toUpperCase() + lower.slice(1);
        else return null;
    }
    if (!key || !(mods.ctrl || mods.alt || mods.shift || mods.win)) return null;
    return [mods.ctrl && "Ctrl", mods.alt && "Alt", mods.shift && "Shift", mods.win && "Win", key].filter(Boolean).join("+");
}

function sanitizeHotkey(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const cfg = {
        enabled: r.enabled !== false,
        send: normalizeCombo(r.send) || DEFAULTS.send,
        sendPs: normalizeCombo(r.sendPs) || DEFAULTS.sendPs
    };
    if (cfg.send === cfg.sendPs) cfg.sendPs = cfg.send === DEFAULTS.sendPs ? DEFAULTS.send : DEFAULTS.sendPs;   // two actions can't share one shortcut
    return cfg;
}

function readHotkeyConfig() {
    try { return sanitizeHotkey(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).hotkey); }
    catch { return sanitizeHotkey(null); }
}

/* ------------------------------------ building ------------------------------------ */

function findCsc() {
    if (process.env.SPIDX_CSC) return process.env.SPIDX_CSC;
    const win = process.env.WINDIR || "C:\\Windows";
    for (const sub of ["Framework64", "Framework"]) {
        const p = path.join(win, "Microsoft.NET", sub, "v4.0.30319", "csc.exe");
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function needsBuild() {
    try {
        if (!fs.existsSync(exePath())) return true;
        return fs.statSync(exePath()).mtimeMs < fs.statSync(SOURCE_FILE).mtimeMs;
    } catch {
        return true;
    }
}

function build(log) {
    const csc = findCsc();
    if (!csc) return { ok: false, message: "csc.exe (the C# compiler that ships with .NET Framework 4.x) was not found." };
    if (!fs.existsSync(SOURCE_FILE)) return { ok: false, message: "Hotkey\\SpidxHotkey.cs is missing." };
    const result = spawnSync(csc, [
        "/nologo", "/utf8output", "/optimize+", "/target:winexe", "/out:" + exePath(),
        "/reference:System.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", SOURCE_FILE
    ], { encoding: "utf8", windowsHide: true });
    const output = ((result.stdout || "") + (result.stderr || "")).trim();
    if (result.error || result.status !== 0 || !fs.existsSync(exePath())) {
        return { ok: false, message: output || (result.error && result.error.message) || "unknown compiler error" };
    }
    log("Global shortcut program built.");
    return { ok: true };
}

/* ------------------------------------ running ------------------------------------ */

let child = null;
let runningKey = "";
let restartTimes = [];
let lastError = null;
let configTimer = null;

function configKey(cfg) { return JSON.stringify(cfg); }

function spawnChild(cfg, log) {
    const args = ["--incoming", INCOMING_DIR, "--send", cfg.send, "--send-ps", cfg.sendPs, "--parent-pid", String(process.pid)];
    let proc;
    try {
        proc = spawn(exePath(), args, { windowsHide: true, stdio: "ignore" });
    } catch (err) {
        lastError = err.message;
        log(`Global shortcut program could not start: ${err.message}`);
        return;
    }
    child = proc;
    runningKey = configKey(cfg);
    lastError = null;
    log(`Global shortcut program started (${cfg.send} = Upload, ${cfg.sendPs} = Photoshop + Upload).`);

    proc.once("error", err => { lastError = err.message; log(`Global shortcut program error: ${err.message}`); if (child === proc) { child = null; runningKey = ""; } });
    proc.once("exit", code => {
        if (child === proc) { child = null; runningKey = ""; }
        if (proc.stoppedByUs) return;              // we stopped THIS process on purpose (per process: a newer one may already be running)
        if (code === EXIT_ALREADY_RUNNING) { log("Global shortcut program is already running (another copy) - leaving it alone."); runningKey = configKey(cfg); return; }
        const now = Date.now();
        restartTimes = restartTimes.filter(t => now - t < RESTART_WINDOW_MS);
        if (restartTimes.length >= MAX_RESTARTS) {
            lastError = "The global shortcut program keeps stopping - giving up until the app restarts.";
            log(lastError);
            return;
        }
        restartTimes.push(now);
        log(`Global shortcut program exited (code ${code}) - restarting.`);
        setTimeout(() => ensureRunning(log), 1500);
    });
}

function stop() {
    if (child) { child.stoppedByUs = true; try { child.kill(); } catch {} }
    child = null;
    runningKey = "";
}

// Makes reality match helper-config.json: builds if needed, (re)starts, or stops.
function ensureRunning(log = () => {}) {
    if (process.platform !== "win32" && !process.env.SPIDX_HOTKEY_EXE) return;   // Windows only (tests inject a fake program)

    const cfg = readHotkeyConfig();
    if (!cfg.enabled) { if (child) { stop(); log("Global shortcut turned off."); } return; }
    if (child && runningKey === configKey(cfg)) return;      // nothing changed
    if (child) { stop(); log("Global shortcut settings changed - restarting it."); }

    if (needsBuild()) {
        const built = build(log);
        if (!built.ok) {
            lastError = "Could not build the shortcut program: " + built.message;
            log(lastError);
            return;
        }
    }
    spawnChild(cfg, log);
}

function startManager(log = () => {}) {
    ensureRunning(log);
    clearInterval(configTimer);
    configTimer = setInterval(() => { try { ensureRunning(log); } catch (err) { log(`Global shortcut manager: ${err.message}`); } }, CONFIG_POLL_MS);
    if (configTimer.unref) configTimer.unref();
}

function stopManager() {
    clearInterval(configTimer);
    configTimer = null;
    stop();
}

function getState() {
    return { running: !!child, lastError, built: fs.existsSync(exePath()), supported: process.platform === "win32" };
}

module.exports = {
    DEFAULTS, normalizeCombo, sanitizeHotkey, readHotkeyConfig, needsBuild, build, ensureRunning,
    startManager, stopManager, stop, getState, exePath
};
