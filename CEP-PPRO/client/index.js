"use strict";

/* ========================================================================
 *  Spidx Uploader — Premiere Pro panel (CEP)
 *
 *  Port of the After Effects panel (CEP-AE/client/index.js). It speaks
 *  the exact same protocol as the AE and Photoshop panels — small files
 *  inside App\incoming:
 *
 *    .batch-config.json   written here  — how many files the engine waits for
 *    .batch-status.json   read here     — live collection/upload progress
 *    .engine-status.json  read here     — tier, destination, device limit
 *    .batch-force-send    written here  — "Send now"
 *    .batch-cancel        written here  — "Cancel"
 *
 *  so one running Spider Engine serves Photoshop, After Effects and
 *  Premiere Pro at the same time with no changes on its side.
 *
 *  The panel does one thing on purpose: export the active sequence's
 *  current frame, always as PNG. See host/spidx.jsx for how that export
 *  actually happens (it's the one part of this port that couldn't stay
 *  a straight copy — Premiere has no AE-style saveFrameToPng()).
 *
 *  No Node.js is required: everything goes through CEP's own cep.fs API,
 *  which is always present, instead of --enable-nodejs.
 * ==================================================================== */

var FOLDER_KEY = "spidx_ppro_incoming_path";
var BATCH_COUNT_KEY = "spidx_ppro_batch_count";
var FOLDER_NAME_KEY = "spidx_ppro_folder_name";
// Manual override for pngframe.epr — spidxPresetPath() in spidx.jsx
// already auto-finds it (Media Encoder's Presets folder, or the
// extension's own presets/ folder), so this is empty by default and
// only needs setting if auto-detection genuinely can't find it on a
// given machine.
var PRESET_KEY = "spidx_ppro_preset_path";

var BATCH_CONFIG_NAME = ".batch-config.json";
var BATCH_STATUS_NAME = ".batch-status.json";
var ENGINE_STATUS_NAME = ".engine-status.json";
// Mirrored by server.js's syncDefaultCameraRawPreset() whenever the
// Dashboard's preset fields change — reading it here (instead of
// re-deriving anything) means this indicator can never drift from
// what actually happens to the file after Upload is clicked.
var CAMERA_RAW_PRESET_NAME = ".default-camera-raw-preset.json";
var BATCH_FORCE_SEND_NAME = ".batch-force-send";
var BATCH_CANCEL_NAME = ".batch-cancel";
var POLL_MS = 1500;

// Spidx Engine 2.5 re-stamps .engine-status.json every 15s; older than
// this means nothing is watching the incoming folder.
var ENGINE_STALE_MS = 2 * 60 * 1000;

var MULTI_BATCH_TIERS = ["pro", "dev", "tester"];
// Same tier set gates every Pro+ feature (batch 2/3, Photoshop + Upload,
// the Properties tab) — one name, used everywhere below.
var PRO_FEATURE_TIERS = MULTI_BATCH_TIERS;

/* ---------------------------------------------------------------------- */
/*  Settings storage                                                      */
/* ---------------------------------------------------------------------- */

// CEP keeps a panel's localStorage inside a cache folder named after the
// extension id + VERSION (%TEMP%\cep_cache\...), and "Install PPRO Panel.bat"
// deletes and re-creates the extension folder - so every panel update or
// reinstall started with empty settings (incoming folder, batch count, preset
// path "forgotten"). Everything is therefore ALSO mirrored into a small file
// under %APPDATA%\Spidx Uploader\, which survives updates. localStorage stays
// the fast path; the file only fills in what localStorage is missing.
var CONFIG_DIR_NAME = "Spidx Uploader";
var CONFIG_FILE_NAME = "ppro-panel-config.json";

