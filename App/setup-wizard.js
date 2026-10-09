"use strict";

/* ========================================================================
 *  First-run setup wizard
 *
 *  Runs once, automatically, the first time tray.js starts and finds no
 *  saved Google login. Instead of squeezing an onboarding flow into the
 *  narrow UXP side panel, this spins up a tiny local HTTP server (same
 *  pattern already used for Google OAuth in google-auth.js) and opens a
 *  full-page wizard in the system browser: sign in → choose destination
 *  → done. tray.js awaits runSetupWizard() before starting server.js, so
 *  the actual helper never runs with an unconfigured account.
 *
 *  The UXP panel itself is untouched by this — it has no first-run logic
 *  at all, it just always assumes setup already happened (which, once
 *  this wizard has run once, it always has).
 * ==================================================================== */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const APP_DIR = __dirname;
const HELPER_CONFIG_FILE = path.join(APP_DIR, "helper-config.json");
const INCOMING_DIR = path.join(APP_DIR, "incoming");
const GOOGLE_TOKEN_FILE = path.join(APP_DIR, "google-token.json");
const LICENSE_CACHE_FILE = path.join(APP_DIR, "license-cache.json");
// The After Effects panel ships next to the App folder, not inside it.
const AE_INSTALLER = path.join(APP_DIR, "..", "CEP-AE", "Install AE Panel.bat");
const PPRO_INSTALLER = path.join(APP_DIR, "..", "CEP-PPRO", "Install PPRO Panel.bat");
// VEGAS Pro plugin: builds a .dll against the user's VEGAS and copies it into
// its "Application Extensions" folder -- see VEGAS-Plugin\install-vegas.js.
const VEGAS_INSTALLER = path.join(APP_DIR, "..", "VEGAS-Plugin", "Install VEGAS Plugin.bat");
// Photoshop (UXP) panel: a single packaged .ccx installed through Adobe's
// UPIA tool -- see upia.js. Filename/id must match Installer\SpidxUploader.iss.
const PS_INSTALLER_CCX = path.join(APP_DIR, "..", "UXP", "com.spidx.workupload_PS.ccx");
// Elevated script that runs Adobe's UPIA as Administrator (see UXP\Install PS Panel.bat).
const PS_INSTALLER_BAT = path.join(APP_DIR, "..", "UXP", "Install PS Panel.bat");
const UXP_PLUGIN_ID = "com.spidx.workupload"; // must match the .ccx's manifest.json "id"
const upia = require("./upia.js");
const legal = require("./legal.js");
const DRIVE_TIERS = new Set(["pro", "dev", "tester"]);

// What the wizard already knows before anything is clicked: whether a
// Google login is saved from a previous run and what tier it last
// resolved to. Deliberately read off disk instead of calling
// google-auth — touching that would kick off a real OAuth round trip
// just to render step 1.
function readKnownAccount() {
    if (!fs.existsSync(GOOGLE_TOKEN_FILE)) return { email: null, tier: null, roles: [] };
    try {
        const cache = JSON.parse(fs.readFileSync(LICENSE_CACHE_FILE, "utf8"));
        // The cache holds the SIGNED string ("pro", "spt", "pro+spt"). Turn it into the rank + the roles;
        // comparing the raw string with the rank list made a "pro+spt" licence look like Free.
        const license = require("./license.js");
        const roles = cache.tier ? license.parseRoles(cache.tier) : [];
        return { email: cache.email || null, tier: cache.tier ? license.primaryTier(roles) : null, roles };
    } catch {
        return { email: null, tier: null, roles: [] };
    }
}

// The Premiere Pro panel may be installed with a Pro-level rank OR with the "spt" role (the Thumbnail Pack's
// MOGRT tab lives in that panel). An unknown plan (nothing cached yet) is allowed, as before.
function pproAllowed(tier, roles) {
    if (!tier) return true;
    return DRIVE_TIERS.has(tier) || (Array.isArray(roles) && roles.indexOf("spt") !== -1);
}

function openFolder(target, log) {
    try {
        fs.mkdirSync(target, { recursive: true });
        const child = spawn("explorer.exe", [target], { windowsHide: false, detached: true });
        child.on("error", err => log(`Could not open ${target}: ${err.message}`));
        child.unref();
        return true;
    } catch (err) {
        log(`Could not open ${target}: ${err.message}`);
        return false;
    }
}

// Spawns a .bat installer/uninstaller and only answers the HTTP request
// once we actually know whether the OS accepted it — "spawn" fires once
// the process really started, "error" fires on a real failure (e.g. the
// path doesn't exist, or cmd.exe itself can't be found). Previously the
// route replied ok:true the instant spawn() was *called*, which is why
// failures were invisible: spawn() returns a ChildProcess object
// immediately regardless of whether Windows could actually start it.
function spawnBatFile(batPath, log, cb) {
    let done = false;
    const finish = (ok, message) => {
        if (done) return;
        done = true;
        cb(ok, message);
    };
    try {
        const child = spawn(`"${batPath}"`, [], { shell: true, windowsHide: false, detached: true, cwd: path.dirname(batPath) });
        child.once("spawn", () => finish(true, null));
        child.once("error", err => {
            log(`Could not start ${batPath}: ${err.message}`);
            finish(false, err.message);
        });
        child.on("exit", code => log(`${path.basename(batPath)} window closed (exit code ${code}).`));
        child.unref();
        // Neither event fired within a beat — assume it worked rather than
        // hang the request forever; the exit-code log line above still
        // catches this case after the fact.
        setTimeout(() => finish(true, null), 1200);
    } catch (err) {
        finish(false, err.message);
    }
}

function readHelperConfig() {
    try {
        return JSON.parse(fs.readFileSync(HELPER_CONFIG_FILE, "utf8"));
    } catch {
        return {};
    }
}

