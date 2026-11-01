"use strict";

/* ========================================================================
 *  Resumable Google Drive upload (for big files: rendered videos).
 *
 *  Protocol: https://developers.google.com/drive/api/guides/manage-uploads#resumable
 *    1. POST  .../upload/drive/v3/files?uploadType=resumable   -> session URI (Location header)
 *    2. PUT   <session URI>  with  Content-Range: bytes a-b/total   (one chunk at a time)
 *         308 = "got it, send the next chunk"  (Range header says how much Drive has)
 *         200/201 = finished, body is the file resource
 *    3. After a dropped connection / 5xx:  PUT  Content-Length: 0,  Content-Range: bytes * /total
 *       tells us exactly how many bytes Drive really has, and we continue from there.
 *
 *  What this adds on top of googleapis' own upload:
 *    - progress callback (bytes sent, total, speed)
 *    - cancel via AbortSignal
 *    - survives network drops (retry with back-off, re-synced with Drive)
 *    - survives an app restart / crash: the session URI is saved in
 *      App/upload-sessions.json, keyed by file path + size + mtime + destination,
 *      so the next attempt continues instead of starting at 0 bytes
 *    - memory stays flat (one 16 MiB chunk at a time, never the whole file)
 *
 *  The access token comes from the caller (google-auth.js), so this file has
 *  no OAuth code of its own.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
const CHUNK_SIZE = 16 * 1024 * 1024;          // must be a multiple of 256 KiB
const MAX_CHUNK_RETRIES = 8;                  // per chunk, back-off 1,2,4,8,16,30,30,30 s
const SESSIONS_FILE = path.join(__dirname, "upload-sessions.json");
const SESSION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // Google keeps a session ~7 days

class UploadCancelled extends Error {
    constructor() { super("Upload cancelled."); this.name = "UploadCancelled"; this.cancelled = true; }
}

/* ------------------------- saved sessions --------------------------- */

function readSessions() {
    try {
        const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
        return raw && typeof raw === "object" ? raw : {};
    } catch { return {}; }
}

function writeSessions(all) {
    const now = Date.now();
    for (const k of Object.keys(all)) {
        if (!all[k] || now - (all[k].created || 0) > SESSION_MAX_AGE_MS) delete all[k];
    }
    try {
        const tmp = SESSIONS_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(all), "utf8");
        fs.renameSync(tmp, SESSIONS_FILE);
    } catch {}
}

function sessionKey(filePath, stat, name, parentId) {
    return crypto.createHash("sha1")
        .update([path.resolve(filePath).toLowerCase(), stat.size, Math.round(stat.mtimeMs), name, parentId || ""].join("|"))
        .digest("hex");
}

function saveSession(key, uri) {
    const all = readSessions();
    all[key] = { uri, created: Date.now() };
    writeSessions(all);
}

function dropSession(key) {
    const all = readSessions();
    if (all[key]) { delete all[key]; writeSessions(all); }
}

/* --------------------------- helpers -------------------------------- */

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(new UploadCancelled());
        const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
        function onAbort() { clearTimeout(t); reject(new UploadCancelled()); }
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
}

function isAbort(err, signal) {
    return (signal && signal.aborted) || (err && (err.name === "AbortError" || err.cancelled));
}

class HttpError extends Error {
    constructor(status, body) {
        super(`Drive upload failed: HTTP ${status}${body ? " - " + String(body).slice(0, 300) : ""}`);
        this.name = "HttpError";
        this.status = status;
        this.code = status;
    }
}

// Reads "Range: bytes=0-12345" -> 12346 (bytes Drive has). No header -> 0.
function committedFromRange(res) {
    const h = res.headers.get("range");
    if (!h) return 0;
    const m = /bytes=0-(\d+)/i.exec(h);
    return m ? Number(m[1]) + 1 : 0;
}