function userDataDir() {
    try {
        var raw = decodeURI(window.__adobe_cep__.getSystemPath("userData"));
        if (!raw) return null;
        if (/^file:\/\/\/[A-Za-z]:/i.test(raw)) return raw.replace(/^file:\/\/\//i, ""); // Windows: file:///C:/...
        return raw.replace(/^file:\/\//i, "");                                           // macOS:   file:///Users/...
    } catch (err) {
        return null;
    }
}

// This panel's own folder on disk (where host/, client/ and mogrts/ live).
function extensionPath() {
    try {
        var raw = decodeURI(window.__adobe_cep__.getSystemPath("extension"));
        if (!raw) return "";
        if (/^file:\/\/\/[A-Za-z]:/i.test(raw)) return raw.replace(/^file:\/\/\//i, "");
        return raw.replace(/^file:\/\//i, "");
    } catch (err) {
        return "";
    }
}

var store = (function () {
    var cache = null;

    function paths() {
        var base = userDataDir();
        if (!base) return null;
        var dir = base.replace(/[\\/]+$/, "") + "/" + CONFIG_DIR_NAME;
        return { dir: dir, file: dir + "/" + CONFIG_FILE_NAME };
    }

    function load() {
        if (cache) return cache;
        cache = {};
        try {
            var p = paths();
            if (p) {
                var result = window.cep.fs.readFile(p.file);
                if (!result.err && result.data) cache = JSON.parse(result.data) || {};
            }
        } catch (err) {
            cache = {};
        }
        return cache;
    }

    function save() {
        try {
            var p = paths();
            if (!p) return;
            window.cep.fs.makedir(p.dir); // an error just means it already exists
            window.cep.fs.writeFile(p.file, JSON.stringify(cache));
        } catch (err) { /* settings still live in localStorage */ }
    }

    return {
        get: function (key) {
            var value = null;
            try { value = localStorage.getItem(key); } catch (err) {}
            if (value === null || value === undefined || value === "") {
                var fromFile = load()[key];
                if (fromFile !== undefined && fromFile !== null) value = String(fromFile);
            }
            return value;
        },
        set: function (key, value) {
            try { localStorage.setItem(key, value); } catch (err) {}
            load()[key] = String(value);
            save();
        }
    };
})();

var incomingPath = store.get(FOLDER_KEY) || "";
var presetOverride = store.get(PRESET_KEY) || "";
var selectedBatchCount = 1;
var currentTier = null;
var currentRoles = [];      // every role of the licence, e.g. ["pro", "spt"] (the helper sends them next to the rank)
var currentRolesKey = "";
var pendingBatchCount = 0; // the saved 2/3 count, applied once the tier is known to allow it
var currentDestination = "workupload";
var currentDeviceLimitReached = false;
var lastBatchState = null;
var busy = false;
var engineOnline = null;

/* ---------------------------------------------------------------------- */
/*  Element handles                                                       */
/* ---------------------------------------------------------------------- */

function $(id) { return document.getElementById(id); }

var card = $("card");
var cardTitle = $("cardTitle");
var cardSub = $("cardSub");
var routeLine = $("routeLine");
var progFill = $("progFill");
var uploadButton = $("upload");
var uploadPsButton = $("uploadPs");
var tabBtnProps = $("tabBtnProps");
var tierBadge = $("tierBadge");
var deviceLimitWarning = $("deviceLimitWarning");
var folderNameRow = $("folderNameRow");
var folderNameInput = $("folderNameInput");
var fileRow = $("fileRow");
var fileThumb = $("fileThumb");
var fileName = $("fileName");
var fileSize = $("fileSize");
var batchProgress = $("batchProgress");
var batchDots = $("batchDots");
var batchProgressText = $("batchProgressText");
var folderPathLabel = $("folderPath");
var presetPathLabel = $("presetPathLabel");

var batchButtons = Array.prototype.slice.call(document.querySelectorAll(".batch-opt"));

/* ---------------------------------------------------------------------- */
/*  CEP plumbing — ExtendScript calls + file system                       */
/* ---------------------------------------------------------------------- */

function evalScript(script) {
    return new Promise(function (resolve, reject) {
        if (!window.__adobe_cep__) {
            reject(new Error("This panel is not running inside Premiere Pro."));
            return;
        }
        window.__adobe_cep__.evalScript(script, function (result) {
            if (result === "EvalScript error.") {
                reject(new Error("Premiere Pro could not run the panel's script (host/spidx.jsx)."));
                return;
            }
            var parsed;
            try {
                parsed = JSON.parse(result);
            } catch (err) {
                reject(new Error("Unexpected response from Premiere Pro: " + result));
                return;
            }
            if (!parsed.ok) reject(new Error(parsed.message || "Premiere Pro reported an error."));
            else resolve(parsed);
        });
    });
}

function esArg(value) {
    return JSON.stringify(String(value == null ? "" : value));
}

function joinPath(folder, name) {
    return folder.replace(/[\\/]+$/, "") + "/" + name;
}

function readTextFile(fullPath) {
    try {
        var result = window.cep.fs.readFile(fullPath);
        if (result.err) return null;
        return result.data;
    } catch (err) {
        return null;
    }
}

function writeTextFile(fullPath, text) {
    try {
        var result = window.cep.fs.writeFile(fullPath, text);
        return !result.err;
    } catch (err) {
        return false;
    }
}

function readJsonFile(fullPath) {
    var text = readTextFile(fullPath);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

function folderExists(fullPath) {
    try {
        var result = window.cep.fs.readdir(fullPath);
        return !result.err;
    } catch (err) {
        return false;
    }
}

function pickFolder() {
    var result = window.cep.fs.showOpenDialog(false, true, "Choose the App\\incoming folder", incomingPath || "");
    if (result.err || !result.data || !result.data.length) return null;
    return String(result.data[0]);
}

/* ---------------------------------------------------------------------- */
/*  UI helpers                                                            */
/* ---------------------------------------------------------------------- */

function setCard(title, sub, state) {
    card.classList.remove("ok", "error");
    cardSub.classList.remove("ok", "error");
    cardTitle.textContent = title;
    cardSub.textContent = sub || "";
    if (state) {
        card.classList.add(state);
        cardSub.classList.add(state);
    }
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
}

function setProgress(percent, done) {
    progFill.classList.remove("indeterminate");
    progFill.style.width = percent + "%";
    progFill.classList.toggle("done", !!done);
}

function setProgressIndeterminate(on) {
    progFill.classList.toggle("indeterminate", !!on);
    if (!on) progFill.style.width = "0%";
}

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function showFile(name, bytes) {
    var ext = (name.split(".").pop() || "FILE").toUpperCase();
    fileThumb.textContent = ext.length > 4 ? ext.slice(0, 4) : ext;
    fileName.textContent = name;
    fileSize.textContent = formatBytes(bytes);
    fileRow.classList.add("show");
}

function hideFile() { fileRow.classList.remove("show"); }

function updateFolderLabel() {
    folderPathLabel.textContent = incomingPath || "no folder linked";
    folderPathLabel.title = incomingPath;
}

/* ---------------------------------------------------------------------- */
/*  Batch selector — identical semantics to the Photoshop panel           */
/* ---------------------------------------------------------------------- */

function tierAllowsMultiBatch() {
    return MULTI_BATCH_TIERS.indexOf(currentTier) !== -1;
}

function tierAllowsProFeatures() {
    return PRO_FEATURE_TIERS.indexOf(currentTier) !== -1;
}

// The MOGRT tab belongs to its own role: "spt" (the add-on), plus "dev" and "tester".
// It is deliberately NOT part of Pro. To include Pro customers, add "pro" here -
// that one line is the only change needed. Roles combine: a licence of
// "pro+spt" has both, so it gets Pro's features AND this tab.
var SPT_ROLES = ["spt", "dev", "tester"];

// All roles of this licence (an older helper that only sends the rank counts as one role).
function currentRoleList() {
    return currentRoles.length ? currentRoles : (currentTier ? [currentTier] : []);
}

function tierAllowsMogrt() {
    var roles = currentRoleList();
    for (var i = 0; i < SPT_ROLES.length; i++) {
        if (roles.indexOf(SPT_ROLES[i]) !== -1) return true;
    }
    return false;
}

// "PRO + SPT" - what the badge and the lock message show.
function roleLabel(roles) {
    var shown = roles.filter(function (r) { return r !== "free" || roles.length === 1; });
    return shown.join(" + ").toUpperCase();
}

// Locks the MOGRT tab for tiers without the SPT role: the tab stays clickable (so the
// message can say what is missing) but the templates themselves are hidden.
function updateMogrtLock() {
    var tabBtn = $("tabBtnMogrt");
    var locked = !tierAllowsMogrt();
    if (tabBtn) {
        tabBtn.classList.toggle("locked", locked);
        tabBtn.title = locked ? "MOGRT templates need the SPT role." : "";
    }
    var lockCard = $("mogrtLocked");
    var body = $("mogrtBody");
    if (lockCard && body) {
        lockCard.style.display = locked ? "" : "none";
        body.style.display = locked ? "none" : "";
        var roleList = currentRoleList();
        $("mogrtLockedText").textContent = "Your role: " + (roleList.length ? roleLabel(roleList) : "unknown (is the helper running?)")
            + ". The MOGRT templates are a separate add-on - ask for the SPT role to unlock this tab.";
    }
    if (!locked && currentTab === "tabMogrt" && !mogrtsLoadedOnce) mogrtsLoad();
}

// Free-tier lockout for the Properties tab. Runs whenever the tier
// changes; also called once on load once currentTier is known.
function updateProFeatureLocks() {
    if (!tabBtnProps) return;
    var locked = !tierAllowsProFeatures();
    tabBtnProps.classList.toggle("locked", locked);
    tabBtnProps.title = locked ? "Properties is a Pro feature — upgrade to use it." : "";
    // Don't strand the user on a tab that just got locked out from under them.
    if (locked && currentTab === "tabProps") activateTab("tabUploader");
}

function updateFolderNameVisibility() {
    folderNameRow.classList.toggle("show", currentDestination === "drive" && selectedBatchCount > 1);
}

function setBatchControlsLocked(locked) {
    var allowMulti = tierAllowsMultiBatch();
    batchButtons.forEach(function (btn) {
        var count = Number(btn.dataset.count) || 1;
        var tierBlocked = count > 1 && !allowMulti;
        btn.disabled = locked || tierBlocked;
        btn.title = tierBlocked ? "Pro only" : "";
    });
    folderNameInput.disabled = locked;
}

function setSelectedBatchCount(count, persist) {
    selectedBatchCount = count;
    if (persist !== false) store.set(BATCH_COUNT_KEY, String(count));
    batchButtons.forEach(function (btn) {
        btn.classList.toggle("active", Number(btn.dataset.count) === count);
    });
    updateFolderNameVisibility();
}

batchButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
        if (btn.disabled) return;
        setSelectedBatchCount(Number(btn.dataset.count) || 1);
        writeBatchConfig();
    });
});

folderNameInput.addEventListener("input", function () {
    store.set(FOLDER_NAME_KEY, folderNameInput.value);
});

function writeBatchConfig() {
    if (!incomingPath) return;
    writeTextFile(
        joinPath(incomingPath, BATCH_CONFIG_NAME),
        JSON.stringify({ targetCount: selectedBatchCount, folderName: folderNameInput.value || "" })
    );
}

/* ---------------------------------------------------------------------- */
/*  Incoming folder                                                       */
/* ---------------------------------------------------------------------- */

function ensureIncomingFolder(forcePicker) {
    if (!forcePicker && incomingPath && folderExists(incomingPath)) return incomingPath;

    setCard("Select folder", "Choose the App\\incoming folder...");
    var picked = pickFolder();
    if (!picked) throw new Error("No incoming folder was selected.");

    incomingPath = picked;
    store.set(FOLDER_KEY, incomingPath);
    updateFolderLabel();
    return incomingPath;
}

$("changeFolder").addEventListener("click", function () {
    if (busy) return;
    try {
        ensureIncomingFolder(true);
        setCard("Folder updated", "Ready to export", "ok");
    } catch (error) {
        setCard("Folder unchanged", error.message, "error");
    }
});

/* ---------------------------------------------------------------------- */
/*  Preset (.epr) override                                                */
/*                                                                         */
/*  spidxPresetPath() in spidx.jsx already auto-finds pngframe.epr, so    */
/*  this only matters when auto-detection genuinely can't — an unusual    */
/*  Media Encoder install location, a renamed preset, etc. Empty means    */
/*  "let the host script keep auto-detecting", same as before this        */
/*  existed.                                                              */
/* ---------------------------------------------------------------------- */

function updatePresetLabel() {
    if (!presetPathLabel) return;
    presetPathLabel.textContent = presetOverride || "auto-detected";
    presetPathLabel.title = presetOverride;
}

$("changePreset").addEventListener("click", function () {
    if (busy) return;
    var result = window.cep.fs.showOpenDialog(false, false, "Choose pngframe.epr", presetOverride || "");
    if (result.err || !result.data || !result.data.length) return;
    presetOverride = String(result.data[0]);
    store.set(PRESET_KEY, presetOverride);
    updatePresetLabel();
    setCard("Preset updated", "Using: " + presetOverride, "ok");
});

/* ---------------------------------------------------------------------- */
/*  Status polling (engine + batch)                                       */
/* ---------------------------------------------------------------------- */

function applyEngineStatus(status) {
    renderPresetSelect(status && status.presets, status && status.activePreset, status && status.activePresetModified);
    var stamp = status && Number(status.updatedAt);
    var online = !!(stamp && (Date.now() - stamp) < ENGINE_STALE_MS);

    if (online !== engineOnline) {
        engineOnline = online;
        if (!online) {
            setCard(
                "Helper not running",
                'Start "Spidx Uploader.vbs" (or the desktop shortcut) — nothing is watching the incoming folder right now.',
                "error"
            );
            setProgress(0);
        } else if (!busy) {
            setCard("Ready", "Helper is running — export away.", "ok");
        }
    }

    if (online && status && status.state === "error" && status.message && !busy) {
        setCard("Helper problem", status.message, "error");
    }

    if (!status) return;

    if (typeof status.destination === "string") currentDestination = status.destination;
    currentDeviceLimitReached = !!status.deviceLimitReached;

    var tier = typeof status.tier === "string" ? status.tier : null;
    var roles = (status.roles && typeof status.roles.length === "number")
        ? Array.prototype.slice.call(status.roles).map(String)
        : (tier ? [tier] : []);
    var rolesKey = roles.join("+");
    if (tier !== currentTier || rolesKey !== currentRolesKey) {
        currentTier = tier;
        currentRoles = roles;
        currentRolesKey = rolesKey;
        if (!tierAllowsMultiBatch() && selectedBatchCount > 1) setSelectedBatchCount(1);
        if (tierAllowsMultiBatch() && pendingBatchCount > 1) {
            setSelectedBatchCount(pendingBatchCount);
            pendingBatchCount = 0;
        }
        setBatchControlsLocked(false);
        updateProFeatureLocks();
        updateMogrtLock();
    }

    // badge: the rank's colour, all roles in the text ("PRO + SPT")
    var badgeClass = ["dev", "tester", "pro", "spt", "free"].filter(function (r) { return roles.indexOf(r) !== -1; })[0];
    tierBadge.className = "tier-badge" + (badgeClass ? " show tier-" + badgeClass : "");
    if (badgeClass) {
        tierBadge.textContent = roleLabel(roles)
            + (status.trialDaysRemaining ? " (" + status.trialDaysRemaining + "D)" : "");
    }

    deviceLimitWarning.classList.toggle("show", currentDeviceLimitReached);
    updateFolderNameVisibility();
}

function renderBatchDots(have, target) {
    batchDots.innerHTML = "";
    for (var i = 0; i < target; i++) {
        var dot = document.createElement("div");
        dot.className = "dot" + (i < have ? " filled" : "");
        batchDots.appendChild(dot);
    }
}

function applyBatchStatus(status) {
    var state = status ? status.state : "idle";

    if (state === "collecting") {
        batchProgress.classList.add("show");
        renderBatchDots(status.have || 0, status.target || selectedBatchCount);
        batchProgressText.textContent = (status.have || 0) + " of " + (status.target || "?") + " received";
        setBatchControlsLocked(true);
    } else {
        batchProgress.classList.remove("show");
        if (!busy) setBatchControlsLocked(false);
    }

    if (state === "uploading" && lastBatchState !== "uploading") {
        setCard("Uploading...", "Spider Engine is sending the file(s) now.");
        setProgressIndeterminate(true);
    }

    if (state === "done" && lastBatchState !== "done") {
        setProgressIndeterminate(false);
        setProgress(100, true);
        var links = (status && status.links) || [];
        setCard(
            "Uploaded",
            links.length ? "Link copied to the clipboard." : "Sent — no link was detected.",
            "ok"
        );
        setSelectedBatchCount(1);
        writeBatchConfig();
    }

    lastBatchState = state;
}

function poll() {
    if (currentTab === "tabProps") propsRefresh(); // keeps the Properties tab live without a manual Refresh click
    if (!incomingPath) return;
    applyEngineStatus(readJsonFile(joinPath(incomingPath, ENGINE_STATUS_NAME)));
    applyBatchStatus(readJsonFile(joinPath(incomingPath, BATCH_STATUS_NAME)));
    updateRouteLine();
    checkCaptureRequest();
}

// The "Photoshop + Upload" button only makes sense once there's an
// Action configured for it to run — read the same file the Dashboard
// writes so this can never drift from what server.js will actually do
// with the file.
function updateRouteLine() {
    if (!incomingPath) return;
    var preset = readJsonFile(joinPath(incomingPath, CAMERA_RAW_PRESET_NAME));
    var hasPreset = !!(preset && preset.actionName);

    var proAllowed = tierAllowsProFeatures();
    if (uploadPsButton) uploadPsButton.disabled = busy || !hasPreset || !proAllowed;
    if (routeLine) {
        routeLine.textContent = !proAllowed
            ? "Photoshop + Upload is a Pro feature — upgrade your tier to enable it."
            : hasPreset
                ? "Photoshop + Upload runs \u201c" + preset.actionName + "\u201d \u2014 requires Photoshop already open."
                : "Set a Camera Raw Action in the Dashboard to enable Photoshop + Upload.";
    }
}

$("sendNow").addEventListener("click", function () {
    if (!incomingPath) return;
    writeTextFile(joinPath(incomingPath, BATCH_FORCE_SEND_NAME), String(Date.now()));
    setCard("Sending now", "Pushing through whatever has been collected.");
});

$("cancelBatch").addEventListener("click", function () {
    if (!incomingPath) return;
    writeTextFile(joinPath(incomingPath, BATCH_CANCEL_NAME), String(Date.now()));
    setCard("Batch cancelled", "Nothing was uploaded.");
    setProgress(0);
});

/* ---------------------------------------------------------------------- */
/*  Upload                                                                */
/* ---------------------------------------------------------------------- */

function performUpload(viaPhotoshop) {
    if (busy) return;
    if (viaPhotoshop && !tierAllowsProFeatures()) {
        setCard("Photoshop + Upload is Pro", "Upgrade your tier to use this route.", "error");
        return;
    }

    var activeButton = viaPhotoshop ? uploadPsButton : uploadButton;
    var otherButton = viaPhotoshop ? uploadButton : uploadPsButton;
    var defaultLabel = viaPhotoshop ? "Photoshop + Upload" : "Upload";

    busy = true;
    activeButton.disabled = true;
    if (otherButton) otherButton.disabled = true;
    activeButton.classList.remove("success", "error");
    activeButton.textContent = "Exporting...";
    hideFile();
    setProgress(10);

    var task;
    try {
        ensureIncomingFolder(false);
        if (selectedBatchCount > 1 && !tierAllowsMultiBatch()) setSelectedBatchCount(1); // multi-file is Pro only
        writeBatchConfig();

        if (engineOnline === false) {
            // Not a hard block: the frame still lands in incoming and gets
            // picked up whenever the helper comes back. The panel just
            // stops pretending it was sent.
            setCard("Helper not running", "Saving the frame anyway — it uploads when the helper starts.", "error");
        }

        setCard("Saving frame...", "Exporting the current frame as PNG.");
        setProgress(45);
        // The second argument only changes the saved filename (adds a
        // .ps marker before .png) — server.js's needsCameraRaw() is what
        // actually decides whether to route it through Photoshop, based
        // on that marker plus a configured preset. See server.js.
        task = evalScript("spidxSaveFrame(" + esArg(incomingPath) + ", " + (viaPhotoshop ? "true" : "false") + ", " + esArg(presetOverride) + ")");
    } catch (error) {
        finishUpload(error, null, activeButton, otherButton, defaultLabel);
        return;
    }

    task.then(function (result) { finishUpload(null, result, activeButton, otherButton, defaultLabel); })
        .catch(function (error) { finishUpload(error, null, activeButton, otherButton, defaultLabel); });
}

function finishUpload(error, result, activeButton, otherButton, defaultLabel) {
    setProgressIndeterminate(false);
    busy = false;
    activeButton.disabled = false;
    if (otherButton) otherButton.disabled = false;
    updateRouteLine(); // re-applies the PS button's own enabled/disabled state

    if (error) {
        setCard("Error", error.message, "error");
        setProgress(0);
        activeButton.textContent = "Try again";
        activeButton.classList.add("error");
        return;
    }

    var names = result.names || [result.name];
    setProgress(100, true);
    showFile(names[0], result.size);

    if (selectedBatchCount > 1) {
        setCard(
            "Added to batch",
            "Waiting for the rest (" + selectedBatchCount + " total) — export the next one the same way.",
            "ok"
        );
    } else {
        setCard(
            names.length > 1 ? names.length + " files ready" : "File ready",
            "The helper will compress and send it automatically.",
            "ok"
        );
    }

    activeButton.textContent = "Done";
    activeButton.classList.add("success");

    setTimeout(function () {
        if (!activeButton.classList.contains("error")) {
            activeButton.textContent = defaultLabel;
            activeButton.classList.remove("success");
        }
    }, 2500);
}

uploadButton.addEventListener("click", function () { performUpload(false); });
if (uploadPsButton) uploadPsButton.addEventListener("click", function () { performUpload(true); });

document.addEventListener("keydown", function (event) {
    var key = (event.key || "").toLowerCase();
    if (event.ctrlKey && event.shiftKey && key === "q") {
        event.preventDefault();
        performUpload(false);
    }
});

/* ------------------------------------------------------------------ */
/*  Tabs                                                                */
/* ------------------------------------------------------------------ */

var tabButtons = document.querySelectorAll(".tab-btn");
var currentTab = "tabUploader";

function activateTab(target) {
    if (target === "tabProps" && !tierAllowsProFeatures()) {
        setCard("Properties is Pro", "Upgrade your tier to edit Essential Graphics text properties from here.", "error");
        return;
    }
    currentTab = target;
    for (var i = 0; i < tabButtons.length; i++) tabButtons[i].classList.toggle("active", tabButtons[i].getAttribute("data-tab") === target);
    var pages = document.querySelectorAll(".tab-page");
    for (var j = 0; j < pages.length; j++) pages[j].classList.toggle("active", pages[j].id === target);
    if (target === "tabLeaderboard" && !lbLoadedOnce) lbLoad();
    if (target === "tabProps") {
        if (!lbLoadedOnce) lbLoad();
        propsRefresh(); // immediate — poll() then keeps it live every POLL_MS without a manual Refresh
    }
    if (target === "tabMogrt") updateMogrtLock(); // loads the templates the first time, when the role allows it
}

for (var ti = 0; ti < tabButtons.length; ti++) {
    tabButtons[ti].addEventListener("click", function () { activateTab(this.getAttribute("data-tab")); });
}

updateProFeatureLocks(); // initial paint — starts locked until the first engine-status read confirms tier

/* ------------------------------------------------------------------ */
/*  Leaderboard tab — SpidxTracker (Fortnite)                           */
/*                                                                      */
/*  Ported from the standalone SpidxLeaderboardPanel.jsx ScriptUI       */
/*  panel. Fetching and rendering happen here in plain JS (a CEP panel  */
/*  is just Chromium — fetch()/DOM beats the old raw-Socket-and-temp-   */
/*  .bat-file approach that ScriptUI needed). Only touching the actual  */
/*  AE layer (insert / Essential Graphics) still goes through           */
/*  ExtendScript — see spidxLeaderboardInsertAndExpose() in spidx.jsx.  */
/* ------------------------------------------------------------------ */

var LB_API_HOST = "http://169.58.221.14:8080";
var LB_CACHE_NAME = ".leaderboard-cache.json";

var lbRegion = $("lbRegion");
var lbSearch = $("lbSearch");
var lbRefreshBtn = $("lbRefresh");
var lbStatus = $("lbStatus");
var lbRows = $("lbRows");
var lbCopyBtn = $("lbCopy");
var lbMessage = $("lbMessage");

var lbPlayers = [];
var lbSelectedIndex = -1;
var lbSearchTimer = null;
var lbLoadedOnce = false;
var mogrtsLoadedOnce = false;

function lbCacheFile() {
    return incomingPath ? joinPath(incomingPath, LB_CACHE_NAME) : null;
}

function lbSaveCache(players) {
    var file = lbCacheFile();
    if (!file) return;
    writeTextFile(file, JSON.stringify({ savedAt: Date.now(), players: players }));
}

function lbCacheAgeText(savedAt) {
    var mins = Math.round((Date.now() - savedAt) / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    var hours = Math.round(mins / 60);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
}

function lbUseCache(reasonWhyLive) {
    var file = lbCacheFile();
    var cache = file ? readJsonFile(file) : null;
    if (!cache || !cache.players || !cache.players.length) {
        lbPlayers = [];
        lbRenderRows();
        lbStatus.textContent = reasonWhyLive;
        lbStatus.className = "card-sub error";
        return;
    }
    lbPlayers = cache.players;
    lbRenderRows();
    lbStatus.textContent = "Offline \u2014 cached data from " + lbCacheAgeText(cache.savedAt)
        + " (" + lbPlayers.length + " players) \u00b7 " + reasonWhyLive;
    lbStatus.className = "card-sub error";
}

function lbFormatNumber(n) {
    n = Math.round(Number(n) || 0);
    var s = String(n);
    var out = "";
    var c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
        out = s.charAt(i) + out;
        c++;
        if (c % 3 === 0 && i !== 0) out = " " + out;
    }
    return out;
}

function lbRenderRows() {
    lbRows.innerHTML = "";
    lbSelectedIndex = -1;
    lbCopyBtn.disabled = true;
    lbMessage.textContent = "";
    propsShowSelectedNick(null); // list just changed/refreshed — the old selection no longer applies

    if (!lbPlayers.length) {
        var empty = document.createElement("div");
        empty.className = "lb-empty";
        empty.textContent = "No players to show.";
        lbRows.appendChild(empty);
        return;
    }

    lbPlayers.forEach(function (p, idx) {
        var row = document.createElement("div");
        row.className = "lb-item";
        if (idx < 8) row.style.animationDelay = (idx * 20) + "ms";
        row.innerHTML = "<span>" + (p.rank != null ? p.rank : idx + 1) + "</span>"
            + "<span>" + escapeHtml(p.alias || p.name || "?") + "</span>"
            + "<span class=\"pts\">" + lbFormatNumber(p.points) + "</span>";
        row.addEventListener("click", function () { lbSelectRow(idx); });
        lbRows.appendChild(row);
    });
}

function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
}

