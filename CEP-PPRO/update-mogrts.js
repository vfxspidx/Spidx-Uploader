"use strict";

/* ========================================================================
 *  Updates mogrts/mogrts.json + mogrts/thumbs/ from the .mogrt files in mogrts/.
 *
 *  Drop a new .mogrt into the mogrts folder, run "Update MOGRT list.bat"
 *  (or:  node update-mogrts.js), then reinstall the panel. For every .mogrt it:
 *    - pulls the template's own preview picture (thumb.png inside the file)
 *      into mogrts/thumbs/<name>.png - the tile image in the panel - and its
 *      animated preview (thumb.mp4) next to it - played when hovering the tile,
 *    - adds a new entry to mogrts.json (name from the file name, category
 *      "Templates") or keeps your edited name / description / category,
 *    - drops entries whose .mogrt file no longer exists.
 *  Edit mogrts.json by hand afterwards to rename a template or put it in a
 *  category ("category": "Eliminations") - that is what the panel groups by.
 *  No dependencies (plain Node).
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DIR = path.join(__dirname, "mogrts");
const THUMBS = path.join(DIR, "thumbs");
const INDEX = path.join(DIR, "mogrts.json");

// Reads ONE entry out of a .zip (.mogrt files are zips). Handles stored + deflate.
function readZipEntry(buffer, wanted) {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a valid .mogrt (zip) file");
    const count = buffer.readUInt16LE(eocd + 10);
    let pos = buffer.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        const method = buffer.readUInt16LE(pos + 10);
        const compSize = buffer.readUInt32LE(pos + 20);
        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const localOffset = buffer.readUInt32LE(pos + 42);
        const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString("utf8");
        pos += 46 + nameLen + extraLen + commentLen;
        if (name !== wanted) continue;
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const raw = buffer.slice(dataStart, dataStart + compSize);
        return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    return null;
}

function prettyName(file) {
    return file.replace(/\.mogrt$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function main() {
    if (!fs.existsSync(DIR)) { console.log("No mogrts folder next to this script: " + DIR); return 1; }
    fs.mkdirSync(THUMBS, { recursive: true });

    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(INDEX, "utf8").replace(/^\uFEFF/, "")); } catch { existing = []; }
    if (!Array.isArray(existing)) existing = [];
    const byFile = {};
    existing.forEach(e => { if (e && e.file) byFile[e.file] = e; });

    const files = fs.readdirSync(DIR).filter(f => /\.mogrt$/i.test(f)).sort((a, b) => a.localeCompare(b));
    const out = [];
    const used = {};

    files.forEach(file => {
        const entry = Object.assign({}, byFile[file] || { file, name: prettyName(file), description: "", category: "Templates" });
        if (!byFile[file]) console.log("  + new template: " + file);
        if (!entry.category) entry.category = "Templates";

        let thumbName = file.replace(/\.mogrt$/i, ".png");
        try {
            const png = readZipEntry(fs.readFileSync(path.join(DIR, file)), "thumb.png");
            if (png) {
                fs.writeFileSync(path.join(THUMBS, thumbName), png);
                entry.thumb = "thumbs/" + thumbName;
            } else {
                console.log("  ! " + file + " has no thumb.png - the panel will show a plain tile");
                delete entry.thumb;
            }
            // the template's animated preview (played when hovering the tile)
            const mp4 = readZipEntry(fs.readFileSync(path.join(DIR, file)), "thumb.mp4");
            if (mp4) {
                const previewName = file.replace(/\.mogrt$/i, ".mp4");
                fs.writeFileSync(path.join(THUMBS, previewName), mp4);
                entry.preview = "thumbs/" + previewName;
            } else {
                delete entry.preview;
            }
        } catch (err) {
            console.log("  ! " + file + ": " + err.message);
            delete entry.thumb;
        }
        used[file] = true;
        out.push(entry);
    });

    // previews of templates that no longer exist
    const wantedThumbs = {};
    out.forEach(e => { if (e.thumb) wantedThumbs[path.basename(e.thumb)] = true; if (e.preview) wantedThumbs[path.basename(e.preview)] = true; });
    fs.readdirSync(THUMBS).forEach(f => {
        if (/\.(png|mp4)$/i.test(f) && !wantedThumbs[f]) { try { fs.unlinkSync(path.join(THUMBS, f)); console.log("  - removed unused preview: " + f); } catch {} }
    });

    existing.forEach(e => { if (e && e.file && !used[e.file]) console.log("  - removed from the list (file is gone): " + e.file); });

    // keep the file order the user chose for existing entries, new ones at the end
    const order = existing.map(e => e && e.file).filter(Boolean);
    out.sort((a, b) => {
        const ia = order.indexOf(a.file), ib = order.indexOf(b.file);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    fs.writeFileSync(INDEX, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log("Done: " + out.length + " template(s) listed in mogrts.json, previews in mogrts\\thumbs.");
    return 0;
}

process.exit(main());
