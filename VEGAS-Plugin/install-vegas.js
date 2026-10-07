"use strict";

/* ========================================================================
 *  Spidx Uploader - VEGAS Pro plugin installer / uninstaller
 *
 *  Run through "Install VEGAS Plugin.bat" / "Uninstall VEGAS Plugin.bat"
 *  (they elevate and call this with `install` or `uninstall`).
 *
 *  install:   finds your VEGAS Pro install(s) (ScriptPortal.Vegas.dll),
 *             compiles SpidxUploaderExtension.cs against it with the .NET
 *             Framework's csc.exe (ships with Windows - no Visual Studio),
 *             and copies the resulting SpidxUploader.dll into VEGAS's
 *             "Application Extensions" folder. Removes copies left in other
 *             Application Extensions folders (two copies would register the
 *             menu command twice). Seeds the panel's incoming folder.
 *  uninstall: deletes every SpidxUploader.dll it can find.
 *
 *  It records what it did in %APPDATA%\Spidx Uploader\vegas-install.json -
 *  the Dashboard reads that file to show "installed vX / update available".
 *
 *  Optional: --vegas-dir "<folder containing ScriptPortal.Vegas.dll>"
 *  (Test overrides: SPIDX_VEGAS_ROOTS, SPIDX_PROGRAMDATA, SPIDX_CSC.)
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const PLUGIN_DIR = __dirname;
const SOURCE_CS = path.join(PLUGIN_DIR, "SpidxUploaderExtension.cs");
const VERSION_FILE = path.join(PLUGIN_DIR, "version.txt");
const DLL_NAME = "SpidxUploader.dll";
const API_DLL = "ScriptPortal.Vegas.dll";

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const RECORD_DIR = path.join(APPDATA, "Spidx Uploader");
const RECORD_FILE = path.join(RECORD_DIR, "vegas-install.json");
const PANEL_CONFIG_FILE = path.join(RECORD_DIR, "vegas-panel-config.json");
const PROJECT_INCOMING = path.resolve(PLUGIN_DIR, "..", "App", "incoming");

function say(text) { console.log("  " + text); }
function blank() { console.log(""); }

function readVersion() {
    try { return fs.readFileSync(VERSION_FILE, "utf8").trim() || "0.0.0"; } catch { return "0.0.0"; }
}

function samePath(a, b) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function uniquePaths(list) {
    const seen = new Set();
    const out = [];
    for (const p of list) {
        const key = path.resolve(p).toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(p); }
    }
    return out;
}

function subDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
    } catch { return []; }
}

function vegasIsRunning() {
    if (process.platform !== "win32" || process.env.SPIDX_SKIP_PROCESS_CHECK) return false;
    try {
        const res = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
        return /^"vegas[^"]*\.exe"/im.test(res.stdout || "");
    } catch { return false; }
}

function installRoots() {
    if (process.env.SPIDX_VEGAS_ROOTS) return process.env.SPIDX_VEGAS_ROOTS.split(path.delimiter).filter(Boolean);
    const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter(Boolean);
    const vendors = ["BorisFX", "VEGAS", "MAGIX", "Sony", "Boris FX"];
    const roots = [];
    for (const base of pf) for (const v of vendors) roots.push(path.join(base, v));
    return uniquePaths(roots);
}

// A VEGAS install = a folder that contains ScriptPortal.Vegas.dll, up to
// two levels below the vendor folder (e.g. BorisFX\Vegas Pro 2026\).
function findVegasInstalls(extraDir) {
    const found = [];
    const check = dir => {
        const dll = path.join(dir, API_DLL);
        if (fs.existsSync(dll)) found.push({ dir, dll, mtime: fs.statSync(dll).mtimeMs });
    };
    if (extraDir) check(extraDir);
    for (const root of installRoots()) {
        check(root);
        for (const l1 of subDirs(root)) {
            check(l1);
            for (const l2 of subDirs(l1)) check(l2);
        }
    }
    const unique = [];
    for (const f of found) if (!unique.some(u => samePath(u.dir, f.dir))) unique.push(f);
    return unique.sort((a, b) => b.mtime - a.mtime); // newest first
}

function programDataRoots() {
    const pd = process.env.SPIDX_PROGRAMDATA || process.env.ProgramData || "C:\\ProgramData";
    return uniquePaths(["Vegas Pro", "VEGAS Pro", "VEGAS", "BorisFX", "MAGIX", "Sony"].map(n => path.join(pd, n)));
}

function findExtensionDirsUnder(root, depth) {
    const out = [];
    const walk = (dir, level) => {
        for (const d of subDirs(dir)) {
            if (path.basename(d).toLowerCase() === "application extensions") out.push(d);
            else if (level < depth) walk(d, level + 1);
        }
    };
    walk(root, 1);
    return out;
}

function existingProgramDataExtensionDirs() {
    const out = [];
    for (const root of programDataRoots()) out.push(...findExtensionDirsUnder(root, 4));
    return uniquePaths(out);
}

function readRecord() {
    try { return JSON.parse(fs.readFileSync(RECORD_FILE, "utf8")); } catch { return null; }
}

function writeRecord(data) {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    fs.writeFileSync(RECORD_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Every folder a copy of the plugin could be sitting in.
function allKnownExtensionDirs(installs) {
    const dirs = [...existingProgramDataExtensionDirs()];
    for (const i of installs) dirs.push(path.join(i.dir, "Application Extensions"));
    const rec = readRecord();
    if (rec && Array.isArray(rec.dlls)) for (const d of rec.dlls) dirs.push(path.dirname(d));
    return uniquePaths(dirs);
}

function tryDelete(file) {
    try {
        if (!fs.existsSync(file)) return "none";
        fs.unlinkSync(file);
        return "deleted";
    } catch (err) {
        return "failed:" + err.message;
    }
}

function findCsc() {
    if (process.env.SPIDX_CSC) return process.env.SPIDX_CSC;
    const win = process.env.WINDIR || "C:\\Windows";
    for (const sub of ["Framework64", "Framework"]) {
        const p = path.join(win, "Microsoft.NET", sub, "v4.0.30319", "csc.exe");
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function compile(csc, apiDll) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "spidx-vegas-"));
    const outDll = path.join(outDir, DLL_NAME);
    const args = [
        "/nologo", "/optimize+", "/target:library", "/out:" + outDll,
        "/reference:" + apiDll,
        "/reference:System.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
        "/reference:System.Web.Extensions.dll", "/reference:System.Core.dll",
        SOURCE_CS
    ];
    const res = spawnSync(csc, args, { encoding: "utf8", windowsHide: true });
    const output = ((res.stdout || "") + (res.stderr || "")).trim();
    if (res.error || res.status !== 0 || !fs.existsSync(outDll)) {
        return { ok: false, output: output || (res.error && res.error.message) || "unknown compiler error" };
    }
    return { ok: true, dll: outDll, output };
}

// First use of the panel asks for the incoming folder; pre-fill it with this
// install's App\incoming so it works out of the box.
function seedPanelConfig() {
    try {
        if (!fs.existsSync(path.dirname(PROJECT_INCOMING))) return;
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(PANEL_CONFIG_FILE, "utf8")) || {}; } catch {}
        if (cfg.incomingFolder) return;
        fs.mkdirSync(PROJECT_INCOMING, { recursive: true });
        cfg.incomingFolder = PROJECT_INCOMING;
        fs.mkdirSync(RECORD_DIR, { recursive: true });
        fs.writeFileSync(PANEL_CONFIG_FILE, JSON.stringify(cfg), "utf8");
        say("Panel incoming folder set to: " + PROJECT_INCOMING);
    } catch { /* optional convenience only */ }
}