function lbSelectRow(idx) {
    lbSelectedIndex = idx;
    lbMessage.textContent = "";
    var items = lbRows.querySelectorAll(".lb-item");
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("selected", i === idx);
    lbCopyBtn.disabled = false;

    var player = lbPlayers[idx];
    var nick = player ? (player.alias || player.name || "") : "";
    if (propsNickInput) propsNickInput.value = nick;
    if (mogrtNickInput) mogrtNickInput.value = nick;
    propsShowSelectedNick(nick);
}

function lbSelectedPlayer() {
    if (lbSelectedIndex < 0) return null;
    return lbPlayers[lbSelectedIndex] || null;
}

function lbQuery() {
    var parts = [];
    var region = lbRegion.value;
    if (region !== "All") parts.push("region=" + encodeURIComponent(region));
    var search = lbSearch.value.replace(/^\s+|\s+$/g, "");
    if (search) parts.push("search=" + encodeURIComponent(search));
    parts.push("sort=points&order=desc");
    return parts.length ? ("?" + parts.join("&")) : "";
}

function lbLoad() {
    lbLoadedOnce = true;
    lbCopyBtn.disabled = true;
    lbMessage.textContent = "";
    lbStatus.textContent = "Loading...";
    lbStatus.className = "card-sub";

    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;

    fetch(LB_API_HOST + "/api/fortnite" + lbQuery(), controller ? { signal: controller.signal } : {})
        .then(function (res) {
            if (timeoutId) clearTimeout(timeoutId);
            if (!res.ok) throw new Error("Server responded with " + res.status);
            return res.json();
        })
        .then(function (json) {
            if (!json || !json.success) {
                lbUseCache("API responded, but without the expected data.");
                return;
            }
            lbPlayers = json.data || [];
            if (!lbPlayers.length) {
                lbRenderRows();
                lbStatus.textContent = "No results for the current filters.";
                lbStatus.className = "card-sub error";
                return;
            }
            lbRenderRows();
            lbSaveCache(lbPlayers);
            lbStatus.textContent = "Connected \u00b7 " + lbPlayers.length + " players";
            lbStatus.className = "card-sub ok";
        })
        .catch(function (err) {
            if (timeoutId) clearTimeout(timeoutId);
            lbUseCache(err && err.message ? err.message : "Could not reach the leaderboard server.");
        });
}