async function readChunk(fd, start, length) {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
        const { bytesRead } = await fd.read(buf, got, length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
}

/* ---------------------------- main ---------------------------------- */

/**
 * @param {object} o
 * @param {string}   o.filePath
 * @param {string}   [o.name]            file name on Drive
 * @param {string}   [o.parentId]        Drive folder id
 * @param {string}   [o.mimeType]
 * @param {function} o.getToken          async () => access token string
 * @param {function} [o.onProgress]      ({ sent, total, bytesPerSec, resumed })
 * @param {AbortSignal} [o.signal]
 * @param {string}   [o.endpoint]        (tests point this at a local fake server)
 * @param {number}   [o.chunkSize]
 * @param {function} [o.sleepFn]         (tests: skip real waiting)
 * @returns {Promise<{fileId: string}>}
 */
async function uploadResumable(o) {
    const { filePath, getToken, onProgress, signal } = o;
    const endpoint = o.endpoint || DEFAULT_ENDPOINT;
    const chunkSize = o.chunkSize || CHUNK_SIZE;
    const wait = o.sleepFn || sleep;
    const stat = fs.statSync(filePath);
    const total = stat.size;
    if (total <= 0) throw new Error("The file is empty.");
    const name = o.name || path.basename(filePath);
    const key = sessionKey(filePath, stat, name, o.parentId);

    const fetchWith = async (url, init, retryAuth = true) => {
        const token = await getToken();
        const res = await fetch(url, { ...init, signal, headers: { ...(init.headers || {}), Authorization: "Bearer " + token } });
        if (res.status === 401 && retryAuth) return fetchWith(url, init, false);   // token refreshed by getToken() next time
        return res;
    };

    async function startSession() {
        const res = await fetchWith(`${endpoint}?uploadType=resumable&fields=id`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": o.mimeType || "application/octet-stream",
                "X-Upload-Content-Length": String(total)
            },
            body: JSON.stringify({ name, ...(o.parentId ? { parents: [o.parentId] } : {}) })
        });
        if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
        const uri = res.headers.get("location");
        if (!uri) throw new Error("Drive did not return an upload session.");
        saveSession(key, uri);
        return uri;
    }

    // Asks Drive how much it really has. Returns { done, fileId } or { done:false, committed }.
    async function queryStatus(uri) {
        const res = await fetchWith(uri, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` } });
        if (res.status === 200 || res.status === 201) {
            const body = await res.json().catch(() => ({}));
            return { done: true, fileId: body.id };
        }
        if (res.status === 308) return { done: false, committed: committedFromRange(res) };
        if (res.status === 404 || res.status === 410) return { gone: true };
        throw new HttpError(res.status, await res.text().catch(() => ""));
    }

    let uri = (readSessions()[key] || {}).uri || null;
    let committed = 0;
    let resumed = false;

    if (uri) {
        try {
            const st = await queryStatus(uri);
            if (st.gone) { dropSession(key); uri = null; }
            else if (st.done) { dropSession(key); return { fileId: st.fileId }; }
            else { committed = st.committed; resumed = committed > 0; }
        } catch (err) {
            if (isAbort(err, signal)) throw new UploadCancelled();
            dropSession(key); uri = null;   // anything odd: just start fresh
        }
    }
    if (!uri) { uri = await startSession(); committed = 0; resumed = false; }

    const fd = await fs.promises.open(filePath, "r");
    const startedAt = Date.now();
    const startBytes = committed;
    const report = () => {
        if (!onProgress) return;
        const secs = Math.max(0.001, (Date.now() - startedAt) / 1000);
        try { onProgress({ sent: committed, total, bytesPerSec: Math.max(0, (committed - startBytes) / secs), resumed }); } catch {}
    };

    try {
        report();
        while (committed < total) {
            if (signal && signal.aborted) throw new UploadCancelled();
            const length = Math.min(chunkSize, total - committed);
            const chunk = await readChunk(fd, committed, length);
            if (chunk.length !== length) throw new Error("The file changed while it was being uploaded.");

            let attempt = 0;
            for (;;) {
                try {
                    const res = await fetchWith(uri, {
                        method: "PUT",
                        headers: {
                            "Content-Length": String(length),
                            "Content-Range": `bytes ${committed}-${committed + length - 1}/${total}`
                        },
                        body: chunk
                    });
                    if (res.status === 200 || res.status === 201) {
                        const body = await res.json().catch(() => ({}));
                        committed = total; report();
                        dropSession(key);
                        return { fileId: body.id };
                    }
                    if (res.status === 308) { committed = committedFromRange(res); report(); break; }
                    if (res.status === 404 || res.status === 410) {      // session expired: start over once
                        dropSession(key);
                        uri = await startSession(); committed = 0; resumed = false; report();
                        break;
                    }
                    const text = await res.text().catch(() => "");
                    if (res.status >= 500 || res.status === 429 || res.status === 408) throw new HttpError(res.status, text);
                    dropSession(key);
                    throw new HttpError(res.status, text);                // 4xx other than the above: not recoverable
                } catch (err) {
                    if (isAbort(err, signal)) throw new UploadCancelled();
                    const retryable = !(err instanceof HttpError) || err.status >= 500 || err.status === 429 || err.status === 408;
                    if (!retryable || ++attempt > MAX_CHUNK_RETRIES) throw err;
                    await wait(Math.min(30000, 1000 * 2 ** (attempt - 1)), signal);
                    // Re-sync: how much does Drive really have after the failure?
                    try {
                        const st = await queryStatus(uri);
                        if (st.done) { dropSession(key); committed = total; report(); return { fileId: st.fileId }; }
                        if (st.gone) { dropSession(key); uri = await startSession(); committed = 0; break; }
                        committed = st.committed; report();
                        break;                                            // outer loop re-reads from `committed`
                    } catch (e2) {
                        if (isAbort(e2, signal)) throw new UploadCancelled();
                        // status check failed too (still offline) - loop and retry the chunk / status again
                        if (attempt > MAX_CHUNK_RETRIES) throw e2;
                    }
                }
            }
        }
        // Everything sent but Drive answered 308 for the last chunk (rare): ask for the result.
        const fin = await queryStatus(uri);
        if (fin.done) { dropSession(key); return { fileId: fin.fileId }; }
        throw new Error("Drive did not confirm the finished upload.");
    } finally {
        await fd.close().catch(() => {});
    }
}

// Forget a half-finished upload (user cancelled): next time starts from 0.
function forgetSessionFor(filePath, name, parentId) {
    try {
        const stat = fs.statSync(filePath);
        dropSession(sessionKey(filePath, stat, name || path.basename(filePath), parentId));
    } catch {}
}

module.exports = { uploadResumable, forgetSessionFor, UploadCancelled, CHUNK_SIZE };
