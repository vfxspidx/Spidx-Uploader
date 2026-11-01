"use strict";
/*  Builds the folder you upload to the PRIVATE Google Drive folder of the Thumbnail Pack.
 *
 *      node Tools\make-pack-manifest.js            (reads Tools\pack-source, writes Tools\pack-upload)
 *      node Tools\make-pack-manifest.js <source> <output>
 *
 *  Source layout (what the panels expect to find, relative to the local pack folder):
 *      ae\templates\*.aep + templates.json     ae\presets\*.ffx + spt.json     ppro\mogrts\*.mogrt + mogrts.json + thumbs\*
 *
 *  Output: one FLAT folder (Drive folders are flat for the server) with every file under a unique name, plus
 *  pack.json: { version, items: [ { path, file, sha256, size } ] }. Upload ALL of it to the Drive folder whose id is the
 *  script property PACK_FOLDER_ID. Raise "version" in Tools\pack-source\pack-version.txt when the content changes.
 *  Tools\pack-source and Tools\pack-upload are the paid content: they must never go into the installer or the repository.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const SRC = path.resolve(process.argv[2] || path.join(TOOLS, "pack-source"));
const OUT = path.resolve(process.argv[3] || path.join(TOOLS, "pack-upload"));
const ALLOWED = ["ae/templates/", "ae/presets/", "ppro/mogrts/"];

function walk(dir, base) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const rel = (base ? base + "/" : "") + name;
        if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, rel));
        else out.push({ abs, rel });
    }
    return out;
}

if (!fs.existsSync(SRC)) { console.error("Source folder not found: " + SRC); process.exit(1); }
let version = 1;
try { version = Math.max(1, parseInt(fs.readFileSync(path.join(SRC, "pack-version.txt"), "utf8"), 10) || 1); } catch {}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const items = [];
const used = new Set();
for (const f of walk(SRC, "")) {
    if (!ALLOWED.some(p => f.rel.startsWith(p))) continue;                       // pack-version.txt and strays stay out
    if (/\.(tmp|bak)$/i.test(f.rel) || path.basename(f.rel).startsWith(".")) continue;
    const buf = fs.readFileSync(f.abs);
    if (buf.length > 25 * 1024 * 1024) { console.error("Too large (25 MB max): " + f.rel); process.exit(1); }
    // a flat, unique, Drive-friendly name:  ae/templates/IGN.aep -> ae__templates__IGN.aep
    let flat = f.rel.replace(/\//g, "__");
    if (used.has(flat.toLowerCase())) { console.error("Duplicate name: " + flat); process.exit(1); }
    used.add(flat.toLowerCase());
    fs.writeFileSync(path.join(OUT, flat), buf);
    items.push({ path: f.rel, file: flat, sha256: crypto.createHash("sha256").update(buf).digest("hex"), size: buf.length });
}
if (!items.length) { console.error("Nothing to pack in " + SRC); process.exit(1); }
fs.writeFileSync(path.join(OUT, "pack.json"), JSON.stringify({ version, items }, null, 1));
console.log(`Pack version ${version}: ${items.length} file(s) written to ${OUT}`);
for (const it of items) console.log("  " + it.path.padEnd(44) + (it.size / 1024).toFixed(0).padStart(6) + " KB");
console.log("\nNow upload EVERYTHING in that folder to the private Drive folder (PACK_FOLDER_ID), replacing the old files.");