function lbCopyToClipboard(text) {
    try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch (err) {
        return false;
    }
}

lbCopyBtn.addEventListener("click", function () {
    var player = lbSelectedPlayer();
    if (!player) return;
    var nick = player.alias || player.name || "";
    var ok = lbCopyToClipboard(nick);
    lbMessage.textContent = ok ? ("Copied: " + nick) : "Could not copy to clipboard.";
    lbMessage.className = ok ? "card-sub ok" : "card-sub error";
});



lbRefreshBtn.addEventListener("click", lbLoad);
lbRegion.addEventListener("change", lbLoad);
lbSearch.addEventListener("input", function () {
    clearTimeout(lbSearchTimer);
    lbSearchTimer = setTimeout(lbLoad, 400);
});

/* ------------------------------------------------------------------ */
/*  Properties tab — push a Leaderboard nick into an Essential          */
/*  Graphics (MOGRT) text property on the clip selected in the          */
/*  Timeline. See spidxListGraphicTextProperties() / spidxSetGraphicText() */
/*  in host/spidx.jsx for the ExtendScript side of this.                */
/* ------------------------------------------------------------------ */

var propsStatus = $("propsStatus");
var propsSelect = $("propsSelect");
var propsNickHint = $("propsNickHint");
var propsNickInput = $("propsNickInput");
var propsApplyBtn = $("propsApply");
var propsMessage = $("propsMessage");
var propsApplying = false; // guards against poll()'s auto-refresh rebuilding the dropdown mid-click