function writeHelperConfig(raw) {
    fs.writeFileSync(HELPER_CONFIG_FILE, JSON.stringify(raw, null, 2), "utf8");
}

// Same robust pattern as google-auth.js's openInBrowser: full path via
// %SystemRoot% (not relying on PATH), and a mandatory "error" listener —
// spawn() failures are async and would otherwise crash the caller.
function openInBrowser(url, log) {
    try {
        const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
        const rundll32Path = path.join(systemRoot, "System32", "rundll32.exe");
        const child = spawn(rundll32Path, ["url.dll,FileProtocolHandler", url], { windowsHide: true });
        child.on("error", err => log(`Could not auto-open the browser (use the URL above manually): ${err.message}`));
    } catch (err) {
        log(`Could not auto-open the browser (use the URL above manually): ${err.message}`);
    }
}

const WIZARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spidx Uploader — Setup</title>
<style>
    :root {
        --bg: #000000;
        --surface: #1c1c1e;
        --surface-2: #2c2c2e;
        --line: rgba(255,255,255,.10);
        --text: #f5f5f7;
        --dim: #98989d;
        --faint: #636366;
        --accent: #0a84ff;
        --accent-2: #64d2ff;
        --ok: #30d158;
        --err: #ff453a;
    }

    * { box-sizing: border-box; }

    html, body {
        margin: 0; padding: 0; min-height: 100vh;
        background: var(--bg); color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 14px; -webkit-font-smoothing: antialiased;
        display: flex; align-items: center; justify-content: center; padding: 24px;
    }

    body::before {
        content: ""; position: fixed; inset: 0; pointer-events: none;
        background:
            radial-gradient(700px 300px at 50% -80px, rgba(10,132,255,.20), transparent 70%),
            radial-gradient(500px 240px at 85% 110%, rgba(100,210,255,.12), transparent 70%);
    }

    .card {
        position: relative; width: 460px; max-width: 100%;
        background: linear-gradient(180deg, var(--surface), #121216);
        border: 1px solid var(--line); border-radius: 20px; padding: 32px 30px 28px;
        box-shadow: 0 32px 80px -30px rgba(0,0,0,.95);
        animation: rise .32s ease;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

    .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 20px; }
    .mark {
        width: 30px; height: 30px; border-radius: 9px;
        background: linear-gradient(160deg, #0a84ff, #0060df);
        display: flex; align-items: center; justify-content: center;
        font-size: 15px; font-weight: 700; color: #fff;
        box-shadow: none;
    }
    .brand b { font-size: 13.5px; font-weight: 700; margin-right: auto; }
    .tier-chip {
        display: none; padding: 4px 9px; border-radius: 999px; font-size: 10.5px;
        font-weight: 700; letter-spacing: .05em; background: #2c2c32; color: #c3c3cc;
    }
    .tier-chip.show { display: inline-block; }
    .tier-chip.tier-pro { background: rgba(255,214,10,.12); color: #ffd60a; }
    .tier-chip.tier-dev { background: rgba(192,123,255,.14); color: #c07bff; }
    .tier-chip.tier-tester { background: rgba(100,210,255,.14); color: #64d2ff; }
    .tier-chip.tier-spt { background: rgba(255,159,10,.14); color: #ff9f0a; }

    .steps { display: flex; gap: 6px; margin-bottom: 26px; }
    .step-dot { flex: 1; height: 4px; border-radius: 2px; background: #26262d; transition: background .3s ease; }
    .step-dot.active { background: var(--accent); }
    .step-dot.done { background: var(--ok); }

    .step { display: none; }
    .step.show { display: block; animation: rise .25s ease; }

    .kicker {
        font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
        color: var(--accent-2); margin: 0 0 10px;
    }
    h1 { font-size: 21px; font-weight: 700; margin: 0 0 9px; line-height: 1.25; letter-spacing: -.02em; }
    .sub { font-size: 13px; color: var(--dim); margin: 0 0 22px; line-height: 1.6; }

    .btn {
        width: 100%; padding: 13px; border-radius: 11px; border: none; cursor: pointer;
        font-family: inherit; font-size: 14px; font-weight: 600; color: #fff; margin-top: 10px;
        background: var(--accent);
        box-shadow: none;
        transition: filter .15s ease, transform .1s ease, opacity .15s ease;
    }
    .btn:hover:not(:disabled) { filter: brightness(1.12); }
    .btn:active:not(:disabled) { transform: translateY(1px); }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .consent { display: flex; gap: 10px; align-items: flex-start; margin: 4px 0 16px; font-size: 12.5px; line-height: 1.5; color: var(--text, #f5f5f7); cursor: pointer; }
    .consent input { margin-top: 3px; width: 16px; height: 16px; flex-shrink: 0; accent-color: #0a84ff; cursor: pointer; }
    .consent a { color: #64d2ff; text-decoration: none; }
    .consent a:hover { text-decoration: underline; }
    .btn.ghost {
        background: var(--surface-2); color: var(--dim); border: 1px solid var(--line); box-shadow: none;
        font-size: 13px; padding: 11px;
    }
    .btn.ghost:hover:not(:disabled) { color: var(--text); }
    .link {
        display: inline-block; margin-top: 14px; font-size: 12px; color: var(--faint);
        background: none; border: none; cursor: pointer; font-family: inherit; padding: 0;
    }
    .link:hover { color: var(--accent-2); text-decoration: underline; }

    .account {
        display: none; align-items: center; gap: 11px; padding: 12px 14px; border-radius: 12px;
        background: var(--surface-2); border: 1px solid var(--line); margin-bottom: 4px;
    }
    .account.show { display: flex; }
    .avatar {
        width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
        background: linear-gradient(160deg, #0a84ff, #0060df);
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; font-weight: 700; color: #fff; text-transform: uppercase;
    }
    .account .who { min-width: 0; text-align: left; }
    .account .who b { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .account .who span { display: block; font-size: 11.5px; color: var(--faint); margin-top: 2px; }

    .opt {
        position: relative; display: block; width: 100%; text-align: left;
        border: 1.5px solid var(--line); border-radius: 14px; padding: 15px 16px;
        margin-bottom: 11px; cursor: pointer; background: var(--surface-2); color: var(--text);
        font-family: inherit; transition: .16s ease;
    }
    .opt:hover:not(:disabled) { border-color: #43434f; transform: translateY(-1px); }
    .opt.selected {
        border-color: var(--accent);
        background: linear-gradient(180deg, rgba(10,132,255,.16), rgba(10,132,255,.06));
    }
    .opt.selected::after {
        content: "✓"; position: absolute; top: 14px; right: 15px;
        font-size: 12px; font-weight: 700; color: var(--accent);
    }
    .opt:disabled { opacity: .4; cursor: not-allowed; }
    .opt .t { display: block; font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .opt .d { display: block; font-size: 12px; color: var(--dim); line-height: 1.5; }
    .opt .tag {
        display: inline-block; margin-left: 7px; padding: 2px 7px; border-radius: 999px;
        font-size: 9.5px; font-weight: 700; letter-spacing: .05em; vertical-align: middle;
        background: rgba(255,214,10,.12); color: #ffd60a;
    }

    .path-box {
        display: flex; align-items: center; gap: 10px; padding: 11px 13px;
        background: #0e0e11; border: 1px solid var(--line); border-radius: 11px; margin-bottom: 14px;
    }
    .path-box code {
        flex: 1; min-width: 0; font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.5px;
        color: #c9c9d2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
    }
    .path-box button {
        border: 1px solid var(--line); background: var(--surface-2); color: var(--dim);
        border-radius: 8px; padding: 5px 10px; font-size: 11px; font-weight: 600;
        cursor: pointer; font-family: inherit; white-space: nowrap;
    }
    .path-box button:hover { color: var(--text); }

    .host-row {
        display: flex; gap: 12px; align-items: flex-start; padding: 13px 0;
        border-top: 1px solid var(--line); text-align: left;
    }
    .host-row .ico {
        width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; letter-spacing: -.02em;
    }
    .host-row .ico.ps { background: rgba(100,210,255,.12); color: #48b6ff; }
    .host-row .ico.ae { background: rgba(192,123,255,.14); color: #c07bff; }
    .host-row .ico.ppro { background: rgba(150,110,255,.14); color: #9a7bff; }
    .host-row .ico.vegas { background: rgba(63,180,255,.14); color: #3fb4ff; }
    .host-row.locked { opacity: .55; }
    .host-row.locked .txt b { color: var(--dim); }
    .badge-default {
        font-size: 9.5px; font-weight: 700; letter-spacing: .03em; color: var(--ok);
        background: rgba(48,209,88,.12); border-radius: 5px; padding: 2px 6px; margin-left: 6px; vertical-align: middle;
    }
    .badge-soon {
        font-size: 9.5px; font-weight: 700; letter-spacing: .03em; color: var(--faint);
        background: rgba(255,255,255,.06); border-radius: 5px; padding: 2px 6px; margin-left: 6px; vertical-align: middle;
    }
    .host-row .txt button.mini {
        margin-top: 8px; border: 1px solid var(--line); background: var(--surface-2); color: var(--dim);
        border-radius: 8px; padding: 6px 11px; font-size: 11.5px; font-weight: 600;
        cursor: pointer; font-family: inherit;
    }
    .host-row .txt button.mini:hover:not(:disabled) { color: var(--text); }
    .host-row .txt button.mini:disabled { opacity: .5; cursor: default; }

    .host-row .txt { flex: 1; min-width: 0; }
    .host-row .txt b { display: block; font-size: 13px; font-weight: 600; }
    .host-row .txt span { display: block; font-size: 12px; color: var(--dim); line-height: 1.5; margin-top: 3px; }

    .status {
        font-size: 12.5px; color: var(--dim); margin-top: 13px; min-height: 18px; line-height: 1.5;
    }
    .status.ok { color: var(--ok); }
    .status.err { color: var(--err); }

    .license-box { display: none; margin-top: 14px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.02); }
    .license-box.show { display: block; }
    .license-box b { display: block; font-size: 13px; margin-bottom: 8px; }
    .license-box .row { display: flex; gap: 8px; }
    .license-box input {
        flex: 1; min-width: 0; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--line);
        background: rgba(0,0,0,.25); color: var(--text); font: inherit; text-transform: uppercase;
    }
    .license-box input:focus { outline: none; border-color: var(--accent); }
    .license-box .btn { width: auto; padding: 9px 16px; margin: 0; }
    .center { text-align: center; }
    .check { font-size: 42px; margin-bottom: 10px; }
</style>
</head>
<body>
<div class="card">
    <div class="brand">
        <div class="mark">S</div>
        <b>Spidx Uploader</b>
        <span class="tier-chip" id="tierChip"></span>
    </div>

    <div class="steps">
        <div class="step-dot" id="dot1"></div>
        <div class="step-dot" id="dot2"></div>
        <div class="step-dot" id="dot3"></div>
        <div class="step-dot" id="dot4"></div>
    </div>

    <!-- ---------- step 1: Google account ---------- -->
    <div class="step" id="step1">
        <div class="kicker">Step 1 of 4</div>
        <h1>Sign in with Google</h1>
        <p class="sub">This is the account your Free/Pro status is looked up for, and — if you pick Google Drive next — the Drive your uploads land in. Signing in sends your Google sign-in token to the Spidx license server so it can look up your plan; the Privacy Policy lists exactly what is sent where.</p>

        <label class="consent" id="consentRow">
            <input type="checkbox" id="consentBox">
            <span>I have read and agree to the <a href="https://spidxuploader.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>, the <a href="https://spidxuploader.com/eula" target="_blank" rel="noopener noreferrer">End User License Agreement</a> and the <a href="https://spidxuploader.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span>
        </label>

        <div class="account" id="accountBox">
            <div class="avatar" id="accountInitial">?</div>
            <div class="who">
                <b id="accountEmail">—</b>
                <span id="accountTier">checking tier...</span>
            </div>
        </div>

        <div class="license-box" id="licenseBox">
            <b>Have a license code? <span style="font-weight:400;color:var(--muted,#8e8e93);">Optional - you can skip this.</span></b>
            <div class="row">
                <input type="text" id="wizLicenseInput" placeholder="e.g. PRO-XXXX-XXXX" autocomplete="off" spellcheck="false">
                <button class="btn" id="wizLicenseBtn">Activate</button>
            </div>
            <div class="status" id="wizLicenseStatus"></div>
        </div>

        <button class="btn" id="signinBtn">Sign in with Google</button>
        <button class="btn ghost" id="continue1Btn" style="display:none;">Continue</button>
        <div class="status" id="signinStatus"></div>
        <button class="link" id="switchAccountBtn" style="display:none;">Use a different Google account</button>
    </div>

    <!-- ---------- step 2: destination ---------- -->
    <div class="step" id="step2">
        <div class="kicker">Step 2 of 4</div>
        <h1>Where should uploads go?</h1>
        <p class="sub">Changeable any time later — tray menu or the Dashboard.</p>

        <button class="opt" id="destWorkupload" data-dest="workupload">
            <span class="t">WorkUpload</span>
            <span class="d">Uploads through a real browser to workupload.com. Works on every tier, no setup.</span>
        </button>
        <button class="opt" id="destDrive" data-dest="drive">
            <span class="t">Google Drive<span class="tag" id="driveTag" style="display:none;">PRO</span></span>
            <span class="d">Direct API upload to your own Drive — no browser, no Security Check, nothing that breaks when WorkUpload redesigns a page.</span>
        </button>

        <button class="link" id="haveCodeLink" style="display:none;">Have a license code? Enter it to unlock Google Drive</button>

        <button class="btn" id="destContinueBtn" disabled>Continue</button>
        <div class="status" id="destStatus"></div>
    </div>

    <!-- ---------- step 3: connect the panels ---------- -->
    <div class="step" id="step3">
        <div class="kicker">Step 3 of 4</div>
        <h1>Connect your panels</h1>
        <p class="sub">Both panels drop exports into one folder that the helper watches. This is that folder — the panels ask for it once.</p>

        <div class="path-box">
            <code id="incomingPath">...</code>
            <button id="copyPathBtn">Copy</button>
            <button id="openPathBtn">Open</button>
        </div>

        <div class="host-row">
            <div class="ico ps">Ps</div>
            <div class="txt">
                <b>Photoshop <span class="badge-default">DEFAULT</span></b>
                <span>Installs the panel through Creative Cloud. Open Photoshop, hit Upload once and pick the folder above.</span>
                <button class="mini" id="installPsBtn">Install the Photoshop panel</button>
            </div>
        </div>

        <div class="host-row">
            <div class="ico ae">Ae</div>
            <div class="txt">
                <b>After Effects <span style="color: var(--faint); font-weight: 500;">(optional)</span></b>
                <span>Installs a panel that sends the current comp frame as a PNG. After Effects must be closed while it installs.</span>
                <button class="mini" id="installAeBtn">Install the After Effects panel</button>
            </div>
        </div>

        <div class="host-row">
            <div class="ico ppro">Pr</div>
            <div class="txt">
                <b>Premiere Pro <span style="color: var(--faint); font-weight: 500;">(optional)</span></b>
                <span>Installs a panel that exports the current sequence frame as a PNG. Premiere Pro must be closed while it installs.</span>
                <button class="mini" id="installPproBtn">Install the Premiere Pro panel</button>
            </div>
        </div>

        <div class="host-row">
            <div class="ico vegas">Vg</div>
            <div class="txt">
                <b>VEGAS Pro <span style="color: var(--faint); font-weight: 500;">(optional, uploading from VEGAS needs a Pro plan)</span></b>
                <span>Builds and installs a docked panel that saves the current frame as a PNG (View &gt; Extensions &gt; Spidx Uploader). VEGAS must be closed while it installs.</span>
                <button class="mini" id="installVegasBtn">Install the VEGAS Pro plugin</button>
            </div>
        </div>

        <button class="btn" id="hostsContinueBtn">Continue</button>
        <div class="status" id="hostsStatus"></div>
    </div>

    <!-- ---------- step 4: done ---------- -->
    <div class="step center" id="step4">
        <div class="check">&#x2705;</div>
        <h1>All set</h1>
        <p class="sub">The helper starts now and lives in your system tray. Right-click its icon for the Dashboard, where you can switch destination, enter a license code, manage your devices and set a Camera Raw preset that gets applied on every Photoshop upload.</p>
        <button class="btn" id="finishBtn">Finish &amp; start the helper</button>
    </div>
</div>

<script>
function $(id) { return document.getElementById(id); }

var state = { email: null, tier: null, driveAllowed: true, proFeaturesAllowed: true, pproAllowed: true, incomingPath: "", aePanelAvailable: false };
var selectedDest = null;

function showStep(n) {
    var steps = document.querySelectorAll(".step");
    for (var i = 0; i < steps.length; i++) steps[i].classList.remove("show");
    $("step" + n).classList.add("show");
    for (var d = 1; d <= 4; d++) {
        var dot = $("dot" + d);
        dot.classList.toggle("active", d === n);
        dot.classList.toggle("done", d < n);
    }
}

function setStatus(id, message, kind) {
    var el = $(id);
    el.textContent = message || "";
    el.className = "status" + (kind ? " " + kind : "");
}

function renderAccount() {
    if (!state.email) return;

    $("accountBox").classList.add("show");
    $("accountEmail").textContent = state.email;
    $("accountInitial").textContent = state.email.charAt(0);
    $("accountTier").textContent = state.tier
        ? (state.tier === "free" ? "Free tier" : state.tier.toUpperCase() + " tier")
        : "tier not checked yet";

    var chip = $("tierChip");
    chip.className = "tier-chip show tier-" + (state.tier || "free");
    chip.textContent = (state.tier || "free").toUpperCase();

    $("signinBtn").style.display = "none";
    $("continue1Btn").style.display = "";
    $("switchAccountBtn").style.display = "";

    var isFree = !state.tier || state.tier === "free";
    $("licenseBox").classList.toggle("show", state.tier === "free");
    $("haveCodeLink").style.display = (!state.driveAllowed && isFree) ? "" : "none";

    var driveBtn = $("destDrive");
    driveBtn.disabled = !state.driveAllowed;
    $("driveTag").style.display = state.driveAllowed ? "none" : "inline-block";
    if (!state.driveAllowed && selectedDest === "drive") selectedDest = null;
}

function applyPproButtonState() {
    if (!state.pproPanelAvailable) {
        $("installPproBtn").disabled = true;
        $("installPproBtn").textContent = "Premiere Pro panel folder not found (CEP-PPRO)";
    } else if (!state.pproAllowed) {
        $("installPproBtn").disabled = true;
        $("installPproBtn").textContent = "Premiere Pro panel needs Pro or the Thumbnail Pack";
    } else {
        $("installPproBtn").disabled = false;
        $("installPproBtn").textContent = "Install the Premiere Pro panel";
    }
}

async function loadState() {
    try {
        var res = await fetch("/state");
        var data = await res.json();
        state = data;
        $("incomingPath").textContent = data.incomingPath || "";
        $("installAeBtn").disabled = !data.aePanelAvailable;
        if (!data.aePanelAvailable) {
            $("installAeBtn").textContent = "AE panel folder not found (CEP-AE)";
        }
        if (!data.psPanelAvailable) {
            $("installPsBtn").disabled = true;
            $("installPsBtn").textContent = "Photoshop panel (.ccx) not found";
        } else if (!data.upiaAvailable) {
            $("installPsBtn").disabled = true;
            $("installPsBtn").textContent = "Requires Creative Cloud desktop app";
        } else {
            $("installPsBtn").disabled = false;
            $("installPsBtn").textContent = "Install the Photoshop panel";
        }
        applyPproButtonState();
        applyVegasButtonState();
        applyConsentState(!!(data.consent && data.consent.accepted));
        if (data.email) renderAccount();
    } catch (err) {}
}

// Consent: the checkbox is what unlocks "Sign in with Google" (the server refuses /signin without it).
function applyConsentState(accepted) {
    $("consentBox").checked = accepted;
    if ($("signinBtn").style.display !== "none") $("signinBtn").disabled = !accepted;
}

$("consentBox").addEventListener("change", async function () {
    var box = $("consentBox");
    if (!box.checked) { $("signinBtn").disabled = true; return; }   // accepting is recorded; un-ticking just re-locks the button
    box.disabled = true;
    try {
        var res = await fetch("/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accepted: true }) });
        var out = await res.json();
        if (!out.ok) throw new Error(out.message || "failed");
        state.consent = out.consent;
        $("signinBtn").disabled = false;
    } catch (err) {
        box.checked = false;
        setStatus("signinStatus", "Could not save your choice — try again.", "err");
    }
    box.disabled = false;
});

/* ---------------- step 1 ---------------- */
$("signinBtn").addEventListener("click", async function () {
    var btn = $("signinBtn");
    btn.disabled = true;
    setStatus("signinStatus", "Opening Google sign-in in a new tab — finish it there, then come back.");

    try {
        var res = await fetch("/signin", { method: "POST" });
        var data = await res.json();
        if (data.ok) {
            state.email = data.email;
            state.tier = data.tier;
            state.driveAllowed = data.driveAllowed;
            state.proFeaturesAllowed = data.proFeaturesAllowed;
            state.pproAllowed = data.pproAllowed;
            renderAccount();
            applyPproButtonState();
        applyVegasButtonState();
            setStatus("signinStatus", data.tierChecked
                ? "Signed in."
                : "Signed in — the tier check could not reach the server, so you start on Free.", "ok");
        } else {
            setStatus("signinStatus", data.message || "Sign-in failed.", "err");
            btn.disabled = false;
        }
    } catch (err) {
        setStatus("signinStatus", "Could not reach the setup server.", "err");
        btn.disabled = false;
    }
});

$("continue1Btn").addEventListener("click", function () { showStep(2); });

/* ---------------- license code (step 1, optional) ---------------- */
$("wizLicenseBtn").addEventListener("click", async function () {
    var input = $("wizLicenseInput");
    var code = input.value.trim();
    if (!code) { setStatus("wizLicenseStatus", "Enter a code first.", "err"); return; }

    var btn = $("wizLicenseBtn");
    btn.disabled = true;
    setStatus("wizLicenseStatus", "Activating...");
    try {
        var res = await fetch("/redeem-license", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code })
        });
        var data = await res.json();
        if (data.ok) {
            input.value = "";
            state.tier = data.tier;
            state.driveAllowed = data.driveAllowed;
            state.proFeaturesAllowed = data.proFeaturesAllowed;
            state.pproAllowed = data.pproAllowed;
            renderAccount();
            applyPproButtonState();
        applyVegasButtonState();
            var label = data.tier.toUpperCase() + (data.trialDaysRemaining ? " (" + data.trialDaysRemaining + (data.trialDaysRemaining === 1 ? " day" : " days") + " left)" : " (lifetime)");
            setStatus("wizLicenseStatus", "Activated - you now have " + label + (data.driveAllowed ? ". Google Drive is unlocked." : "."), "ok");
            setStatus("signinStatus", "");
        } else {
            setStatus("wizLicenseStatus", data.message || "Could not activate this code.", "err");
        }
    } catch (err) {
        setStatus("wizLicenseStatus", "Could not reach the setup server.", "err");
    }
    btn.disabled = false;
});
$("wizLicenseInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("wizLicenseBtn").click();
});
$("haveCodeLink").addEventListener("click", function () {
    showStep(1);
    $("wizLicenseInput").focus();
});

$("switchAccountBtn").addEventListener("click", async function () {
    setStatus("signinStatus", "Clearing the saved login...");
    try {
        await fetch("/signin-reset", { method: "POST" });
    } catch (err) {}
    state.email = null;
    state.tier = null;
    $("accountBox").classList.remove("show");
    $("tierChip").className = "tier-chip";
    $("licenseBox").classList.remove("show");
    $("haveCodeLink").style.display = "none";
    $("signinBtn").style.display = "";
    $("signinBtn").disabled = !$("consentBox").checked;
    $("continue1Btn").style.display = "none";
    $("switchAccountBtn").style.display = "none";
    setStatus("signinStatus", "Saved login cleared — sign in with the account you want.");
});

/* ---------------- step 2 ---------------- */
var options = document.querySelectorAll(".opt");
for (var i = 0; i < options.length; i++) {
    options[i].addEventListener("click", function () {
        if (this.disabled) return;
        for (var j = 0; j < options.length; j++) options[j].classList.remove("selected");
        this.classList.add("selected");
        selectedDest = this.dataset.dest;
        $("destContinueBtn").disabled = false;
        setStatus("destStatus", selectedDest === "drive"
            ? "Files land in a \\"Spidx Uploads\\" folder on your Drive, set to anyone-with-the-link."
            : "");
    });
}

$("destContinueBtn").addEventListener("click", async function () {
    var btn = $("destContinueBtn");
    btn.disabled = true;
    try {
        await fetch("/set-destination", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destination: selectedDest })
        });
    } catch (err) {}
    showStep(3);
});

/* ---------------- step 3 ---------------- */
$("copyPathBtn").addEventListener("click", function () {
    navigator.clipboard.writeText(state.incomingPath || "").then(function () {
        $("copyPathBtn").textContent = "Copied";
        setTimeout(function () { $("copyPathBtn").textContent = "Copy"; }, 1600);
    });
});

$("openPathBtn").addEventListener("click", async function () {
    try { await fetch("/open-incoming", { method: "POST" }); } catch (err) {}
});

$("installAeBtn").addEventListener("click", async function () {
    var btn = $("installAeBtn");
    btn.disabled = true;
    setStatus("hostsStatus", "Starting the After Effects panel installer — follow the window it opens.");
    try {
        var res = await fetch("/install-ae-panel", { method: "POST" });
        var data = await res.json();
        if (!data.ok) {
            setStatus("hostsStatus", data.message || "Could not start the installer.", "err");
            btn.disabled = false;
        } else {
            btn.textContent = "Installer opened";
        }
    } catch (err) {
        setStatus("hostsStatus", "Could not start the installer.", "err");
        btn.disabled = false;
    }
});

function applyVegasButtonState() {
    if (!state.vegasPanelAvailable) {
        $("installVegasBtn").disabled = true;
        $("installVegasBtn").textContent = "VEGAS plugin folder not found (VEGAS-Plugin)";
    } else {
        $("installVegasBtn").disabled = false;
        $("installVegasBtn").textContent = "Install the VEGAS Pro plugin";
    }
}

$("installVegasBtn").addEventListener("click", async function () {
    var btn = $("installVegasBtn");
    btn.disabled = true;
    setStatus("hostsStatus", "Starting the VEGAS Pro plugin installer — follow the window it opens.");
    try {
        var res = await fetch("/install-vegas-panel", { method: "POST" });
        var data = await res.json();
        if (!data.ok) {
            setStatus("hostsStatus", data.message || "Could not start the installer.", "err");
            btn.disabled = false;
        } else {
            btn.textContent = "Installer opened";
        }
    } catch (err) {
        setStatus("hostsStatus", "Could not start the installer.", "err");
        btn.disabled = false;
    }
});

$("installPproBtn").addEventListener("click", async function () {
    var btn = $("installPproBtn");
    btn.disabled = true;
    setStatus("hostsStatus", "Starting the Premiere Pro panel installer — follow the window it opens.");
    try {
        var res = await fetch("/install-ppro-panel", { method: "POST" });
        var data = await res.json();
        if (!data.ok) {
            setStatus("hostsStatus", data.message || "Could not start the installer.", "err");
            btn.disabled = false;
        } else {
            btn.textContent = "Installer opened";
        }
    } catch (err) {
        setStatus("hostsStatus", "Could not start the installer.", "err");
        btn.disabled = false;
    }
});

$("installPsBtn").addEventListener("click", async function () {
    var btn = $("installPsBtn");
    btn.disabled = true;
    setStatus("hostsStatus", "Opening the Photoshop panel installer...");
    try {
        var res = await fetch("/install-ps-panel", { method: "POST" });
        var data = await res.json();
        if (!data.ok) {
            setStatus("hostsStatus", data.message || "Could not install the Photoshop panel.", "err");
            btn.disabled = false;
        } else {
            btn.textContent = "Installer opened";
            setStatus("hostsStatus", "Allow the administrator prompt and follow the console window; when it finishes, restart Photoshop to see the panel.", "ok");
        }
    } catch (err) {
        setStatus("hostsStatus", "Could not install the Photoshop panel.", "err");
        btn.disabled = false;
    }
});

$("hostsContinueBtn").addEventListener("click", function () { showStep(4); });

/* ---------------- step 4 ---------------- */
$("finishBtn").addEventListener("click", async function () {
    var btn = $("finishBtn");
    btn.disabled = true;
    btn.textContent = "Starting Spidx Uploader...";
    try { await fetch("/finish", { method: "POST" }); } catch (err) {}
    document.querySelector(".card").innerHTML =
        '<div class="center"><div class="check">&#x1F680;</div>'
        + '<h1>You can close this tab</h1>'
        + '<p class="sub">Spidx Uploader is starting up — look for its icon near the clock.</p></div>';
});

loadState();
showStep(1);
</script>
</body>
</html>
`;

// Runs the wizard and resolves once the user clicks "Finish". Resolves
// (doesn't reject) even on internal errors — a broken wizard should never
// permanently block the helper from starting.
function runSetupWizard(log = console.log) {
    return new Promise(resolve => {
        let signedInEmail = null;
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };

        const server = http.createServer((req, res) => {
            let url;
            try {
                url = new URL(req.url, "http://127.0.0.1");
            } catch {
                res.writeHead(400);
                res.end();
                return;
            }

            if (url.pathname === "/" && req.method === "GET") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(WIZARD_HTML);
                return;
            }

            if (url.pathname === "/state" && req.method === "GET") {
                const known = readKnownAccount();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    email: known.email,
                    tier: known.tier,
                    driveAllowed: known.tier ? DRIVE_TIERS.has(known.tier) : true,
                    proFeaturesAllowed: known.tier ? DRIVE_TIERS.has(known.tier) : true,
                    pproAllowed: pproAllowed(known.tier, known.roles), // Pro rank OR the "spt" role
                    incomingPath: INCOMING_DIR,
                    aePanelAvailable: fs.existsSync(AE_INSTALLER),
                    pproPanelAvailable: fs.existsSync(PPRO_INSTALLER),
                    vegasPanelAvailable: fs.existsSync(VEGAS_INSTALLER),
                    psPanelAvailable: fs.existsSync(PS_INSTALLER_CCX) && fs.existsSync(PS_INSTALLER_BAT),
                    upiaAvailable: !!upia.getUpiaPath(),
                    consent: legal.consentSummary()
                }));
                return;
            }

            if (url.pathname === "/consent" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => { body += chunk; });
                req.on("end", () => {
                    try {
                        const parsed = JSON.parse(body || "{}");
                        if (parsed.accepted === true) legal.recordConsent(null);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, consent: legal.consentSummary() }));
                    } catch (err) {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, message: err.message }));
                    }
                });
                return;
            }

            if (url.pathname === "/signin" && req.method === "POST") {
                // Signing in sends data to the licence server - not without consent.
                if (!legal.hasValidConsent()) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: "Please accept the Terms of Service and the Privacy Policy first." }));
                    return;
                }
                (async () => {
                    try {
                        const googleAuth = require("./google-auth.js");
                        signedInEmail = await googleAuth.getUserEmail();
                        legal.attachEmail(signedInEmail);

                        // Resolve the tier right here rather than only at
                        // helper start: step 2 needs to know whether Drive
                        // is even selectable for this account, and showing
                        // it as available and silently forcing WorkUpload
                        // later would be worse than greying it out now.
                        let tier = "free";
                        let roles = ["free"];
                        let tierChecked = false;
                        try {
                            const license = require("./license.js");
                            const idToken = await googleAuth.getIdToken();
                            const result = await license.checkTier(idToken, signedInEmail);
                            tier = result.tier;
                            roles = result.roles || [result.tier];
                            tierChecked = true;
                        } catch (tierError) {
                            log(`Setup wizard tier check failed: ${tierError.message}`);
                        }

                        log(`Setup wizard: signed in as ${signedInEmail} (${tier}).`);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            ok: true,
                            email: signedInEmail,
                            tier,
                            tierChecked,
                            driveAllowed: DRIVE_TIERS.has(tier),
                            proFeaturesAllowed: DRIVE_TIERS.has(tier),
                            pproAllowed: pproAllowed(tier, roles)
                        }));
                    } catch (err) {
                        log(`Setup wizard sign-in failed: ${err.message}`);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, message: err.message }));
                    }
                })();
                return;
            }

            if (url.pathname === "/redeem-license" && req.method === "POST") {
                // Same redemption the Dashboard uses (Apps Script doPost,
                // verified via the Google ID token). No helper restart
                // needed: on a first run the helper isn't up yet and
                // reads the fresh tier when it starts.
                let body = "";
                req.on("data", chunk => { body += chunk; });
                req.on("end", async () => {
                    const reply = obj => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(obj));
                    };
                    try {
                        if (!signedInEmail && !readKnownAccount().email) {
                            reply({ ok: false, message: "Sign in with Google first." });
                            return;
                        }
                        const parsed = JSON.parse(body || "{}");
                        const { redeemLicenseCode } = require("./license-actions.js");
                        const result = await redeemLicenseCode(String(parsed.code || "").trim());
                        if (!result.ok) {
                            reply({ ok: false, message: result.message });
                            return;
                        }

                        // redeemLicenseCode() drops the tier cache; re-check
                        // right away so the cache is warm again and the tier
                        // reflects the 2-device rule, not just the code.
                        // the code's tier can be a combination ("pro+spt"): split it into rank + roles
                        const licenseMod = require("./license.js");
                        let roles = licenseMod.parseRoles(result.tier);
                        let tier = licenseMod.primaryTier(roles);
                        let trialDaysRemaining = result.trialDaysRemaining;
                        try {
                            const googleAuth = require("./google-auth.js");
                            const fresh = await licenseMod.checkTier(await googleAuth.getIdToken(), await googleAuth.getUserEmail());
                            tier = fresh.tier;
                            roles = fresh.roles || [fresh.tier];
                            trialDaysRemaining = fresh.trialDaysRemaining;
                        } catch (recheckError) {
                            log(`Setup wizard: tier re-check after redeem failed: ${recheckError.message}`);
                        }

                        log(`Setup wizard: license code redeemed - ${roles.join("+")}.`);
                        reply({
                            ok: true,
                            tier,
                            roles,
                            trialDaysRemaining,
                            driveAllowed: DRIVE_TIERS.has(tier),
                            proFeaturesAllowed: DRIVE_TIERS.has(tier),
                            pproAllowed: pproAllowed(tier, roles)
                        });
                    } catch (err) {
                        reply({ ok: false, message: err.message });
                    }
                });
                return;
            }

            if (url.pathname === "/signin-reset" && req.method === "POST") {
                // Same thing the tray's "Reset Google sign-in" does: drop
                // the saved token AND the tier cache, so the next sign-in
                // is a genuine account picker and not a silent re-use of
                // the account someone just said they didn't want.
                for (const file of [GOOGLE_TOKEN_FILE, LICENSE_CACHE_FILE]) {
                    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
                }
                signedInEmail = null;
                log("Setup wizard: saved Google login cleared.");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (url.pathname === "/open-incoming" && req.method === "POST") {
                const ok = openFolder(INCOMING_DIR, log);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok, path: INCOMING_DIR }));
                return;
            }

            if (url.pathname === "/install-ae-panel" && req.method === "POST") {
                try {
                    if (!fs.existsSync(AE_INSTALLER)) throw new Error("CEP-AE\\Install AE Panel.bat was not found next to the App folder.");
                    log(`Setup wizard: launching After Effects panel installer at "${AE_INSTALLER}".`);
                    spawnBatFile(AE_INSTALLER, log, (ok, message) => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: "Windows refused to start it: " + message }));
                    });
                } catch (err) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
                return;
            }

            if (url.pathname === "/install-ppro-panel" && req.method === "POST") {
                try {
                    const known = readKnownAccount();
                    if (!pproAllowed(known.tier, known.roles)) throw new Error("The Premiere Pro panel needs a Pro license or the Spidx Thumbnail Pack.");
                    if (!fs.existsSync(PPRO_INSTALLER)) throw new Error("CEP-PPRO\\Install PPRO Panel.bat was not found next to the App folder.");
                    log(`Setup wizard: launching Premiere Pro panel installer at "${PPRO_INSTALLER}".`);
                    spawnBatFile(PPRO_INSTALLER, log, (ok, message) => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: "Windows refused to start it: " + message }));
                    });
                } catch (err) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
                return;
            }

            if (url.pathname === "/install-vegas-panel" && req.method === "POST") {
                try {
                    if (!fs.existsSync(VEGAS_INSTALLER)) throw new Error("VEGAS-Plugin\\Install VEGAS Plugin.bat was not found next to the App folder.");
                    log(`Setup wizard: launching VEGAS Pro plugin installer at "${VEGAS_INSTALLER}".`);
                    spawnBatFile(VEGAS_INSTALLER, log, (ok, message) => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: "Windows refused to start it: " + message }));
                    });
                } catch (err) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
                return;
            }

            if (url.pathname === "/install-ps-panel" && req.method === "POST") {
                try {
                    if (!fs.existsSync(PS_INSTALLER_BAT) || !fs.existsSync(PS_INSTALLER_CCX)) throw new Error("The Photoshop panel files (UXP folder) were not found next to the App folder.");
                    if (!upia.getUpiaPath()) throw new Error("Creative Cloud desktop app was not found — it's what installs Photoshop plugins. Install it, then try again.");
                    log(`Setup wizard: launching Photoshop panel installer at "${PS_INSTALLER_BAT}".`);
                    spawnBatFile(PS_INSTALLER_BAT, log, (ok, message) => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: "Windows refused to start it: " + message }));
                    });
                } catch (err) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, message: err.message }));
                }
                return;
            }

            if (url.pathname === "/set-destination" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => { body += chunk; });
                req.on("end", () => {
                    try {
                        const parsed = JSON.parse(body || "{}");
                        const destination = parsed.destination === "drive" ? "drive" : "workupload";
                        const cfg = readHelperConfig();
                        cfg.destination = destination;
                        writeHelperConfig(cfg);
                        log(`Setup wizard: destination set to "${destination}".`);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true }));
                    } catch (err) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, message: err.message }));
                    }
                });
                return;
            }

            if (url.pathname === "/finish" && req.method === "POST") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                log(`Setup wizard complete${signedInEmail ? ` (${signedInEmail})` : ""}.`);
                setTimeout(() => {
                    server.close();
                    finish();
                }, 200);
                return;
            }

            res.writeHead(404);
            res.end();
        });

        server.on("error", err => {
            log(`Setup wizard server error: ${err.message}`);
            finish(); // never block startup forever on a server error
        });

        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            const url = `http://127.0.0.1:${port}/`;
            log("First run detected — opening the setup wizard in your browser...");
            log(`If it doesn't open automatically, visit: ${url}`);
            openInBrowser(url, log);
        });
    });
}

module.exports = { runSetupWizard };