function argValue(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}

function install() {
    const extraDir = argValue("--vegas-dir");
    say("Looking for VEGAS Pro...");
    const installs = findVegasInstalls(extraDir);
    if (installs.length === 0) {
        blank();
        say("VEGAS Pro was not found (looked for " + API_DLL + " under Program Files\\BorisFX, \\VEGAS, \\MAGIX, \\Sony).");
        say("Install VEGAS Pro first, or run:");
        say('  node install-vegas.js install --vegas-dir "<folder that contains ' + API_DLL + '>"');
        return 1;
    }
    const target = installs[0];
    say("Using VEGAS install: " + target.dir);

    if (vegasIsRunning()) {
        blank();
        say("VEGAS is running. Close it first (it locks the extension file), then run this again.");
        return 1;
    }

    const csc = findCsc();
    if (!csc) {
        blank();
        say("csc.exe (the C# compiler that ships with .NET Framework 4.x) was not found.");
        say("Install the \".NET Framework 4.8 Developer Pack\" from Microsoft and try again.");
        return 1;
    }
    if (!fs.existsSync(SOURCE_CS)) {
        say("SpidxUploaderExtension.cs is missing next to this script.");
        return 1;
    }

    say("Building the plugin (a few seconds)...");
    const built = compile(csc, target.dll);
    if (!built.ok) {
        blank();
        say("Build FAILED:");
        console.log(built.output.split(/\r?\n/).map(l => "    " + l).join("\n"));
        blank();
        say("Please send this text to Spidx support.");
        return 1;
    }

    // Where VEGAS reads extensions from: an existing ProgramData folder if there is
    // one (that's where earlier manual installs usually live), otherwise the
    // install folder's own "Application Extensions".
    const programDataDirs = existingProgramDataExtensionDirs();
    const targets = programDataDirs.length > 0 ? programDataDirs : [path.join(target.dir, "Application Extensions")];

    const copied = [];
    for (const dir of targets) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, DLL_NAME);
            fs.copyFileSync(built.dll, dest);
            copied.push(dest);
            say("Installed: " + dest);
        } catch (err) {
            say("Could not write to " + dir + " - " + err.message);
        }
    }
    try { fs.rmSync(path.dirname(built.dll), { recursive: true, force: true }); } catch {}

    if (copied.length === 0) {
        blank();
        say("Install FAILED - no extension folder was writable. Run this as administrator.");
        return 1;
    }

    // Remove stray copies elsewhere so the menu command isn't registered twice.
    for (const dir of allKnownExtensionDirs(installs)) {
        if (targets.some(t => samePath(t, dir))) continue;
        const result = tryDelete(path.join(dir, DLL_NAME));
        if (result === "deleted") say("Removed an old copy from: " + dir);
        else if (result.startsWith("failed")) say("Could not remove an old copy in " + dir + " (" + result.slice(7) + ")");
    }

    writeRecord({
        version: readVersion(),
        installedAt: new Date().toISOString(),
        vegasDir: target.dir,
        dlls: copied
    });
    seedPanelConfig();

    blank();
    say("Done (version " + readVersion() + "). Start VEGAS and open:");
    say("    View > Extensions > Spidx Uploader");
    return 0;
}

