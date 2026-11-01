"use strict";

/* ========================================================================
 *  Rules for files that land in the incoming folder.
 *
 *  The VEGAS Pro plugin tags its files with ".vg" just before the extension
 *  ("spidx_1759.vg.png", "spidx_1759.vg.ps.png"). The marker tells the engine (and the
 *  upload history) where a file came from and is stripped again before upload, so
 *  Drive / WorkUpload only ever see the clean name.
 *
 *  NOTE: an older VEGAS plugin that doesn't tag its files can't be told apart
 *  from the After Effects panel's plain ".png" - updating the plugin (the
 *  Dashboard's plugin update) replaces it with the tagging version.
 * ==================================================================== */

// ".vg" directly before ".ps"? + the extension - and nothing else, so a file such
// as "my.vgfile.png" is not mistaken for a tagged one.
const VEGAS_MARKER = /\.vg(?=(?:\.ps)?\.[^.\\/]+$)/i;

function parseIncomingName(name) {
    const vegas = VEGAS_MARKER.test(name);
    const cleanName = vegas ? name.replace(VEGAS_MARKER, "") : name;
    return { vegas, cleanName, source: vegas ? "vegas" : null };
}

// Since 3.0 VEGAS Pro is available on every plan (the free plan has a monthly video-render allowance
// instead - see server.js). The ".vg" tag is still read, so the history knows where a file came from and
// the tag is stripped before upload. canUsePro is kept for the callers that still pass it.
function decideIncoming(name, canUsePro) {
    const parsed = parseIncomingName(name);
    return { action: "accept", ...parsed };
}


/* ------------------------------------------------------------------------
 *  Is a rendered video file FINISHED?
 *
 *  A renderer (Media Encoder, VEGAS) writes the file for minutes. "The size
 *  has not changed for a few seconds" is not proof: a slow frame can stall
 *  the writer, and uploading half a video is the worst possible outcome.
 *  For MP4 / MOV / M4V there is a much better test: the file is a chain of
 *  "boxes" (size + 4-letter type) and a finished file always contains the
 *  index box "moov" and the chain ends exactly at the end of the file. A
 *  file still being written misses "moov" (encoders write it last) or ends
 *  in the middle of a box. Other containers (MKV, AVI, MXF, WebM) have no
 *  cheap check like that, so those just have to sit untouched longer.
 * ---------------------------------------------------------------------- */
const fs = require("fs");

const ISO_FIRST_BOX = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "junk"]);
const ISO_BOX_RE = /\.(mp4|m4v|mov)$/i;
const QUIET_MS_ISO   = 5 * 1000;    // plus the moov check
const QUIET_MS_OTHER = 20 * 1000;   // no structural check possible

// null = not an ISO-box file; true/false = complete or not.
function isoBoxFileComplete(fullPath) {
    let fd = null;
    try {
        fd = fs.openSync(fullPath, "r");
        const size = fs.fstatSync(fd).size;
        if (size < 16) return false;
        const head = Buffer.alloc(16);
        // Not really an MP4/MOV (e.g. some other file just renamed to .mp4)? Say so, so the
        // caller falls back to the "untouched for a while" rule instead of waiting forever.
        fs.readSync(fd, head, 0, 16, 0);
        if (!ISO_FIRST_BOX.has(head.toString("latin1", 4, 8))) return null;
        let pos = 0, sawMoov = false, sawFtyp = false, boxes = 0;
        while (pos < size) {
            if (size - pos < 8) return false;                       // truncated header
            fs.readSync(fd, head, 0, 16, pos);
            let boxSize = head.readUInt32BE(0);
            const type = head.toString("latin1", 4, 8);
            if (!/^[\x20-\x7e]{4}$/.test(type)) return false;       // garbage -> not a sane box chain
            if (boxSize === 1) {                                    // 64-bit size follows
                if (size - pos < 16) return false;
                const hi = head.readUInt32BE(8), lo = head.readUInt32BE(12);
                boxSize = hi * 4294967296 + lo;
            } else if (boxSize === 0) {                             // "extends to end of file"
                boxSize = size - pos;
            }
            if (boxSize < 8) return false;
            if (pos + boxSize > size) return false;                 // last box not fully written yet
            if (type === "moov") sawMoov = true;
            if (type === "ftyp") sawFtyp = true;
            pos += boxSize;
            if (++boxes > 100000) return false;
        }
        return pos === size && sawMoov && (sawFtyp || boxes > 0);
    } catch {
        return false;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
}

// st = fs.Stats of the file (already read by the caller, so the answer is consistent with it).
function videoFileReady(fullPath, st, now) {
    const t = now || Date.now();
    if (!st || st.size === 0) return false;
    const quiet = t - st.mtimeMs;
    if (ISO_BOX_RE.test(fullPath)) {
        if (quiet < QUIET_MS_ISO) return false;
        const complete = isoBoxFileComplete(fullPath);
        if (complete === null) return quiet >= QUIET_MS_OTHER;   // not a real MP4/MOV structure
        return complete;
    }
    return quiet >= QUIET_MS_OTHER;
}

module.exports = { isoBoxFileComplete, videoFileReady, parseIncomingName, decideIncoming, VEGAS_MARKER };