// Reflects whatever's selected on the Leaderboard tab — no separate big
// dropdown to pick from twice, clicking a row there is the picker.
// Manual typing in propsNickInput still works and isn't overwritten by
// this except right when a new Leaderboard row is clicked.
function propsShowSelectedNick(nick) {
    if (!propsNickHint) return;
    if (nick) {
        propsNickHint.textContent = "Using \u201c" + nick + "\u201d from Leaderboard.";
        propsNickHint.className = "card-sub ok";
    } else {
        propsNickHint.textContent = "Click a row on the Leaderboard tab to pick a nick, or type one below.";
        propsNickHint.className = "card-sub";
    }
}

// Called once when the tab is opened and then automatically from
// poll() every POLL_MS while it's the active tab — no manual Refresh
// button needed, it just tracks whatever's selected on the Timeline.
// The dropdown is rebuilt each call, but the previously-picked property
// is restored if it's still in the new list, so re-polling doesn't
// interrupt the user mid-pick.
function propsRefresh() {
    if (propsApplying) return;

    var previousChoice = propsSelect.value;
    propsStatus.className = "card-sub";

    evalScript("spidxListGraphicTextProperties()")
        .then(function (result) {
            propsSelect.innerHTML = "";

            if (!result.hasClip) {
                propsStatus.textContent = "Select a Graphics (MOGRT) clip on the timeline.";
                propsApplyBtn.disabled = true;
                return;
            }
            var names = result.properties || [];
            if (!names.length) {
                propsStatus.textContent = "\"" + result.clip + "\" has no text properties Spidx could detect.";
                propsStatus.className = "card-sub error";
                propsApplyBtn.disabled = true;
                return;
            }
            names.forEach(function (name) {
                var opt = document.createElement("option");
                opt.value = name;
                opt.textContent = name;
                propsSelect.appendChild(opt);
            });
            if (names.indexOf(previousChoice) !== -1) propsSelect.value = previousChoice;

            propsStatus.textContent = "\"" + result.clip + "\" \u2014 " + names.length
                + " text propert" + (names.length === 1 ? "y" : "ies") + " found.";
            propsStatus.className = "card-sub ok";
            propsApplyBtn.disabled = false;
        })
        .catch(function (err) {
            propsStatus.textContent = err.message;
            propsStatus.className = "card-sub error";
        });
}