function uninstall() {
    if (vegasIsRunning()) {
        say("VEGAS is running. Close it first, then run this again.");
        return 1;
    }
    const installs = findVegasInstalls(argValue("--vegas-dir"));
    let removed = 0;
    let failed = 0;
    for (const dir of allKnownExtensionDirs(installs)) {
        const file = path.join(dir, DLL_NAME);
        const result = tryDelete(file);
        if (result === "deleted") { say("Removed: " + file); removed++; }
        else if (result.startsWith("failed")) { say("Could not remove " + file + " - " + result.slice(7)); failed++; }
    }
    if (failed === 0) { try { fs.unlinkSync(RECORD_FILE); } catch {} }
    blank();
    if (failed > 0) { say("Some files could not be removed - run as administrator and make sure VEGAS is closed."); return 1; }
    say(removed > 0 ? "Done. The plugin is removed from VEGAS." : "Nothing was installed.");
    return 0;
}

const mode = process.argv[2];
let code = 1;
try {
    if (mode === "install") code = install();
    else if (mode === "uninstall") code = uninstall();
    else say("Usage: node install-vegas.js install|uninstall [--vegas-dir <folder>]");
} catch (err) {
    blank();
    say("Unexpected error: " + (err && err.stack ? err.stack : err));
}
process.exit(code);
