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

async function compress(filePath, options) {
    const stat = fs.statSync(filePath);

    // From the helper's "compression" setting (a client preset can change it):
    // switched off -> upload the file as it is; otherwise aim for targetBytes.
    const enabled = !options || options.enabled !== false;
    const targetBytes = options && Number.isFinite(options.targetBytes) && options.targetBytes > 0 ? options.targetBytes : COMPRESS_TARGET_BYTES;

    if (!enabled || !COMPRESSIBLE_RE.test(filePath) || stat.size <= targetBytes) {
        return { ok: true, path: filePath, originalSize: stat.size, finalSize: stat.size, compressed: false };
    }

    const sh = ensureSharp();
    const originalBuffer = fs.readFileSync(filePath);

    // The default 1.5 MB target never needed more than quality 65. A preset can ask for a
    // much smaller file - let the search go lower for those instead of giving up at 65.
    const qualityFloor = targetBytes < 1024 * 1024 ? 30 : COMPRESS_QUALITY_LOW;
    let low = qualityFloor;
    let high = COMPRESS_QUALITY_HIGH;
    let bestBuffer = null;

    for (let i = 0; i < COMPRESS_MAX_ITER; i++) {
        const quality = Math.round((low + high) / 2);
        const buffer = await sh(originalBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();

        if (buffer.length > targetBytes) {
            high = quality;
        } else {
            bestBuffer = buffer;
            low = quality;
        }
    }

    if (!bestBuffer) {
        bestBuffer = await sh(originalBuffer).jpeg({ quality: qualityFloor, mozjpeg: true }).toBuffer();
    }

    const outPath = filePath.replace(/\.[^.]+$/i, "") + ".compressed.jpg";
    fs.writeFileSync(outPath, bestBuffer);

    return { ok: true, path: outPath, originalSize: stat.size, finalSize: bestBuffer.length, compressed: true };
}

parentPort.on("message", ({ filePath, options }) => {
    compress(filePath, options)
        .then(result => parentPort.postMessage(result))
        .catch(error => parentPort.postMessage({ ok: false, message: error.message }));
});