propsApplyBtn.addEventListener("click", function () {
    var propName = propsSelect.value;
    var nick = (propsNickInput.value || "").replace(/^\s+|\s+$/g, "");

    if (!propName) {
        propsMessage.textContent = "Pick a text property first.";
        propsMessage.className = "card-sub error";
        return;
    }
    if (!nick) {
        propsMessage.textContent = "Pick a nick from the list or type one.";
        propsMessage.className = "card-sub error";
        return;
    }

    propsApplying = true;
    propsApplyBtn.disabled = true;
    evalScript("spidxSetGraphicText(" + esArg(propName) + ", " + esArg(nick) + ")")
        .then(function () {
            propsMessage.textContent = "Set \"" + propName + "\" to: " + nick;
            propsMessage.className = "card-sub ok";
            propsApplying = false;
            propsApplyBtn.disabled = false;
        })
        .catch(function (err) {
            propsMessage.textContent = err.message;
            propsMessage.className = "card-sub error";
            propsApplying = false;
            propsApplyBtn.disabled = false;
        });
});

/* ---------------------------------------------------------------------- */
/*  Boot                                                                  */
/* ---------------------------------------------------------------------- */

/* ---------------- MOGRT tab ---------------- */
// A template browser: categories (collapsible) of tiles with the template's own
// preview picture. Clicking a tile inserts it at the playhead - there is
// nothing to install. The list comes from mogrts/mogrts.json (refreshed by
// "Update MOGRT list.bat" when .mogrt files are added).
var mogrtsListEl = $("mogrtsList");
var mogrtsStatusEl = $("mogrtsStatus");
var mogrtNickInput = $("mogrtNickInput");
var mogrtSearchInput = $("mogrtSearch");
var mogrtMessageEl = $("mogrtMessage");
var MOGRT_COLLAPSED_KEY = "spidx_ppro_mogrt_collapsed";
var mogrtItems = [];
var mogrtInserting = false;

function mogrtSay(text, kind) {
    mogrtMessageEl.textContent = text || "";
    mogrtMessageEl.className = "card-sub" + (kind ? " " + kind : "");
}

function mogrtCollapsedList() {
    try { return JSON.parse(store.get(MOGRT_COLLAPSED_KEY) || "[]") || []; } catch (err) { return []; }
}

// The template list is read straight from mogrts/mogrts.json by the panel
// itself (cep.fs) - it does not depend on ExtendScript guessing the panel's
// folder. ExtendScript is only the fallback.
function mogrtsReadList() {
    var root = extensionPath();
    var text = root ? readTextFile(joinPath(root, "mogrts/mogrts.json")) : null;
    if (text) {
        try {
            var parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
            if (Object.prototype.toString.call(parsed) === "[object Array]") return Promise.resolve({ items: parsed, root: root });
        } catch (err) { /* fall through to the host */ }
    }
    return evalScript("spidxListMogrts(" + esArg(root) + ")");
}

function mogrtsLoad() {
    mogrtsLoadedOnce = true;
    mogrtsStatusEl.textContent = "Loading...";
    mogrtsListEl.innerHTML = "";

    mogrtsReadList().then(function (result) {
        mogrtItems = result.items || [];
        if (!mogrtItems.length) {
            mogrtsStatusEl.textContent = result.missing
                ? "No templates found - the panel's mogrts folder is missing (looked in: " + (result.root || extensionPath() || "?") + "\\mogrts). Reinstall the Premiere Pro panel."
                : "No templates bundled with this panel yet.";
            return;
        }
        mogrtsStatusEl.textContent = "Click a template to put it on the timeline at the playhead (on a free track above V1).";
        mogrtsRender();
    }).catch(function (err) {
        mogrtsStatusEl.textContent = "Could not load templates: " + err.message;
    });
}

