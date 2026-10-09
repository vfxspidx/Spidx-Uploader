"use strict";

/* ========================================================================
 *  Upload history - the last uploads with their links, newest first.
 *  Stored in App\upload-history.json (never leaves the computer; it is not part
 *  of the diagnostics file). Capped at MAX_ENTRIES.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HISTORY_FILE = path.join(__dirname, "upload-history.json");
const MAX_ENTRIES = 500;

function read() {
    try {
        const list = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function write(list) {
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
    fs.renameSync(tmp, HISTORY_FILE);   // atomic: a crash never leaves a half-written file
}

function append(entry) {
    const full = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
        time: Date.now(),
        files: [],
        links: [],
        destination: null,
        folder: null,
        source: null,
        viaPhotoshop: false,
        preset: null,
        ...entry
    };
    const list = read();
    list.unshift(full);
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    try { write(list); } catch { /* history is a convenience - never break an upload because of it */ }
    return full;
}

function remove(id) {
    const list = read();
    const next = list.filter(e => e.id !== id);
    if (next.length === list.length) return false;
    write(next);
    return true;
}

function clear() {
    write([]);
}

module.exports = { read, append, remove, clear, MAX_ENTRIES, HISTORY_FILE };
