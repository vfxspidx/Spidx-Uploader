"use strict";

/* ========================================================================
 *  Photoshop bridge
 *
 *  Routes a raw PNG frame saved by the After Effects panel through the
 *  same Camera Raw Action the Photoshop panel already applies on its own
 *  manual uploads (config.cameraRawPreset, set once in the Dashboard —
 *  see dashboard.js / server.js's syncDefaultCameraRawPreset()). This is
 *  what makes the single Upload button in AE do "save frame -> Camera
 *  Raw -> upload" without any extra destination or per-click choice.
 *
 *  Deliberately does NOT launch Photoshop. It attaches to an ALREADY
 *  RUNNING instance over COM (GetObject in the .vbs helper below) and
 *  hands it a static .jsx job via DoJavaScriptFile — the same mechanism
 *  Adobe's own scripting samples use to drive Photoshop from outside.
 *  If Photoshop isn't open, GetObject fails immediately and cleanly,
 *  which is exactly the "not open" signal server.js needs to fall back
 *  to uploading the raw frame instead of getting stuck.
 * ==================================================================== */

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const BRIDGE_VBS = path.join(__dirname, "photoshop-bridge.vbs");
const BRIDGE_JSX = path.join(__dirname, "host", "photoshop-camera-raw.jsx");

// `execFile("cscript", ...)` relies on Windows resolving it via PATH —
// which fails with ENOENT (as opposed to a real error from cscript
// itself) in some launch contexts (services, some tray/packaged-app
// setups, a trimmed PATH) even though cscript.exe is always present in
// System32 on every Windows install. Using the full path sidesteps PATH
// lookup entirely, which is what actually failed here.
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const CSCRIPT_PATH = path.join(SYSTEM_ROOT, "System32", "cscript.exe");
// Fall back to plain "cscript" (old PATH-based behavior) only if the
// expected System32 copy genuinely isn't there — better than hard-failing
// on a path assumption that doesn't hold on some machine.
const CSCRIPT_BIN = fs.existsSync(CSCRIPT_PATH) ? CSCRIPT_PATH : "cscript";

// Runs the configured Camera Raw Action on inputPath inside the already-
// running Photoshop, saving the result as a new JPG next to it (same
// incoming folder — Spider Engine's own folder scan picks the new
// filename up from there like any other file, no special-casing needed).
// Resolves { ok: true, outputPath } or { ok: false, error }. Never
// rejects — callers always get a clean result to branch on.
function runCameraRaw(inputPath, preset) {
    return new Promise(resolve => {
        const actionSet = String((preset && preset.actionSet) || "");
        const actionName = String((preset && preset.actionName) || "");
        const outputPath = inputPath.replace(/\.ps\.png$/i, "").replace(/\.png$/i, "") + ".camraw.jpg";

        if (!actionName.trim()) {
            resolve({ ok: false, error: "No Camera Raw Action configured in the Dashboard." });
            return;
        }

        execFile(
            CSCRIPT_BIN,
            ["//Nologo", BRIDGE_VBS, BRIDGE_JSX, inputPath, actionSet, actionName, outputPath],
            { windowsHide: true, timeout: 120000 },
            (err, stdout, stderr) => {
                const out = String(stdout || "").trim();
                let parsed = null;
                // The .vbs only ever writes one line of JSON, but be
                // defensive about anything Photoshop/WSH might add above it.
                try { parsed = JSON.parse(out.split(/\r?\n/).pop()); } catch {}

                if (parsed && parsed.ok) {
                    resolve({ ok: true, outputPath: parsed.outputPath || outputPath });
                    return;
                }

                const reason = (parsed && parsed.error)
                    || String(stderr || "").trim()
                    || (err && err.message)
                    || "Unknown Photoshop bridge failure.";
                resolve({ ok: false, error: reason });
            }
        );
    });
}

module.exports = { runCameraRaw };
