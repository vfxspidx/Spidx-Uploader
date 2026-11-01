"use strict";

/* ===========================================================================
 *  Thumbnail Pack content (templates .aep, animation presets .ffx, MOGRT)
 *
 *  This content is NOT in the installer. The licence server hands it out only to an account that has the
 *  Thumbnail Pack (role "spt", or a dev / tester rank) and only to one of its registered computers. The helper
 *  downloads it into
 *
 *      %APPDATA%\Spidx Uploader\pack\
 *          ae\templates\   *.aep + templates.json   (what the After Effects SPT tab lists)
 *          ae\presets\     *.ffx + spt.json
 *          ppro\mogrts\    *.mogrt + mogrts.json + thumbs\
 *          state.json      which files the server manages (so nothing else is ever deleted)
 *
 *  and the panels read it from there. When the account no longer has the Pack, the managed files are removed
 *  again. Every file is verified against the sha256 in the signed manifest before it is written.
 *
 *  Honest limit: a paying customer's computer holds plain files, so a determined customer can still copy them.
 *  What this stops is the content being freely available inside a public installer.
 * =========================================================================== */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PACK_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Spidx Uploader", "pack");
const STATE_FILE = path.join(PACK_DIR, "state.json");

// Only these folders can be written, and only plain relative paths inside them.
const ALLOWED_PREFIXES = ["ae/templates/", "ae/presets/", "ppro/mogrts/"];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEMPLATES_PACK_LIST = "ae/templates/templates.json";   // the server's list; the panel reads a merged one
const TEMPLATES_MERGED = "ae/templates/templates.json";
const TEMPLATES_PACK_COPY = "ae/templates/templates.pack.json";
const TEMPLATES_USER_LIST = "ae/templates/templates.user.json";

let status = { state: "idle", version: 0, count: 0, message: "", updatedAt: 0 };

function getStatus() { return Object.assign({}, status); }
function setStatus(state, message, extra) {
    status = Object.assign({ state, message: message || "", version: status.version, count: status.count, updatedAt: Date.now() }, extra || {});
}

function packRoot() { return PACK_DIR; }

