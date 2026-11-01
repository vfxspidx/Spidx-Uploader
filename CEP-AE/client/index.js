"use strict";

/* ========================================================================
 *  Spidx Uploader - After Effects panel (CEP)
 *
 *  This is the AE twin of the Photoshop UXP panel. It deliberately speaks
 *  the exact same protocol as that panel - small files inside App\incoming:
 *
 *    .batch-config.json   written here  - how many files the engine waits for
 *    .batch-status.json   read here     - live collection/upload progress
 *    .engine-status.json  read here     - tier, destination, device limit
 *    .batch-force-send    written here  - "Send now"
 *    .batch-cancel        written here  - "Cancel"
 *
 *  so one running Spider Engine serves Photoshop and After Effects at the
 *  same time with no changes on its side beyond accepting PNG as well as
 *  JPG.
 *
 *  The panel does one thing on purpose: "Save Frame As > File" of the
 *  active comp's current frame, always as PNG. No render queue, no output
 *  module templates, nothing that can sit there rendering for an hour.
 *
 *  No Node.js is required: everything goes through CEP's own cep.fs API,
 *  which is always present, instead of --enable-nodejs (which changes the
 *  JS context and breaks on some AE builds).
 * ==================================================================== */

var FOLDER_KEY = "spidx_ae_incoming_path";
var BATCH_COUNT_KEY = "spidx_ae_batch_count";
var FOLDER_NAME_KEY = "spidx_ae_folder_name";

var BATCH_CONFIG_NAME = ".batch-config.json";
var BATCH_STATUS_NAME = ".batch-status.json";
var ENGINE_STATUS_NAME = ".engine-status.json";
// Mirrored by server.js's syncDefaultCameraRawPreset() whenever the
// Dashboard's preset fields change - reading it here (instead of
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
// Replace Text) - one name, used everywhere below.
var PRO_FEATURE_TIERS = MULTI_BATCH_TIERS;

var incomingPath = localStorage.getItem(FOLDER_KEY) || "";
var selectedBatchCount = 1;
var currentTier = null;
var currentRoles = [];      // every role of the licence, e.g. ["free","spt"] (the helper sends them next to the rank)
var currentRolesKey = "";
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

var batchButtons = Array.prototype.slice.call(document.querySelectorAll(".batch-opt"));

/* ---------------------------------------------------------------------- */
/*  CEP plumbing - ExtendScript calls + file system                       */
/* ---------------------------------------------------------------------- */

