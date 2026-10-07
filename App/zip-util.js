"use strict";

/* ========================================================================
 *  Minimal ZIP reader/writer (no dependencies) - used by:
 *    - diagnostics.js     (packs logs + versions into one .zip)
 *    - plugin-updates.js  (unpacks the plugin .zip files from GitHub)
 *  Supports "stored" and "deflate" entries, no ZIP64, no encryption - which
 *  is exactly what `zip -r` (the release workflows) and this writer produce.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xFFFF, day: day & 0xFFFF };
}

/** entries: [{ name: "folder/file.txt", data: Buffer|string }] -> Buffer (the .zip file) */
function createZip(entries) {
    const now = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(String(entry.name).replace(/\\/g, "/").replace(/^\/+/, ""), "utf8");
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
        const deflated = zlib.deflateRawSync(raw);
        const useDeflate = deflated.length < raw.length;
        const body = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);            // version needed
        local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(now.time, 10);
        local.writeUInt16LE(now.day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);          // version made by
        central.writeUInt16LE(20, 6);          // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(now.time, 12);
        central.writeUInt16LE(now.day, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += local.length + name.length + body.length;
    }

    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuffer, end]);
}

function writeZip(filePath, entries) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const buffer = createZip(entries);
    fs.writeFileSync(filePath, buffer);
    return buffer.length;
}

/** Reads a .zip into [{ name, data: Buffer, isDirectory }]. Throws on anything it can't handle. */
function readZip(zipBuffer) {
    // find the End Of Central Directory record (scan back over a possible comment)
    let eocd = -1;
    for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 22 - 65535); i--) {
        if (zipBuffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid .zip file (no central directory).");

    const count = zipBuffer.readUInt16LE(eocd + 10);
    let pos = zipBuffer.readUInt32LE(eocd + 16);
    const entries = [];

    for (let n = 0; n < count; n++) {
        if (zipBuffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("Corrupt .zip (bad central directory entry).");
        const flags = zipBuffer.readUInt16LE(pos + 8);
        const method = zipBuffer.readUInt16LE(pos + 10);
        const crc = zipBuffer.readUInt32LE(pos + 16);
        const compSize = zipBuffer.readUInt32LE(pos + 20);
        const size = zipBuffer.readUInt32LE(pos + 24);
        const nameLen = zipBuffer.readUInt16LE(pos + 28);
        const extraLen = zipBuffer.readUInt16LE(pos + 30);
        const commentLen = zipBuffer.readUInt16LE(pos + 32);
        const localOffset = zipBuffer.readUInt32LE(pos + 42);
        const name = zipBuffer.slice(pos + 46, pos + 46 + nameLen).toString((flags & 0x0800) ? "utf8" : "latin1");
        pos += 46 + nameLen + extraLen + commentLen;

        const isDirectory = name.endsWith("/");
        if (isDirectory) { entries.push({ name, data: Buffer.alloc(0), isDirectory: true }); continue; }

        if (flags & 0x1) throw new Error("Encrypted .zip entries are not supported.");
        if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Corrupt .zip (bad local header).");
        const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
        const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const compressed = zipBuffer.slice(dataStart, dataStart + compSize);

        let data;
        if (method === 0) data = compressed;
        else if (method === 8) data = zlib.inflateRawSync(compressed);
        else throw new Error(`Unsupported compression method ${method} for "${name}".`);

        if (data.length !== size || crc32(data) !== crc) throw new Error(`Checksum mismatch for "${name}" - the file is damaged.`);
        entries.push({ name, data, isDirectory: false });
    }
    return entries;
}

/** Extracts a .zip into destDir (created if needed). Refuses paths that escape destDir. Returns the list of written files. */
function extractZip(zipPath, destDir) {
    const entries = readZip(fs.readFileSync(zipPath));
    const root = path.resolve(destDir);
    fs.mkdirSync(root, { recursive: true });
    const written = [];

    for (const entry of entries) {
        const clean = entry.name.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
        if (!clean) continue;
        const target = path.resolve(root, clean);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`Refusing to extract "${entry.name}" - it points outside the target folder.`);
        }
        if (entry.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
        written.push(target);
    }
    return written;
}

module.exports = { crc32, createZip, writeZip, readZip, extractZip };
