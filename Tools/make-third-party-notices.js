"use strict";

/* ========================================================================
 *  Builds THIRD-PARTY-NOTICES.txt - the list of third-party software that ships
 *  with Spidx Uploader, with each one's licence text (the EULA refers to this file).
 *
 *  Run it after changing the app's dependencies, on a WINDOWS-shaped install
 *  (the Windows build of sharp comes with libvips as separate DLLs):
 *      cd App
 *      npm install --omit=dev --ignore-scripts
 *      cd ..\Tools
 *      node make-third-party-notices.js
 *  (on another OS add  --os=win32 --cpu=x64  to the npm command so the Windows
 *  packages are the ones listed). Options:  --app <App folder>  --out <file>
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function arg(name, fallback) { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }
const APP = path.resolve(arg("--app", path.join(__dirname, "..", "App")));
const OUT = path.resolve(arg("--out", path.join(__dirname, "..", "THIRD-PARTY-NOTICES.txt")));
const ROOT = path.join(APP, "node_modules");
if (!fs.existsSync(ROOT)) { console.error("No node_modules in " + APP + " - run npm install --omit=dev first."); process.exit(1); }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// every real package folder: node_modules/<name> or node_modules/@scope/<name>, at any depth
function* packageDirs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".bin") continue;
        const full = path.join(dir, entry.name);
        if (entry.name.startsWith("@")) { for (const sub of fs.readdirSync(full, { withFileTypes: true })) if (sub.isDirectory()) yield path.join(full, sub.name); }
        else yield full;
    }
}
function collect(dir, out) {
    for (const pkgDir of packageDirs(dir)) {
        const pkg = readJson(path.join(pkgDir, "package.json"));
        if (pkg && pkg.name && pkg.version) {
            let lic = pkg.license || pkg.licenses;
            if (lic && typeof lic === "object" && !Array.isArray(lic)) lic = lic.type;
            if (Array.isArray(lic)) lic = lic.map(x => (x && x.type) || String(x)).join(" OR ");
            let repo = pkg.repository && (typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url);
            repo = String(repo || pkg.homepage || "").replace(/^git\+/, "").replace(/\.git$/, "");
            const names = fs.readdirSync(pkgDir).filter(n => /^(licen[sc]e|copying|notice)/i.test(n) && fs.statSync(path.join(pkgDir, n)).isFile()).sort();
            const licFile = names.find(n => /^licen[sc]e/i.test(n)) || names[0];
            const text = licFile ? fs.readFileSync(path.join(pkgDir, licFile), "utf8").replace(/\r\n/g, "\n").trim() : null;
            out.set(pkg.name + "@" + pkg.version, { name: pkg.name, version: pkg.version, license: lic || "UNKNOWN", repo, text });
        }
        const nested = path.join(pkgDir, "node_modules");
        if (fs.existsSync(nested)) collect(nested, out);
    }
}
const found = new Map();
collect(ROOT, found);
const items = [...found.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.version.localeCompare(b.version));

// licence texts shared by several packages are written once
const groups = new Map();
for (const it of items) {
    const key = it.text ? crypto.createHash("sha1").update(it.text).digest("hex") : "none:" + it.license;
    if (!groups.has(key)) groups.set(key, { text: it.text, license: it.license, members: [] });
    groups.get(key).members.push(it);
}

const line = "=".repeat(78);
let o = "";
o += `SPIDX UPLOADER - THIRD-PARTY NOTICES\n${line}\n\n`;
o += "Spidx Uploader includes the third-party software listed below. Each component is\n";
o += "licensed under its own terms (not under the Spidx Uploader EULA); the licence texts\n";
o += "follow the list. Nothing in the EULA limits your rights under these licences.\n\n";
o += "Not distributed with Spidx Uploader, installed separately by you: Node.js, Google\n";
o += "Chrome / Microsoft Edge (or another browser used for uploads), Adobe applications\n";
o += "and VEGAS Pro. The Windows C# compiler used to build the helper programs is part of\n";
o += "Windows (.NET Framework).\n\n";
o += `${line}\n1. COMPONENTS (${items.length})\n${line}\n\n`;
for (const it of items) o += `${it.name} ${it.version}\n    licence: ${it.license}\n${it.repo ? "    source:  " + it.repo + "\n" : ""}`;
o += `\n${line}\n2. SPECIAL NOTES\n${line}\n\n`;
const vips = items.filter(i => /sharp-(win32|linux|darwin).*/.test(i.name) || /libvips/.test(i.name));
if (vips.length) {
    o += "libvips (image processing, used through sharp)\n";
    o += "  The Windows package " + vips.map(v => v.name + " " + v.version).join(", ") + " includes the libvips\n";
    o += "  library as SEPARATE, replaceable DLL files (libvips-42.dll, libvips-cpp.dll), licensed\n";
    o += "  under the GNU LGPL v3 or later. You may replace these DLLs with your own build of\n";
    o += "  libvips. Source code and the list of libraries bundled in the DLLs (versions.json in\n";
    o += "  that package): https://github.com/lovell/sharp-libvips and https://github.com/libvips/libvips\n\n";
    for (const v of vips) {
        const versions = readJson(path.join(ROOT, v.name, "versions.json"));
        if (versions) o += "  Bundled in " + v.name + ": " + Object.entries(versions).map(([k, x]) => k + " " + x).join(", ") + "\n\n";
    }
}
if (items.some(i => /systray/.test(i.name))) {
    o += "System tray helper (systray2)\n  Includes a small prebuilt tray program (traybin\\tray_windows_release.exe) written in Go;\n  see the package repository above for its source and licences.\n\n";
}
o += `${line}\n3. LICENCE TEXTS\n${line}\n`;
for (const g of groups.values()) {
    o += "\n" + "-".repeat(78) + "\n";
    o += "Applies to: " + g.members.map(m => m.name + " " + m.version).join(", ") + "\n";
    o += "Licence: " + g.license + "\n" + "-".repeat(78) + "\n\n";
    o += (g.text || "(This package does not ship a licence file. Its declared licence is " + g.license + "; see its repository for the full text.)") + "\n";
}
fs.writeFileSync(OUT, o.replace(/\n/g, "\r\n"), "utf8");   // Windows line endings: Notepad shows them correctly
console.log("Wrote " + OUT + " (" + items.length + " components, " + groups.size + " distinct licence texts, " + Math.round(o.length / 1024) + " KB)");