function evalScript(script) {
    return new Promise(function (resolve, reject) {
        if (!window.__adobe_cep__) {
            reject(new Error("This panel is not running inside After Effects."));
            return;
        }
        window.__adobe_cep__.evalScript(script, function (result) {
            if (result === "EvalScript error.") {
                reject(new Error("After Effects could not run the panel's script (host/spidx.jsx)."));
                return;
            }
            var parsed;
            try {
                parsed = JSON.parse(result);
            } catch (err) {
                reject(new Error("Unexpected response from After Effects: " + result));
                return;
            }
            if (!parsed.ok) reject(new Error(parsed.message || "After Effects reported an error."));
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
/*  Batch selector - identical semantics to the Photoshop panel           */
/* ---------------------------------------------------------------------- */

function tierAllowsMultiBatch() {
    return MULTI_BATCH_TIERS.indexOf(currentTier) !== -1;
}

function tierAllowsProFeatures() {
    return PRO_FEATURE_TIERS.indexOf(currentTier) !== -1;
}

// Replace Text: Pro-level ranks OR the "spt" role (the Spidx Thumbnail Pack).
function tierAllowsReplaceText() {
    return tierAllowsProFeatures() || currentRoles.indexOf("spt") !== -1;
}

function updateProFeatureLocks() {
    var allowed = tierAllowsReplaceText();
    lbInsertBtn.title = allowed ? "" : "Replace Text needs a Pro license or the Spidx Thumbnail Pack.";
    // Don't grant a button that a mid-session tier drop should have revoked.
    if (!allowed) lbInsertBtn.disabled = true;
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

function setSelectedBatchCount(count) {
    selectedBatchCount = count;
    localStorage.setItem(BATCH_COUNT_KEY, String(count));
    batchButtons.forEach(function (btn) {
        btn.classList.toggle("active", Number(btn.dataset.count) === count);
    });
    updateFolderNameVisibility();
    updateRenderBatchLock();
}
// Batches ("Files per upload" 2 or 3) are for thumbnails only. While one is selected or being collected, rendering a
// video is blocked - a render is a single upload of its own and must not get mixed up with a batch of stills.
var BATCH_RENDER_NOTE = "Batches are for thumbnails. Set Files per upload to 1 to render a video.";
function renderBlockedByBatch() { return selectedBatchCount > 1 || lastBatchState === "collecting"; }
function updateRenderBatchLock() {
    if (typeof aeRenderButton === "undefined" || !aeRenderButton || typeof aeRenderLine === "undefined" || !aeRenderLine) return;
    var blocked = renderBlockedByBatch();
    if (!busy) aeRenderButton.disabled = blocked;
    aeRenderButton.title = blocked ? BATCH_RENDER_NOTE : "";
    if (blocked) aeRenderLine.textContent = BATCH_RENDER_NOTE;
    else if (aeRenderLine.textContent === BATCH_RENDER_NOTE || aeRenderLine.textContent === "") aeRenderLine.textContent = "";
}


batchButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
        if (btn.disabled) return;
        setSelectedBatchCount(Number(btn.dataset.count) || 1);
        writeBatchConfig();
    });
});

folderNameInput.addEventListener("input", function () {
    localStorage.setItem(FOLDER_NAME_KEY, folderNameInput.value);
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
    localStorage.setItem(FOLDER_KEY, incomingPath);
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
/*  Status polling (engine + batch)                                       */
/* ---------------------------------------------------------------------- */


// Free plan: a monthly allowance of "Render & upload" videos. The helper counts them and publishes the
// numbers in .engine-status.json ("renders": { used, limit - null = unlimited, remaining }); the panel
// only reads them, so it can warn BEFORE a render that the helper would have to refuse.
var currentRenders = null;
var currentPack = null;
// Translations: the helper writes the dictionary of the chosen language next to the incoming folder.
var panelI18nLoaded = "";
function panelI18nSync(status) {
    var lang = (status && status.language) || "en";
    if (lang === panelI18nLoaded || !window.PanelI18n) return;
    if (lang === "en") { panelI18nLoaded = lang; if (window.PanelI18n.language() !== "en") window.PanelI18n.set("en", null); return; }
    if (typeof incomingPath === "undefined" || !incomingPath) return;
    var data = readJsonFile(joinPath(incomingPath, ".panel-i18n.json"));
    if (data && data.language === lang && data.strings) {
        panelI18nLoaded = lang;
        window.PanelI18n.set(lang, data.strings);
    }
}


function rendersLimitReached() {
    return !!(currentRenders && currentRenders.limit != null && currentRenders.used >= currentRenders.limit);
}

function rendersNote() {
    if (!currentRenders || currentRenders.limit == null) return "";
    return "Renders this month: " + currentRenders.used + " of " + currentRenders.limit + (currentRenders.remaining === 0 ? " - Pro has unlimited renders." : "");
}

function rendersLimitCard() {
    setCard("Render limit reached", "The free plan includes " + currentRenders.limit + " video renders per month. Pro has unlimited renders.", "error");
}

function applyEngineStatus(status) {
    currentRenders = (status && status.renders) || null;
    currentPack = (status && status.pack) || null;
    panelI18nSync(status);
    if (typeof aeRenderLine !== "undefined" && aeRenderLine && (!aeRenderLine.textContent || /^Renders this month/.test(aeRenderLine.textContent))) aeRenderLine.textContent = rendersNote();
    renderPresetSelect(status && status.presets, status && status.activePreset, status && status.activePresetModified);
    var stamp = status && Number(status.updatedAt);
    var online = !!(stamp && (Date.now() - stamp) < ENGINE_STALE_MS);

    if (online !== engineOnline) {
        engineOnline = online;
        if (!online) {
            setCard(
                "Helper not running",
                'Start "Spidx Uploader.vbs" (or the desktop shortcut) - nothing is watching the incoming folder right now.',
                "error"
            );
            setProgress(0);
        } else if (!busy) {
            setCard("Ready", "Helper is running - export away.", "ok");
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
        setBatchControlsLocked(false);
        sptUpdateLock();
        updateProFeatureLocks();
    }

    tierBadge.className = "tier-badge" + (tier ? " show tier-" + tier : "");
    if (tier) {
        // "SPT" or "PRO + SPT" when the licence carries more than the rank
        var shownRoles = roles.filter(function (r) { return r !== "free" || roles.length === 1; });
        tierBadge.textContent = (shownRoles.length ? shownRoles.join(" + ") : tier).toUpperCase()
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
            links.length ? "Link copied to the clipboard." : "Sent - no link was detected.",
            "ok"
        );
        setSelectedBatchCount(1);
        writeBatchConfig();
    }

    lastBatchState = state;
    updateRenderBatchLock();
}

function poll() {
    if (!incomingPath) return;
    applyEngineStatus(readJsonFile(joinPath(incomingPath, ENGINE_STATUS_NAME)));
    applyBatchStatus(readJsonFile(joinPath(incomingPath, BATCH_STATUS_NAME)));
    updateRouteLine();
    checkCaptureRequest();
}

// The "Photoshop + Upload" button only makes sense once there's an
// Action configured for it to run - read the same file the Dashboard
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
            ? "Photoshop + Upload is a Pro feature - upgrade your tier to enable it."
            : hasPreset
                ? "Photoshop + Upload runs \u201c" + preset.actionName + "\u201d on your currently active Photoshop document - requires Photoshop already open."
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
        writeBatchConfig();

        if (engineOnline === false) {
            // Not a hard block: the frame still lands in incoming and gets
            // picked up whenever the helper comes back. The panel just
            // stops pretending it was sent.
            setCard("Helper not running", "Saving the frame anyway - it uploads when the helper starts.", "error");
        }

        setCard("Saving frame...", "Exporting the current frame as PNG.");
        setProgress(45);
        // The second argument only changes the saved filename (adds a
        // .ps marker before .png) - server.js's needsCameraRaw() is what
        // actually decides whether to route it through Photoshop, based
        // on that marker plus a configured preset. See server.js.
        task = evalScript("spidxSaveFrame(" + esArg(incomingPath) + ", " + (viaPhotoshop ? "true" : "false") + ")");
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
            "Waiting for the rest (" + selectedBatchCount + " total) - export the next one the same way.",
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

function activateTab(target) {
    for (var i = 0; i < tabButtons.length; i++) tabButtons[i].classList.toggle("active", tabButtons[i].getAttribute("data-tab") === target);
    var pages = document.querySelectorAll(".tab-page");
    for (var j = 0; j < pages.length; j++) pages[j].classList.toggle("active", pages[j].id === target);
    if (target === "tabLeaderboard" && !lbLoadedOnce) lbLoad();
    if (target === "tabSpt") { sptTemplatesLoaded = false; sptUpdateLock(); }   // re-read templates.json every time the tab opens (the Dashboard can change it)
}

for (var ti = 0; ti < tabButtons.length; ti++) {
    tabButtons[ti].addEventListener("click", function () { activateTab(this.getAttribute("data-tab")); });
}


/* ------------------------------------------------------------------ */
/*  SPT tab - bundled presets (SPT / dev / tester roles)                 */
/* ------------------------------------------------------------------ */

var SPT_ROLES_AE = ["spt", "dev", "tester"];
var sptSelect = $("sptPresetSelect");
var sptLine = $("sptLine");
var sptLoadedOnce = false;

function sptAllowed() {
    var roles = currentRoles.length ? currentRoles : (currentTier ? [currentTier] : []);
    for (var i = 0; i < SPT_ROLES_AE.length; i++) if (roles.indexOf(SPT_ROLES_AE[i]) !== -1) return true;
    return false;
}

function sptLoad() {
    var ext = packRootAE();
    evalScript("spidxListSptPresets(" + esArg(ext) + ")").then(function (result) {
        sptLoadedOnce = true;
        sptSelect.innerHTML = "";
        (result.items || []).forEach(function (item) {
            var option = document.createElement("option");
            option.value = item.file;
            option.textContent = item.name;
            sptSelect.appendChild(option);
        });
        if (!sptSelect.options.length) sptLine.textContent = "No presets are bundled with this panel yet.";
    }).catch(function (error) { sptLine.textContent = error.message; });
}

function sptUpdateLock() {
    var locked = !sptAllowed();
    $("tabBtnSpt").classList.toggle("locked", locked);
    $("sptLocked").style.display = locked ? "" : "none";
    $("sptBody").style.display = locked ? "none" : "";
    $("sptLockedText").textContent = "Your role: " + ((currentRoles && currentRoles.length) ? currentRoles.join(" + ").toUpperCase() : "unknown (is the helper running?)")
        + ". These presets are a separate add-on - ask for the SPT role to unlock this tab.";
    if (!locked) {
        if (!sptLoadedOnce) sptLoad();
        if (!sptTemplatesLoaded) sptLoadTemplates();
    }
}

function sptApplyNow(mode) {
    if (!sptAllowed()) { sptUpdateLock(); return; }
    if (!sptSelect.value) { sptLine.textContent = "Pick a preset first."; return; }
    var ext = "";
    try { ext = decodeURI(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\/\//i, ""); } catch (e) {}
    sptLine.textContent = "Applying...";
    evalScript("spidxApplySptPreset(" + esArg(ext) + ", " + esArg(sptSelect.value) + ", " + esArg(mode) + ")").then(function () {
        sptLine.textContent = mode === "adjustment" ? "Added an adjustment layer with the preset." : "Preset applied to the selected layers.";
    }).catch(function (error) { sptLine.textContent = error.message; });
}

var sptTemplateSelect = $("sptTemplateSelect");
var sptTemplateLine = $("sptTemplateLine");

// The Thumbnail Pack content (templates, presets) is NOT inside the panel: the helper downloads it for accounts that
// have the Pack into %APPDATA%\Spidx Uploader\pack\ae. The host functions read "<root>/templates" and "<root>/presets".
function packRootAE() {
    try {
        var raw = decodeURI(window.__adobe_cep__.getSystemPath("userData")).replace(/^file:\/\/\//i, "").replace(/^\/(?=[A-Za-z]:)/, "");
        return raw ? raw.replace(/[\\\/]+$/, "") + "/Spidx Uploader/pack/ae" : "";
    } catch (e) { return ""; }
}

function sptExtPath() { return packRootAE(); }

// What to tell the user when the lists are empty: the Pack is downloaded by the helper, not shipped with the panel.
function packEmptyMessage(what) {
    var p = currentPack;
    if (p && p.state === "syncing") return "The Thumbnail Pack is downloading... try again in a moment.";
    if (p && p.state === "error") return "The Thumbnail Pack could not be downloaded: " + (p.message || "no answer from the server") + ".";
    if (p && p.state === "none") return "No " + what + " yet - they download automatically for accounts that have the Thumbnail Pack.";
    return "No " + what + " yet. They download automatically for accounts with the Thumbnail Pack - check the Dashboard > Templates.";
}

var sptTemplatesLoaded = false;

function sptLoadTemplates() {
    var keep = sptTemplateSelect.value;
    evalScript("spidxListSptTemplates(" + esArg(sptExtPath()) + ")").then(function (result) {
        sptTemplatesLoaded = true;
        sptTemplateLine.textContent = "";
        sptTemplateSelect.innerHTML = "";
        (result.items || []).forEach(function (item) {
            var option = document.createElement("option");
            option.value = String(item.id);
            option.textContent = item.name;
            sptTemplateSelect.appendChild(option);
        });
        if (keep) sptTemplateSelect.value = keep;
        if (sptTemplateSelect.selectedIndex < 0 && sptTemplateSelect.options.length) sptTemplateSelect.selectedIndex = 0;
        if (!sptTemplateSelect.options.length) sptTemplateLine.textContent = packEmptyMessage("text templates");
    }).catch(function (error) { sptTemplateLine.textContent = error.message; });
}

$("sptUseLbNick").addEventListener("click", function () {
    var player = (typeof lbSelectedPlayer === "function") ? lbSelectedPlayer() : null;
    if (!player) { sptTemplateLine.textContent = "Pick a player in the Leaderboard tab first."; return; }
    $("sptNickInput").value = player.alias || player.name || "";
    sptTemplateLine.textContent = "";
});

$("sptInsertTemplate").addEventListener("click", function () {
    if (!sptAllowed()) { sptUpdateLock(); return; }
    if (!sptTemplateSelect.value) { sptTemplateLine.textContent = "Pick a template first."; return; }
    sptTemplateLine.textContent = "Inserting...";
    evalScript("spidxInsertSptTemplate(" + esArg(sptExtPath()) + ", " + esArg(sptTemplateSelect.value) + ", " + esArg($("sptNickInput").value) + ")").then(function (result) {
        sptTemplateLine.textContent = "Inserted: " + result.name;
    }).catch(function (error) { sptTemplateLine.textContent = error.message; });
});

$("sptApply").addEventListener("click", function () { sptApplyNow("layers"); });
$("sptApplyAdj").addEventListener("click", function () { sptApplyNow("adjustment"); });

/* ------------------------------------------------------------------ */
/*  Leaderboard tab - SpidxTracker (Fortnite)                           */
/*                                                                      */
/*  Ported from the standalone SpidxLeaderboardPanel.jsx ScriptUI       */
/*  panel. Fetching and rendering happen here in plain JS (a CEP panel  */
/*  is just Chromium - fetch()/DOM beats the old raw-Socket-and-temp-   */
/*  .bat-file approach that ScriptUI needed). Only touching the actual  */
/*  AE layer (insert / Essential Graphics) still goes through           */
/*  ExtendScript - see spidxLeaderboardInsertAndExpose() in spidx.jsx.  */
/* ------------------------------------------------------------------ */

var LB_CACHE_NAME = ".leaderboard-cache.json";

var lbRegion = $("lbRegion");
var lbSearch = $("lbSearch");
var lbRefreshBtn = $("lbRefresh");
var lbStatus = $("lbStatus");
var lbRows = $("lbRows");
var lbCopyBtn = $("lbCopy");
var lbInsertBtn = $("lbInsert");
var lbMessage = $("lbMessage");

var lbPlayers = [];
var lbSelectedIndex = -1;
var lbSearchTimer = null;
var lbLoadedOnce = false;

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
    lbStatus.textContent = "Offline - cached data from " + lbCacheAgeText(cache.savedAt)
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
    lbInsertBtn.disabled = true;
    lbMessage.textContent = "";

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
    lbInsertBtn.disabled = !tierAllowsReplaceText();
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

var LB_REQUEST_NAME = ".leaderboard-request.json";
var LB_RESULT_NAME = ".leaderboard-result.json";

// The leaderboard server sends no CORS headers; instead of switching Chromium's web security off for the
// whole panel, the helper fetches it for us (App\\server.js, checkLeaderboardRequest) via two small files.
function lbRequest(query) {
    return new Promise(function (resolve, reject) {
        if (!incomingPath) { reject(new Error("Link the incoming folder first (Change incoming folder).")); return; }
        var id = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
        try { writeTextFile(joinPath(incomingPath, LB_REQUEST_NAME), JSON.stringify({ id: id, query: query })); }
        catch (e) { reject(new Error("Could not talk to the helper: " + e.message)); return; }
        var started = Date.now();
        var timer = setInterval(function () {
            var result = readJsonFile(joinPath(incomingPath, LB_RESULT_NAME));
            if (result && result.id === id) {
                clearInterval(timer);
                if (result.ok) resolve(result.json); else reject(new Error(result.error || "The helper could not reach the leaderboard server."));
                return;
            }
            if (Date.now() - started > 12000) {
                clearInterval(timer);
                reject(new Error("The helper did not answer - is Spidx Uploader running? (tray icon)"));
            }
        }, 250);
    });
}

function lbLoad() {
    lbLoadedOnce = true;
    lbCopyBtn.disabled = true;
    lbInsertBtn.disabled = true;
    lbMessage.textContent = "";
    lbStatus.textContent = "Loading...";
    lbStatus.className = "card-sub";

    lbRequest(lbQuery())
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

lbInsertBtn.addEventListener("click", function () {
    if (!tierAllowsReplaceText()) {
        lbMessage.textContent = "Replace Text needs a Pro license or the Spidx Thumbnail Pack.";
        lbMessage.className = "card-sub error";
        return;
    }
    var player = lbSelectedPlayer();
    if (!player) return;
    var nick = player.alias || player.name || "";

    evalScript("spidxLeaderboardInsertAndExpose(" + esArg(nick) + ", true)")
        .then(function (result) {
            if (result.essentialAdded) {
                var suffix = result.usedDefaultName ? " (as default name, fallback)" : "";
                lbMessage.textContent = "Inserted + added to Essential Graphics: " + nick + suffix;
                lbMessage.className = "card-sub ok";
            } else if (result.essentialAlreadyAdded) {
                lbMessage.textContent = "Inserted: " + nick + " (already in Essential Graphics)";
                lbMessage.className = "card-sub ok";
            } else if (result.essentialError) {
                lbMessage.textContent = "Inserted: " + nick + " | Essential Graphics failed: " + result.essentialError;
                lbMessage.className = "card-sub error";
            } else {
                lbMessage.textContent = "Inserted: " + nick;
                lbMessage.className = "card-sub ok";
            }
        })
        .catch(function (err) {
            lbMessage.textContent = "Error: " + err.message;
            lbMessage.className = "card-sub error";
        });
});

lbRefreshBtn.addEventListener("click", lbLoad);
lbRegion.addEventListener("change", lbLoad);
lbSearch.addEventListener("input", function () {
    clearTimeout(lbSearchTimer);
    lbSearchTimer = setTimeout(lbLoad, 400);
});

/* ---------------------------------------------------------------------- */
/*  Boot                                                                  */
/* ---------------------------------------------------------------------- */

/* ---------------- global shortcut ---------------- */
// SpidxHotkey.exe (started by the tray app) writes .capture-request.json when the shortcut
// is pressed in THIS program. We do exactly what the Upload button does - but first answer
// in .capture-ack.json, so the key press gets its feedback even though exporting takes seconds.
var CAPTURE_REQUEST_NAME = ".capture-request.json";
var CAPTURE_ACK_NAME = ".capture-ack.json";
var CAPTURE_HOST = "ae";
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
        if (answered && result.ok) setCard("Preset applied", name + (result.message ? " - " + result.message : ""), "ok");
        else setCard("Preset not applied", answered ? (result.message || "The helper refused it.") : "The helper didn't answer - is it running?", "error");
    }, 200);
});


/* ---------------------------------------------------------------------- */
/*  Render video: After Effects renders (its own render queue), the helper uploads  */
/* ---------------------------------------------------------------------- */

var AE_RENDER_TEMPLATE_KEY = "spidxAeRenderTemplate";
var AE_RENDER_RANGE_KEY = "spidxAeRenderRange";
var aeRenderTemplateSelect = $("aeRenderTemplate");
var aeRenderRangeSelect = $("aeRenderRange");
var aeRenderButton = $("aeRenderUpload");
var aeRenderLine = $("aeRenderLine");

var aeRenderLoading = false;
var aeRenderTries = 0;

function aeRenderLoadTemplates() {
    if (aeRenderLoading) return;
    aeRenderLoading = true;
    aeRenderTries++;
    aeRenderLine.textContent = "";
    evalScript("spidxListRenderTemplates()").then(function (result) {
        var saved = localStorage.getItem(AE_RENDER_TEMPLATE_KEY) || "";
        aeRenderTemplateSelect.innerHTML = "";
        var items = result.items || [];
        for (var i = 0; i < items.length; i++) {
            var option = document.createElement("option");
            option.value = items[i].name;
            option.textContent = items[i].name;
            if (items[i].name === saved) option.selected = true;
            aeRenderTemplateSelect.appendChild(option);
        }
        if (!items.length) aeRenderLine.textContent = "No render templates found - click Refresh list.";
    }).catch(function (error) {
        aeRenderTemplateSelect.innerHTML = "";
        aeRenderLine.textContent = error.message;
    }).then(function () { aeRenderLoading = false; });
}

// The list used to be read exactly once at panel start - if After Effects was still opening its
// project at that moment the dropdown stayed empty for good. Now an empty list is retried in the
// background (a few times) and whenever the panel gets focus again.
function aeRenderRetryIfEmpty() {
    if (busy || aeRenderLoading) return;
    if (aeRenderTemplateSelect.options.length) return;
    aeRenderLoadTemplates();
}
setInterval(function () { if (aeRenderTries < 12) aeRenderRetryIfEmpty(); }, 4000);
window.addEventListener("focus", aeRenderRetryIfEmpty);

aeRenderTemplateSelect.addEventListener("change", function () { localStorage.setItem(AE_RENDER_TEMPLATE_KEY, aeRenderTemplateSelect.value); });
aeRenderRangeSelect.addEventListener("change", function () { localStorage.setItem(AE_RENDER_RANGE_KEY, aeRenderRangeSelect.value); });
aeRenderRangeSelect.value = localStorage.getItem(AE_RENDER_RANGE_KEY) || "entire";
if (aeRenderRangeSelect.selectedIndex < 0) aeRenderRangeSelect.value = "entire";
$("aeRenderReload").addEventListener("click", function () { aeRenderTries = 0; aeRenderLoadTemplates(); });


// AE / Premiere block their own script engine for the whole render, so the panel cannot ask for a real
// percentage - but the panel itself keeps running, so it can at least show a live clock.
var renderClock = null;
function renderClockStart(button, idleLabel, what) {
    var startedAt = Date.now();
    function tick() {
        var secs = Math.floor((Date.now() - startedAt) / 1000);
        var clock = Math.floor(secs / 60) + ":" + (secs % 60 < 10 ? "0" : "") + (secs % 60);
        button.textContent = "Rendering... " + clock;
        setCard("Rendering", what() + " " + clock + " - the host app stays busy until the render is finished.");
    }
    tick();
    renderClock = setInterval(tick, 1000);
}
function renderClockStop() { if (renderClock) { clearInterval(renderClock); renderClock = null; } }

aeRenderButton.addEventListener("click", function () {
    if (busy) return;
    if (renderBlockedByBatch()) { setCard("Batches are for thumbnails", "Set Files per upload to 1 to render a video.", "error"); return; }
    if (rendersLimitReached()) { rendersLimitCard(); return; }
    var template = aeRenderTemplateSelect.value;
    if (!template) { setCard("Pick a template", "Choose a render template first (Refresh list if it is empty).", "error"); return; }

    busy = true;
    aeRenderButton.disabled = true;
    var aeRenderComp = "";
    evalScript("spidxContext()").then(function (c) { if (c && c.hasComp) aeRenderComp = c.comp + (c.duration ? " (" + c.duration.toFixed(1) + " s)" : ""); }).catch(function () {});
    renderClockStart(aeRenderButton, "Render & upload", function () {
        return (aeRenderComp ? aeRenderComp + " \u00b7 " : "") + (aeRenderRangeSelect.value === "workarea" ? "work area" : "entire composition") + " \u00b7 " + aeRenderTemplateSelect.value + " \u00b7";
    });
    var task;
    try {
        ensureIncomingFolder(false);
        if (engineOnline === false) setCard("Helper not running", "The render goes ahead anyway - it uploads when the helper starts.", "error");
        task = evalScript("spidxRenderComp(" + esArg(incomingPath) + ", " + esArg(template) + ", " + esArg(aeRenderRangeSelect.value) + ")");
    } catch (error) {
        renderClockStop();
        busy = false;
        aeRenderButton.disabled = false;
        aeRenderButton.textContent = "Render & upload";
        setCard("Error", error.message, "error");
        return;
    }
    task.then(function (result) {
        renderClockStop();
        setCard("Render finished", result.comp + " (" + result.range + ", " + result.template + ") -> " + result.name + ". The helper is uploading it now.", "ok");
        aeRenderButton.textContent = "Done";
    }).catch(function (error) {
        renderClockStop();
        setCard("Error", error.message, "error");
        aeRenderButton.textContent = "Try again";
    }).then(function () {
        busy = false;
        aeRenderButton.disabled = false;
        setTimeout(function () { aeRenderButton.textContent = "Render & upload"; }, 3000);
    });
});

(function boot() {
    var savedCount = Number(localStorage.getItem(BATCH_COUNT_KEY));
    folderNameInput.value = localStorage.getItem(FOLDER_NAME_KEY) || "";
    setSelectedBatchCount(savedCount === 2 || savedCount === 3 ? savedCount : 1);
    setBatchControlsLocked(false);
    sptUpdateLock();
    updateFolderLabel();

    if (!incomingPath) {
        setCard("Link the incoming folder", 'Click "Change incoming folder" and pick App\\incoming.');
    } else {
        evalScript("spidxContext()").then(function (context) {
            if (context.hasComp) setCard("Ready", context.comp + " - frame " + context.frame);
            else setCard("Ready", "No composition active yet.");
        }).catch(function () { /* panel still works; the first click reports the real error */ });
    }

    aeRenderLoadTemplates();
    poll();
    setInterval(poll, POLL_MS);
})();