// "ae/templates/IGN.aep" -> absolute path, or null when the path is not allowed.
function safePackPath(rel) {
    const r = String(rel || "").replace(/\\/g, "/");
    if (!r || r.startsWith("/") || r.includes("..") || r.includes("\0") || /^[A-Za-z]:/.test(r)) return null;
    if (!ALLOWED_PREFIXES.some(p => r.startsWith(p))) return null;
    if (r.endsWith("/") || r.split("/").some(seg => seg === "" || seg === "." || /[<>:"|?*]/.test(seg))) return null;
    const abs = path.join(PACK_DIR, ...r.split("/"));
    const rootWithSep = PACK_DIR.endsWith(path.sep) ? PACK_DIR : PACK_DIR + path.sep;
    return abs.startsWith(rootWithSep) ? abs : null;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

function writeFileAtomic(abs, buffer) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + ".tmp";
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, abs);
}

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

function readState() {
    const s = readJson(STATE_FILE, null);
    return { version: Number(s && s.version) || 0, files: (s && typeof s.files === "object" && s.files) || {} };
}
function writeState(state) { writeFileAtomic(STATE_FILE, Buffer.from(JSON.stringify(state, null, 1))); }

// --- the AE template list: the server's entries + the ones the user added in the Dashboard -----------------
function mergeTemplates() {
    const pack = readJson(safePackPath(TEMPLATES_PACK_COPY), []);
    const user = readJson(safePackPath(TEMPLATES_USER_LIST), []);
    const merged = [];
    for (const t of Array.isArray(pack) ? pack : []) merged.push(Object.assign({}, t, { source: "pack" }));
    for (const t of Array.isArray(user) ? user : []) {
        if (t && t.file && t.comp) merged.push({ file: String(t.file), comp: String(t.comp), name: String(t.name || t.comp), textLayer: String(t.textLayer || "NICK"), source: "user" });
    }
    writeFileAtomic(safePackPath(TEMPLATES_MERGED), Buffer.from(JSON.stringify(merged, null, 2) + "\n"));
}

function saveUserTemplates(list) {
    const clean = [];
    for (const t of Array.isArray(list) ? list : []) {
        if (!t || t.source === "pack") continue;
        clean.push({ file: String(t.file), comp: String(t.comp), name: String(t.name || t.comp), textLayer: String(t.textLayer || "NICK") });
    }
    writeFileAtomic(safePackPath(TEMPLATES_USER_LIST), Buffer.from(JSON.stringify(clean, null, 2) + "\n"));
    mergeTemplates();
}

// --- removing what the server put here (never anything else) ----------------------------------------------
function removeManaged(log) {
    const state = readState();
    let removed = 0;
    for (const rel of Object.keys(state.files)) {
        const target = rel === TEMPLATES_PACK_LIST ? TEMPLATES_PACK_COPY : rel;
        const abs = safePackPath(target);
        if (abs) { try { fs.unlinkSync(abs); removed++; } catch {} }
    }
    const templatesDir = path.dirname(safePackPath(TEMPLATES_MERGED));
    if (fs.existsSync(templatesDir)) {
        try { mergeTemplates(); } catch {}         // what remains is only the user's own templates
    }
    try { fs.unlinkSync(STATE_FILE); } catch {}
    if (removed && log) log(`Thumbnail Pack: removed ${removed} file(s) (this account does not have the Pack).`);
    status = { state: "none", version: 0, count: 0, message: "", updatedAt: Date.now() };
    return removed;
}

/**
 * Brings the local pack in line with the server.
 *   entitled  : what the helper already knows from the signed licence (spt / dev / tester)
 *   api       : { requestPackManifest, requestPackFile }
 */
async function sync({ entitled, api, log }) {
    const say = typeof log === "function" ? log : () => {};
    if (!entitled) {
        removeManaged(say);
        return getStatus();
    }
    setStatus("syncing", "Checking for Pack updates...");
    const manifest = await api.requestPackManifest();
    if (!manifest.ok) {
        // no answer we can trust (offline...): keep what is there, the licence proof governs how long
        const have = Object.keys(readState().files).length;
        setStatus(have ? "ok" : "error", have ? "Offline - using the downloaded Pack." : manifest.message, { count: have, version: readState().version });
        return getStatus();
    }
    if (!manifest.entitled) {
        removeManaged(say);
        setStatus("none", "This account does not have the Thumbnail Pack.");
        return getStatus();
    }

    const state = readState();
    const wanted = {};
    let downloaded = 0, failed = 0;
    for (const item of manifest.items) {
        const rel = String(item.path || "").replace(/\\/g, "/");
        const target = rel === TEMPLATES_PACK_LIST ? TEMPLATES_PACK_COPY : rel;
        const abs = safePackPath(target);
        const hash = String(item.sha256 || "").toLowerCase();
        if (!abs || !/^[0-9a-f]{64}$/.test(hash) || !item.file || !(item.size >= 0 && item.size <= MAX_FILE_BYTES)) { failed++; say(`Thumbnail Pack: skipped an invalid entry (${rel}).`); continue; }
        wanted[rel] = hash;
        let current = null;
        try { current = sha256(fs.readFileSync(abs)); } catch {}
        if (current === hash) continue;
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            const file = await api.requestPackFile(String(item.file));
            if (!file.ok) { say(`Thumbnail Pack: could not download ${item.file} (${file.message}).`); continue; }
            if (file.buffer.length > MAX_FILE_BYTES || sha256(file.buffer) !== hash) { say(`Thumbnail Pack: ${item.file} did not match its checksum.`); continue; }
            writeFileAtomic(abs, file.buffer);
            ok = true;
            downloaded++;
        }
        if (!ok) { failed++; delete wanted[rel]; }
    }

    // files the server no longer lists
    for (const rel of Object.keys(state.files)) {
        if (wanted[rel] !== undefined) continue;
        if (failed && manifest.items.some(it => String(it.path).replace(/\\/g, "/") === rel)) continue;   // still listed, just not fetched now
        const target = rel === TEMPLATES_PACK_LIST ? TEMPLATES_PACK_COPY : rel;
        const abs = safePackPath(target);
        if (abs) { try { fs.unlinkSync(abs); } catch {} }
    }
    const kept = Object.assign({}, wanted);
    for (const rel of Object.keys(state.files)) {          // keep tracking what could not be refreshed this time
        if (kept[rel] === undefined && manifest.items.some(it => String(it.path).replace(/\\/g, "/") === rel)) kept[rel] = state.files[rel];
    }
    writeState({ version: manifest.version, files: kept });
    try { mergeTemplates(); } catch (err) { say(`Thumbnail Pack: could not merge the template list (${err.message}).`); }

    const count = Object.keys(kept).length;
    setStatus(failed ? "partial" : "ok", failed ? `${failed} file(s) could not be downloaded - will retry.` : (downloaded ? `Downloaded ${downloaded} file(s).` : "Up to date."), { version: manifest.version, count });
    if (downloaded) say(`Thumbnail Pack: version ${manifest.version}, ${downloaded} file(s) downloaded, ${count} in total.`);
    return getStatus();
}

module.exports = { sync, removeManaged, getStatus, packRoot, safePackPath, mergeTemplates, saveUserTemplates,
    PACK_DIR, TEMPLATES_PACK_COPY, TEMPLATES_USER_LIST, TEMPLATES_MERGED, _readState: readState };