function mogrtMatches(item, query) {
    if (!query) return true;
    var haystack = ((item.name || item.file) + " " + (item.description || "") + " " + (item.category || "")).toLowerCase();
    return haystack.indexOf(query) !== -1;
}

function mogrtThumbUrl(relative) {
    return "../mogrts/" + String(relative).split("/").map(encodeURIComponent).join("/");
}

function mogrtTile(item, index) {
    var tile = document.createElement("button");
    tile.type = "button";
    tile.className = "mg-tile";
    tile.style.animationDelay = Math.min(index || 0, 12) * 35 + "ms"; // tiles slide in one after another
    tile.title = (item.description ? item.description + " \u2014 " : "") + "click to insert at the playhead";

    var box = document.createElement("div");
    box.className = "mg-thumb";
    if (item.thumb) {
        var img = document.createElement("img");
        img.alt = "";
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); box.classList.add("nothumb"); };
        img.src = mogrtThumbUrl(item.thumb);
        box.appendChild(img);
    } else {
        box.classList.add("nothumb");
    }
    tile.appendChild(box);

    // Animated preview while hovering. The <video> is created on the first hover
    // and only shows once it is really playing; if this Premiere's CEP can't play
    // the file, it silently stays the still picture (and isn't retried).
    if (item.preview) {
        var video = null;
        tile.addEventListener("mouseenter", function () {
            if (item.previewFailed) return;
            if (!video) {
                video = document.createElement("video");
                video.muted = true;
                video.setAttribute("muted", "");
                video.loop = true;
                video.setAttribute("playsinline", "");
                video.preload = "auto";
                video.addEventListener("playing", function () { video.classList.add("playing"); });
                video.addEventListener("error", function () {
                    item.previewFailed = true;
                    if (video && video.parentNode) video.parentNode.removeChild(video);
                    video = null;
                });
                video.src = mogrtThumbUrl(item.preview);
                box.appendChild(video);
            }
            try {
                var started = video.play();
                if (started && started.catch) started.catch(function () { item.previewFailed = true; });
            } catch (err) { item.previewFailed = true; }
        });
        tile.addEventListener("mouseleave", function () {
            if (!video) return;
            try { video.pause(); video.currentTime = 0; } catch (err) {}
            video.classList.remove("playing");
        });
    }

    var plus = document.createElement("div");
    plus.className = "mg-plus";
    plus.textContent = "+ Insert";
    tile.appendChild(plus);

    var name = document.createElement("div");
    name.className = "mg-name";
    name.textContent = item.name || item.file;
    tile.appendChild(name);

    var over = document.createElement("div");
    over.className = "mg-over";
    tile.appendChild(over);

    tile.addEventListener("click", function () { mogrtInsert(item, tile); });
    return tile;
}

// Collapse / expand with a height + fade transition (display:none can't animate,
// so the grid's height is measured and tweened, then the final state is set).
function mogrtSetCollapsed(section, grid, collapse) {
    section.classList.add("animating");
    if (collapse) {
        grid.style.height = grid.scrollHeight + "px";
        void grid.offsetHeight;
        section.classList.add("collapsing");
        setTimeout(function () {
            section.classList.remove("collapsing", "animating");
            section.classList.add("collapsed");
            grid.style.height = "";
        }, 270);
    } else {
        section.classList.remove("collapsed");
        grid.style.height = "0px";
        grid.style.opacity = "0";
        void grid.offsetHeight;
        grid.style.height = grid.scrollHeight + "px";
        grid.style.opacity = "1";
        setTimeout(function () {
            section.classList.remove("animating");
            grid.style.height = "";
            grid.style.opacity = "";
        }, 270);
    }
}

function mogrtsRender() {
    var query = (mogrtSearchInput.value || "").toLowerCase().replace(/^\s+|\s+$/g, "");
    var collapsed = mogrtCollapsedList();
    var groups = [];
    var byName = {};

    mogrtsListEl.innerHTML = "";
    mogrtItems.forEach(function (item) {
        if (!mogrtMatches(item, query)) return;
        var category = item.category || "Templates";
        if (!byName[category]) { byName[category] = { name: category, items: [] }; groups.push(byName[category]); }
        byName[category].items.push(item);
    });

    if (!groups.length) {
        var none = document.createElement("div");
        none.className = "card-sub";
        none.textContent = "No template matches \u201c" + query + "\u201d.";
        mogrtsListEl.appendChild(none);
        return;
    }

    var tileIndex = 0;
    groups.forEach(function (group) {
        var section = document.createElement("div");
        section.className = "mg-section";
        if (!query && collapsed.indexOf(group.name) !== -1) section.classList.add("collapsed"); // a search always shows matches

        var head = document.createElement("div");
        head.className = "mg-head";
        var chev = document.createElement("span");
        chev.className = "mg-chev";
        chev.textContent = "\u25BE";
        var title = document.createElement("span");
        title.textContent = group.name;
        var count = document.createElement("span");
        count.className = "mg-count";
        count.textContent = String(group.items.length);
        head.appendChild(chev);
        head.appendChild(title);
        head.appendChild(count);
        var grid = document.createElement("div");
        grid.className = "mg-grid";
        head.addEventListener("click", function () {
            var collapse = !section.classList.contains("collapsed") && !section.classList.contains("collapsing");
            mogrtSetCollapsed(section, grid, collapse);
            var list = mogrtCollapsedList().filter(function (n) { return n !== group.name; });
            if (collapse) list.push(group.name);
            store.set(MOGRT_COLLAPSED_KEY, JSON.stringify(list));
        });
        section.appendChild(head);
        group.items.forEach(function (item) { grid.appendChild(mogrtTile(item, tileIndex++)); });
        section.appendChild(grid);

        mogrtsListEl.appendChild(section);
    });
}

mogrtSearchInput.addEventListener("input", function () { if (mogrtItems.length) mogrtsRender(); });

