"use strict";

/* ========================================================================
 *  Compression worker — runs in a Worker Thread so sharp's CPU-intensive
 *  JPEG binary search doesn't block the main thread (Playwright browser
 *  navigation, queue processing, panel status polling all stay responsive
 *  during compression).
 *
 *  Receives: { filePath } via parentPort.postMessage()
 *  Sends back: { ok: true, path, originalSize, finalSize, compressed }
 *           or { ok: false, message }
 * ==================================================================== */

const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const COMPRESS_TARGET_BYTES = 1.5 * 1024 * 1024;
const COMPRESS_MAX_ITER = 10;
const COMPRESS_QUALITY_LOW = 65;
const COMPRESS_QUALITY_HIGH = 95;

let sharp = null;
function ensureSharp() {
    if (sharp) return sharp;
    try {
        sharp = require("sharp");
        return sharp;
    } catch {
        throw new Error("sharp is missing. Run: npm install sharp");
    }
}

// Only raster stills can be re-encoded by sharp. Video (and anything else
// the After Effects panel might drop in) is passed straight through
// untouched instead of failing the whole upload.
const COMPRESSIBLE_RE = /\.(jpe?g|png|webp|tiff?)$/i;

async function compress(filePath) {
    const stat = fs.statSync(filePath);

    if (!COMPRESSIBLE_RE.test(filePath) || stat.size <= COMPRESS_TARGET_BYTES) {
        return { ok: true, path: filePath, originalSize: stat.size, finalSize: stat.size, compressed: false };
    }

    const sh = ensureSharp();
    const originalBuffer = fs.readFileSync(filePath);

    let low = COMPRESS_QUALITY_LOW;
    let high = COMPRESS_QUALITY_HIGH;
    let bestBuffer = null;

    for (let i = 0; i < COMPRESS_MAX_ITER; i++) {
        const quality = Math.round((low + high) / 2);
        const buffer = await sh(originalBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();

        if (buffer.length > COMPRESS_TARGET_BYTES) {
            high = quality;
        } else {
            bestBuffer = buffer;
            low = quality;
        }
    }

    if (!bestBuffer) {
        bestBuffer = await sh(originalBuffer).jpeg({ quality: COMPRESS_QUALITY_LOW, mozjpeg: true }).toBuffer();
    }

    const outPath = filePath.replace(/\.[^.]+$/i, "") + ".compressed.jpg";
    fs.writeFileSync(outPath, bestBuffer);

    return { ok: true, path: outPath, originalSize: stat.size, finalSize: bestBuffer.length, compressed: true };
}

parentPort.on("message", ({ filePath }) => {
    compress(filePath)
        .then(result => parentPort.postMessage(result))
        .catch(error => parentPort.postMessage({ ok: false, message: error.message }));
});
