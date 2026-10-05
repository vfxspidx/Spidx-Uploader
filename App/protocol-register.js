"use strict";

/* ========================================================================
 *  Registers the spidx:// deep link for the CURRENT user (HKCU, no admin).
 *
 *  Why this exists: the Inno Setup installer registers spidx:// once, but
 *  when the app is run straight from a folder (zip / portable copy), or the
 *  folder was moved, nothing points Windows at protocol-handler.bat - so
 *  the Discord "Activate" button opens the redirect page and then nothing
 *  happens. tray.js calls ensureProtocolRegistered() on every start; it is
 *  idempotent (only writes when the registered path differs).
 *
 *  Can also be run by hand:  node protocol-register.js
 * ==================================================================== */

const path = require("path");
const { spawnSync } = require("child_process");

const KEY = "HKCU\\Software\\Classes\\spidx";

function reg(args) {
    return spawnSync("reg", args, { windowsHide: true, encoding: "utf8" });
}

function ensureProtocolRegistered(log) {
    const say = typeof log === "function" ? log : () => {};
    if (process.platform !== "win32") return { ok: false, skipped: true, message: "Not Windows." };

    const handler = path.join(__dirname, "protocol-handler.bat");
    const icon = path.join(__dirname, "tray-icon.ico");
    const command = `"${handler}" "%1"`;

    try {
        const q = reg(["query", KEY + "\\shell\\open\\command", "/ve"]);
        if (q.status === 0 && (q.stdout || "").toLowerCase().includes(handler.toLowerCase())) {
            return { ok: true, changed: false };
        }

        const steps = [
            ["add", KEY, "/ve", "/t", "REG_SZ", "/d", "URL:Spidx Uploader Protocol", "/f"],
            ["add", KEY, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"],
            ["add", KEY + "\\DefaultIcon", "/ve", "/t", "REG_SZ", "/d", icon, "/f"],
            ["add", KEY + "\\shell\\open\\command", "/ve", "/t", "REG_SZ", "/d", command, "/f"]
        ];
        for (const args of steps) {
            const r = reg(args);
            if (r.error || r.status !== 0) {
                const why = (r.error && r.error.message) || (r.stderr || "").trim() || `exit ${r.status}`;
                say(`spidx:// registration failed: ${why}`);
                return { ok: false, message: why };
            }
        }
        say(`spidx:// link registered -> ${handler}`);
        return { ok: true, changed: true };
    } catch (error) {
        say(`spidx:// registration error: ${error.message}`);
        return { ok: false, message: error.message };
    }
}

module.exports = { ensureProtocolRegistered };

if (require.main === module) {
    const r = ensureProtocolRegistered(console.log);
    console.log(r.ok ? (r.changed ? "Done - spidx:// registered." : "Already registered.") : `Failed: ${r.message}`);
    process.exit(r.ok ? 0 : 1);
}