function mogrtInsert(item, tile) {
    if (mogrtInserting) return;
    if (!tierAllowsMogrt()) { mogrtSay("MOGRT templates need the SPT role.", "error"); return; }
    mogrtInserting = true;
    var nick = (mogrtNickInput.value || "").replace(/^\s+|\s+$/g, "");
    var over = tile.querySelector(".mg-over");
    tile.classList.remove("done");
    tile.classList.add("busy");
    over.textContent = "Inserting...";
    mogrtSay("");

    function reset(delay) {
        setTimeout(function () { tile.classList.remove("busy", "done"); mogrtInserting = false; }, delay);
    }

    // nick fill uses the same Pro gate as the Properties tab
    evalScript("spidxInsertMogrt(" + esArg(item.file) + ", " + esArg(nick) + ", " + esArg(tierAllowsProFeatures() ? "true" : "false") + ", " + esArg(extensionPath()) + ", " + esArg(item.textParam || "") + ")")
        .then(function (result) {
            var msg = "Inserted \"" + (item.name || item.file) + "\" on " + result.track + " at the playhead";
            if (result.textApplied) msg += " with \"" + nick + "\"";
            msg += ".";
            if (result.note) msg += " " + result.note;
            mogrtSay(msg, result.note ? "" : "ok");
            tile.classList.remove("busy");
            tile.classList.add("done");
            over.textContent = "Inserted \u2713 " + result.track;
            reset(1400);
        })
        .catch(function (err) {
            mogrtSay(err.message, "error");
            tile.classList.remove("busy", "done");
            mogrtInserting = false;
        });
}

// "Install PPRO Panel.bat" writes the path of App\incoming next to the
// install into %APPDATA%\Spidx Uploader\incoming-folder.txt. If no (valid)
// folder is remembered yet, use it - so a fresh install or a reinstall works
// without picking the folder by hand.
function adoptIncomingFromInstaller() {
    if (incomingPath && folderExists(incomingPath)) return;
    var base = userDataDir();
    if (!base) return;
    var text = readTextFile(base.replace(/[\\/]+$/, "") + "/" + CONFIG_DIR_NAME + "/incoming-folder.txt");
    if (!text) return;
    var candidate = String(text).replace(/^\uFEFF/, "").replace(/^\s+|\s+$/g, "");
    if (candidate && folderExists(candidate)) {
        incomingPath = candidate;
        store.set(FOLDER_KEY, incomingPath);
    }
}

/* ---------------- global shortcut ---------------- */
// SpidxHotkey.exe (started by the tray app) writes .capture-request.json when the shortcut
// is pressed in THIS program. We do exactly what the Upload button does - but first answer
// in .capture-ack.json, so the key press gets its feedback even though exporting takes seconds.
var CAPTURE_REQUEST_NAME = ".capture-request.json";
var CAPTURE_ACK_NAME = ".capture-ack.json";
var CAPTURE_HOST = "ppro";
var CAPTURE_MAX_AGE_MS = 15000;
var lastCaptureId = "";

function answerCapture(id, ok, message) {
    writeTextFile(joinPath(incomingPath, CAPTURE_ACK_NAME), JSON.stringify({ id: id, app: CAPTURE_HOST, ok: ok, message: message || "" }));
}

function checkCaptureRequest() {
    if (!incomingPath) return;
    var request = readJsonFile(joinPath(incomingPath, CAPTURE_REQUEST_NAME));
    if (!request || !request.id || request.app !== CAPTURE_HOST || request.id === lastCaptureId) return;
    lastCaptureId = request.id;
    if (Math.abs(Date.now() - Number(request.time || 0)) > CAPTURE_MAX_AGE_MS) return;   // an old key press, from before this panel was open

    var viaPhotoshop = request.route === "ps";
    var problem = null;
    if (busy) problem = "The Spidx panel is still busy with the previous upload.";
    else if (viaPhotoshop && !tierAllowsProFeatures()) problem = "Photoshop + Upload is a Pro feature.";
    else if (viaPhotoshop && uploadPsButton.disabled) problem = "No Camera Raw Action is set - choose one in the Dashboard first.";
    if (problem) { answerCapture(request.id, false, problem); return; }

    answerCapture(request.id, true, "");
    performUpload(viaPhotoshop);
}

/* ---------------- client presets ---------------- */
// The helper publishes the preset names + the active one in its status; choosing one
// here drops a request file the running helper picks up (live, no restart) and answers.
var PRESET_REQUEST_NAME = ".preset-request.json";
var PRESET_RESULT_NAME = ".preset-result.json";
var presetSelect = $("presetSelect");
var presetRow = $("presetRow");
var presetListKey = "";
var presetSwitching = false;

function renderPresetSelect(names, active, modified) {
    if (!names || !names.length) { presetRow.style.display = "none"; presetListKey = ""; return; }
    presetRow.style.display = "";
    var key = names.join("|") + "#" + (active || "") + "#" + (modified ? "1" : "0");
    if (key === presetListKey || presetSwitching) return;
    presetListKey = key;

    presetSelect.innerHTML = "";
    if (!active) {
        var none = document.createElement("option");
        none.value = "";
        none.textContent = "Choose a preset...";
        none.selected = true;
        presetSelect.appendChild(none);
    }
    names.forEach(function (name) {
        var option = document.createElement("option");
        option.value = name;
        option.textContent = (name === active && modified) ? name + " (modified)" : name;
        if (name === active) option.selected = true;
        presetSelect.appendChild(option);
    });
}

presetSelect.addEventListener("change", function () {
    var name = presetSelect.value;
    if (!name || !incomingPath) return;

    presetSwitching = true;
    presetSelect.disabled = true;
    var id = String(Date.now());
    writeTextFile(joinPath(incomingPath, PRESET_REQUEST_NAME), JSON.stringify({ id: id, name: name }));

    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        var result = readJsonFile(joinPath(incomingPath, PRESET_RESULT_NAME));
        var answered = result && result.id === id;
        if (!answered && tries < 20) return;   // wait up to ~4 s for the helper

        clearInterval(timer);
        presetSwitching = false;
        presetSelect.disabled = false;
        presetListKey = "";   // re-read the list on the next status
        if (answered && result.ok) setCard("Preset applied", name + (result.message ? " \u2014 " + result.message : ""), "ok");
        else setCard("Preset not applied", answered ? (result.message || "The helper refused it.") : "The helper didn't answer - is it running?", "error");
    }, 200);
});

(function boot() {
    var savedCount = Number(store.get(BATCH_COUNT_KEY));
    pendingBatchCount = (savedCount === 2 || savedCount === 3) ? savedCount : 0;
    folderNameInput.value = store.get(FOLDER_NAME_KEY) || "";

    // The tier is unknown until the engine's status file has been read, and
    // unknown means locked: start on 1 file with 2/3 and the Pro tabs/buttons
    // locked. (Without this, nothing locked them until a tier showed up - so
    // with no helper running, or no folder chosen, everything stayed open.)
    setSelectedBatchCount(1, false);
    setBatchControlsLocked(false);
    updateProFeatureLocks();
    updateMogrtLock();

    adoptIncomingFromInstaller();
    updateFolderLabel();
    updatePresetLabel();

    if (!incomingPath) {
        setCard("Link the incoming folder", 'Click "Change incoming folder" and pick App\\incoming.');
    } else {
        evalScript("spidxContext()").then(function (context) {
            if (context.hasComp) setCard("Ready", context.comp + " — frame " + context.frame);
            else setCard("Ready", "No sequence active yet.");
        }).catch(function () { /* panel still works; the first click reports the real error */ });
    }

    poll();
    setInterval(poll, POLL_MS);
})();
