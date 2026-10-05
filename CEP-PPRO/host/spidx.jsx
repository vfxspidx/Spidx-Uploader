/* ========================================================================
 *  Spidx Uploader — Premiere Pro host layer (ExtendScript)
 *
 *  Port of the After Effects host script (CEP-AE/host/spidx.jsx). Both
 *  panels talk to the SAME Spider Engine the same way: by dropping files
 *  into App\incoming and reading/writing the small dot-files in it. No
 *  network, no IPC, no second engine — server.js does not know or care
 *  which host application produced the PNG.
 *
 *  The one thing that had to change completely is the export itself.
 *  After Effects has CompItem.saveFrameToPng(), a single scripting call
 *  that grabs one frame. Premiere Pro's DOM has nothing like that —
 *  Sequence has no "export current frame" method. The documented way to
 *  get a single frame out of a sequence via scripting is:
 *
 *    1. Set the sequence's in/out points to the current player position
 *       (out = in, so the "work area" is exactly one frame wide).
 *    2. Call Sequence.exportAsMediaDirect(path, presetPath, workAreaType)
 *       with workAreaType = app.encoder.ENCODE_IN_TO_OUT and an export
 *       preset (.epr) that outputs a PNG.
 *
 *  That preset file is the catch: .epr files are binary-ish XML tied to
 *  Media Encoder's installed format list, so one can't just be
 *  hand-written the way an AE saveFrameToPng() call needs zero setup.
 *  It has to be generated once from Premiere's own Export Media dialog
 *  and dropped next to this script (see spidxPresetPath() below and the
 *  install notes in ../PRESET-SETUP.txt). Everything downstream of that
 *  — staging file, rename-on-completion, retry-on-lock — is identical to
 *  the AE version.
 *
 *  Every function here returns a JSON *string* — CEP's evalScript can
 *  only hand back strings, and ExtendScript has no JSON object.
 * ==================================================================== */

var SPIDX_PART_EXT = ".pngpart";

function spidxEscape(value) {
    var s = String(value);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '"' || c === "\\") out += "\\" + c;
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else out += c;
    }
    return out;
}

function spidxFail(message) {
    return '{"ok":false,"message":"' + spidxEscape(message) + '"}';
}

function spidxActiveSequence() {
    return app.project ? app.project.activeSequence : null;
}

// Same problem as spidxResolveFolder() in the AE host: CEP and
// ExtendScript disagree about what a path string looks like, and
// ExtendScript's Folder()/File() silently resolve the URI-ish
// "/C/Users/..." form relative to the drive root instead of erroring.
function spidxResolveFolder(raw) {
    var input = String(raw || "");
    var candidates = [];

    function push(value) {
        if (value && candidates.join("\u0000").indexOf(value) === -1) candidates.push(value);
    }

    push(input);
    push(input.replace(/\\/g, "/"));
    push(input.replace(/^\/([A-Za-z])\//, "$1:/"));
    push(input.replace(/^file:\/\/\//, ""));
    try { push(decodeURI(input)); } catch (e) {}

    for (var i = 0; i < candidates.length; i++) {
        var folder = new Folder(candidates[i]);
        if (folder.exists) return folder;
    }

    throw new Error("The incoming folder could not be found from Premiere Pro. Tried: " + candidates.join(" | "));
}

function spidxStamp() {
    return "spidx_" + (new Date()).getTime();
}

// Used to require copying the .epr into two places (Media Encoder's own
// Presets folder AND this extension's presets/ folder) — now it's just
// wherever Premiere's "Save Preset..." already put it. The extension's
// own presets/ folder is still checked first so installs set up under
// the old two-copy instructions keep working with no extra step.
function spidxPresetPath() {
    var thisFile = new File($.fileName);
    var bundled = new File(thisFile.parent.parent.fsName + "/presets/pngframe.epr");
    if (bundled.exists) return bundled;

    // Media Encoder's Presets folder embeds a version number in its path
    // (e.g. ".../Adobe Media Encoder/25.0/Presets/") that changes every
    // release, so every version folder under the root gets checked
    // instead of hardcoding one.
    var root = new Folder("~/AppData/Roaming/Adobe/Adobe Media Encoder");
    if (root.exists) {
        var versionFolders = root.getFiles(function (f) { return f instanceof Folder; });
        versionFolders.sort(function (a, b) { return b.name > a.name ? 1 : (b.name < a.name ? -1 : 0); });
        for (var i = 0; i < versionFolders.length; i++) {
            var candidate = new File(versionFolders[i].fsName + "/Presets/pngframe.epr");
            if (candidate.exists) return candidate;
        }
    }

    return bundled; // still missing everywhere — caller reports exactly this path as "not found"
}

/* ---------------------------------------------------------------------- *
 *  Context — what the panel shows before you click anything
 * ---------------------------------------------------------------------- */
function spidxContext() {
    try {
        var seq = spidxActiveSequence();
        var projectName = app.project && app.project.name ? app.project.name : "Untitled project";

        if (!seq) {
            return '{"ok":true,"hasComp":false,"project":"' + spidxEscape(projectName) + '"}';
        }

        var posTicks = seq.getPlayerPosition(); // Time object, .ticks / .seconds
        var fps = spidxSequenceFps(seq);
        var frame = fps ? Math.round(Number(posTicks.seconds) * fps) : 0;

        return '{"ok":true,"hasComp":true'
            + ',"comp":"' + spidxEscape(seq.name) + '"'
            + ',"width":' + (seq.frameSizeHorizontal || 0)
            + ',"height":' + (seq.frameSizeVertical || 0)
            + ',"time":' + Number(posTicks.seconds)
            + ',"frame":' + frame
            + ',"duration":' + (seq.end ? Number(seq.end) : 0)
            + ',"project":"' + spidxEscape(projectName) + '"}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

// videoFrameRate isn't exposed directly on Sequence in every Premiere
// build; settings.videoFrameRate (a Time object, ticks-per-frame) is the
// stable way to derive it across versions.
function spidxSequenceFps(seq) {
    try {
        var settings = seq.getSettings();
        var tpf = Number(settings.videoFrameRate.ticks);
        if (tpf > 0) return 254016000000 / tpf; // ticks-per-second / ticks-per-frame
    } catch (e) {}
    return null;
}

/* ---------------------------------------------------------------------- *
 *  Current frame -> PNG in incoming
 *
 *  Unlike AE's one-call saveFrameToPng, this is: pin in/out to the
 *  current frame, kick off an async export, then poll for the file the
 *  same way the AE side polls for saveFrameToPng's bytes to flush.
 * ---------------------------------------------------------------------- */
function spidxSaveFrame(incomingPath, viaPhotoshop, presetOverride) {
    var partFile = null;
    var savedIn = null, savedOut = null;

    try {
        var seq = spidxActiveSequence();
        if (!seq) return spidxFail("No sequence is active — open a sequence in the Timeline panel, then try again.");

        // A manually-picked path (the panel's "Change preset (.epr)"
        // link) always wins over auto-detection — that's the whole
        // point of letting the user point at it themselves.
        var preset = (presetOverride && String(presetOverride).length) ? new File(presetOverride) : spidxPresetPath();
        if (!preset.exists) {
            return spidxFail(
                "PNG export preset not found at " + preset.fsName + ". " +
                "Run Premiere's Export Media dialog once, set Format to PNG, click " +
                "\"Save Preset...\", name it pngframe.epr and save it into the panel's " +
                "presets folder — see PRESET-SETUP.txt. This is a one-time setup step."
            );
        }

        var folder = spidxResolveFolder(incomingPath);
        var baseName = spidxStamp();
        var suffix = viaPhotoshop ? ".ps.png" : ".png";

        // Remember the sequence's current in/out so this doesn't
        // permanently change what the user had marked in the timeline.
        savedIn = seq.getInPoint();
        savedOut = seq.getOutPoint();

        var pos = seq.getPlayerPosition();
        // in == out is NOT a reliable "one frame" work area — Adobe's own
        // official PProPanel sample deliberately avoids it too (see
        // exportCurrentFrameAsPNG() in Adobe-CEP/Samples), because a
        // zero-length range is ambiguous to the export engine. This is
        // the most likely cause of two things reported together: the
        // wrong/stale frame coming out, and the export taking far longer
        // than one frame should — a work area Premiere can't pin down to
        // exactly one frame can fall back to re-rendering a much bigger
        // range instead of just grabbing the current frame.
        var fps = spidxSequenceFps(seq);
        var oneFrame = fps ? (1 / fps) : (1 / 30); // 30fps fallback only if fps truly can't be read
        seq.setInPoint(pos.seconds);
        seq.setOutPoint(pos.seconds + oneFrame);

        var wantedPath = folder.fsName + "/" + baseName + SPIDX_PART_EXT;
        partFile = new File(wantedPath);

        // exportAsMediaDirect returns before the file is necessarily
        // finished writing — it queues the export and returns
        // immediately — so this polls for it exactly like the AE side
        // polls for saveFrameToPng's bytes to flush.
        var queued = seq.exportAsMediaDirect(partFile.fsName, preset.fsName, app.encoder.ENCODE_IN_TO_OUT);
        if (!queued) {
            return spidxFail("Premiere Pro rejected the export request. Check that pngframe.epr is a valid PNG preset.");
        }

        // Premiere does not always honor the exact output path we asked
        // for: depending on how the .epr was saved, a PNG preset can be
        // an "Export As Sequence" preset, in which case Premiere inserts
        // its own frame-number before the extension (e.g.
        // "spidx_123" + "00000000" + ".pngpart"), or it can force its own
        // real extension onto the name regardless of what we passed
        // (".pngpart" -> ".png"). Either way the exact wantedPath never
        // appears and the old code waited the full timeout for nothing.
        // So on top of watching wantedPath, also watch the incoming
        // folder for ANY new file whose name starts with baseName and
        // treat whichever shows up first as the real export.
        function spidxFindByBaseName() {
            try {
                var matches = folder.getFiles(function (f) {
                    return (f instanceof File) && f.name.indexOf(baseName) === 0;
                });
                for (var m = 0; m < matches.length; m++) {
                    if (matches[m].length > 0) return matches[m];
                }
            } catch (e) {}
            return null;
        }

        var found = null;
        for (var waited = 0; waited < 30000 && !found; waited += 200) {
            if (partFile.exists && partFile.length > 0) { found = partFile; break; }
            found = spidxFindByBaseName();
            if (found) break;
            $.sleep(200);
        }

        if (!found) {
            return spidxFail("Premiere Pro did not write the frame to: " + partFile.fsName
                + " (folder exists: " + folder.exists + ") — exports can take longer on a slow disk; try Upload again. "
                + "If this keeps happening, re-check pngframe.epr in PRESET-SETUP.txt: it must be a plain PNG preset "
                + "with \"Export As Sequence\" UNCHECKED.");
        }
        partFile = found;
        if (partFile.length === 0) {
            try { partFile.remove(); } catch (e) {}
            return spidxFail("Premiere Pro wrote an empty frame — check that pngframe.epr still points at a PNG format.");
        }

        var finalFile = new File(folder.fsName + "/" + baseName + suffix);
        if (finalFile.exists) { try { finalFile.remove(); } catch (e) {} }

        var size = partFile.length;
        var renamed = false;
        for (var attempt = 0; attempt < 8 && !renamed; attempt++) {
            if (attempt > 0) $.sleep(150);
            renamed = partFile.rename(baseName + suffix);
        }
        if (!renamed) {
            return spidxFail("Could not rename the finished frame to " + baseName + suffix
                + " (another process — often antivirus real-time scanning — may still have it locked; try Upload again).");
        }

        return '{"ok":true,"name":"' + spidxEscape(baseName + suffix) + '","size":' + size
            + ',"comp":"' + spidxEscape(seq.name) + '"}';
    } catch (err) {
        if (partFile) { try { if (partFile.exists) partFile.remove(); } catch (e) {} }
        return spidxFail(err.toString());
    } finally {
        // Always restore the user's original in/out points, export
        // success or not.
        try {
            var seq2 = spidxActiveSequence();
            if (seq2 && savedIn !== null && savedOut !== null) {
                seq2.setInPoint(savedIn.seconds);
                seq2.setOutPoint(savedOut.seconds);
            }
        } catch (e) {}
    }
}

/* ========================================================================
 *  Properties tab — reading/writing Essential Graphics (MOGRT) text
 *  properties on the selected clip
 *
 *  Premiere's DOM does have a route into a Graphics/MOGRT clip's
 *  Essential Graphics properties: TrackItem.getMGTComponent() returns a
 *  Component whose .properties collection can be read and written with
 *  ComponentParam.getValue()/.setValue(). It's the Premiere equivalent
 *  of the AE panel reaching into a text layer's Source Text property —
 *  just a different-shaped API, so it gets its own tab instead of being
 *  folded into "Leaderboard".
 *
 *  Two real rough edges, both confirmed by Adobe's own scripting forum,
 *  not guessed:
 *   1. This is designed around .mogrts authored in After Effects — a
 *      .mogrt built entirely inside Premiere's Essential Graphics panel
 *      is not guaranteed to expose the same component tree.
 *   2. A text parameter's value comes back as a PLAIN STRING on some
 *      Premiere builds (~13.1.5/14.0) and as a JSON string like
 *      {"textEditValue":"...","fontTextRunLength":[n],...} on others
 *      (14.1+). Both are handled below — see spidxSetGraphicText().
 *      fontTextRunLength has to be updated to match the new text's
 *      length or the JSON branch silently fails to render.
 *
 *  Given that inconsistency, treat this as best-effort per-project
 *  rather than guaranteed to work on every .mogrt/every Premiere build.
 * ==================================================================== */

function spidxSelectedGraphicsClip() {
    var seq = spidxActiveSequence();
    if (!seq) return null;

    var selection = null;
    try { selection = seq.getSelection(); } catch (e) { selection = null; }
    if (!selection || !selection.length) return null;

    for (var i = 0; i < selection.length; i++) {
        var item = selection[i];
        if (typeof item.getMGTComponent !== "function") continue;
        var component = null;
        try { component = item.getMGTComponent(); } catch (e) { component = null; }
        if (component) return { clip: item, component: component };
    }
    return null;
}

// Text params, checkbox params and slider params all come back from
// getValue() as strings with no type tag, so this tells them apart by
// shape: numbers and true/false are almost certainly sliders/checkboxes,
// a {"textEditValue":...} JSON blob is definitely text, and anything
// else non-numeric is treated as a plain-string text field (the
// pre-14.1 Premiere shape).
function spidxParamLooksLikeText(rawValue) {
    if (rawValue == null) return false;
    var trimmed = String(rawValue).replace(/^\s+|\s+$/g, "");
    if (trimmed === "") return false;
    if (trimmed === "true" || trimmed === "false") return false;
    if (!isNaN(Number(trimmed))) return false;
    if (trimmed.charAt(0) === "{") {
        try {
            var parsed = JSON.parse(trimmed);
            return !!(parsed && typeof parsed === "object" && ("textEditValue" in parsed));
        } catch (e) { return false; }
    }
    return true;
}

// Returns the selected clip's text-like Essential Graphics properties,
// for the Properties tab's dropdown.
function spidxListGraphicTextProperties() {
    try {
        var found = spidxSelectedGraphicsClip();
        if (!found) return '{"ok":true,"hasClip":false}';

        var props = found.component.properties;
        var names = [];
        for (var i = 0; i < props.numItems; i++) {
            var param = props[i];
            var raw = null;
            try { raw = param.getValue(); } catch (e) { raw = null; }
            if (spidxParamLooksLikeText(raw)) names.push(spidxEscape(param.displayName));
        }

        var clipName = "";
        try { clipName = found.clip.name; } catch (e) {}

        return '{"ok":true,"hasClip":true,"clip":"' + spidxEscape(clipName) + '"'
            + ',"properties":["' + names.join('","') + '"]}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

// Writes `text` into the named text property of the selected clip's
// Essential Graphics component. Called from the Properties tab's
// "Apply to selected clip" button with a nick picked from Leaderboard
// (or typed by hand).
function spidxSetGraphicText(displayName, text) {
    try {
        var found = spidxSelectedGraphicsClip();
        if (!found) return spidxFail("Select a Graphics (MOGRT) clip on the timeline first.");

        var param = found.component.properties.getParamForDisplayName(String(displayName));
        if (!param) return spidxFail("Property \"" + displayName + "\" was not found on the selected clip — the selection may have changed. Click Refresh.");

        var raw = null;
        try { raw = param.getValue(); } catch (e) { raw = null; }

        if (raw != null && String(raw).charAt(0) === "{") {
            try {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && ("textEditValue" in parsed)) {
                    parsed.textEditValue = text;
                    parsed.fontTextRunLength = [String(text).length];
                    param.setValue(JSON.stringify(parsed), true);
                    return '{"ok":true}';
                }
            } catch (e) { /* not JSON after all — fall through to the plain-string branch */ }
        }

        param.setValue(text, true);
        return '{"ok":true}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}
