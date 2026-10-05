/* ========================================================================
 *  Spidx Uploader — After Effects host layer (ExtendScript)
 *
 *  After Effects has no UXP panel framework (only scripting-level UXP
 *  APIs), so the AE half of this plugin is CEP + ExtendScript while the
 *  Photoshop half stays UXP. Both halves talk to the SAME Spider Engine
 *  the same way: by dropping files into App\incoming and reading/writing
 *  the small dot-files in it. No network, no IPC, no second engine.
 *
 *  Scope is deliberately one operation: "Save Frame As > File" of the
 *  active comp's current frame, always PNG. No render queue involvement
 *  at all — that kept output-module templates, locale-dependent template
 *  names, half-written movies and hour-long blocking renders out of the
 *  picture entirely.
 *
 *  Every function here returns a JSON *string* — CEP's evalScript can
 *  only hand back strings, and ExtendScript has no JSON object.
 * ==================================================================== */

// Frames are written into this subfolder first and only moved into
// incoming once they're complete. Spider Engine treats any new file in
// incoming as "ready to upload" after a short size-stability check, so
// staging removes any chance of it grabbing a half-written PNG.
// Written next to the final name and renamed on completion. The
// extension matters: Spidx Engine picks up .png the moment it appears, so
// the in-progress file must NOT end in .png.
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

// app.project.activeItem only reflects a comp once its own
// Composition/Timeline panel has had focus — opening a second comp and
// clicking straight back into this CEP panel to hit Upload leaves
// activeItem pointing at whichever comp's viewer was focused first.
// Falling back to a single selected CompItem in the Project panel
// covers that case without needing the user to click into the
// Composition panel first.
function spidxActiveComp() {
    var item = app.project ? app.project.activeItem : null;
    if (item instanceof CompItem) return item;

    if (app.project && app.project.selection && app.project.selection.length === 1) {
        var sel = app.project.selection[0];
        if (sel instanceof CompItem) return sel;
    }

    return null;
}

// CEP and ExtendScript don't agree on what a path looks like. Depending
// on the After Effects build, cep.fs.showOpenDialog hands back
// "C:\\Users\\...", "C:/Users/..." or the URI-ish "/C/Users/...", and
// ExtendScript's Folder() silently resolves the last one relative to the
// drive root — which is exactly how a perfectly valid incoming folder
// ended up reported as "After Effects did not write the frame": the
// folder the frame was written into never existed.
function spidxResolveFolder(raw) {
    var input = String(raw || "");
    var candidates = [];

    function push(value) {
        if (value && candidates.join("\u0000").indexOf(value) === -1) candidates.push(value);
    }

    push(input);
    push(input.replace(/\\/g, "/"));
    // "/C/Users/..." and "/c/Users/..." -> "C:/Users/..."
    push(input.replace(/^\/([A-Za-z])\//, "$1:/"));
    // "file:///C:/Users/..." -> "C:/Users/..."
    push(input.replace(/^file:\/\/\//, ""));
    try { push(decodeURI(input)); } catch (e) {}

    for (var i = 0; i < candidates.length; i++) {
        var folder = new Folder(candidates[i]);
        if (folder.exists) return folder;
    }

    throw new Error("The incoming folder could not be found from After Effects. Tried: " + candidates.join(" | "));
}

function spidxStamp() {
    return "spidx_" + (new Date()).getTime();
}

/* ---------------------------------------------------------------------- *
 *  Context — what the panel shows before you click anything
 * ---------------------------------------------------------------------- */
function spidxContext() {
    try {
        var comp = spidxActiveComp();
        if (!comp) {
            return '{"ok":true,"hasComp":false,"project":"'
                + spidxEscape(app.project && app.project.file ? app.project.file.name : "Untitled project") + '"}';
        }
        return '{"ok":true,"hasComp":true'
            + ',"comp":"' + spidxEscape(comp.name) + '"'
            + ',"width":' + comp.width
            + ',"height":' + comp.height
            + ',"time":' + comp.time
            + ',"frame":' + Math.round(comp.time / comp.frameDuration)
            + ',"duration":' + comp.duration
            + ',"project":"' + spidxEscape(app.project && app.project.file ? app.project.file.name : "Untitled project") + '"}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

/* ---------------------------------------------------------------------- *
 *  Current frame -> PNG in incoming
 *
 *  saveFrameToPng is the only one-call still export AE scripting has; the
 *  render queue route would need an output module template just for a
 *  single frame. Spider Engine accepts PNG and compresses/converts it on
 *  its side if it's over the size limit.
 * ---------------------------------------------------------------------- */
function spidxSaveFrame(incomingPath, viaPhotoshop) {
    var partFile = null;

    try {
        var comp = spidxActiveComp();
        if (!comp) return spidxFail("No composition is active — click a composition in the Project panel or open its Timeline, then try again.");

        var folder = spidxResolveFolder(incomingPath);
        var baseName = spidxStamp();
        // The ".ps" marker is the only thing that tells server.js this
        // frame should be routed through Photoshop's Camera Raw Action
        // before it uploads — see needsCameraRaw() in server.js. Without
        // it, a frame always uploads as-is, even if a preset is
        // configured in the Dashboard; the choice is made here, per
        // click, not globally.
        var suffix = viaPhotoshop ? ".ps.png" : ".png";
        partFile = new File(folder.fsName + "/" + baseName + SPIDX_PART_EXT);

        app.beginUndoGroup("Spidx — save frame");
        try {
            comp.saveFrameToPng(comp.time, partFile);
        } finally {
            app.endUndoGroup();
        }

        // saveFrameToPng returns before the bytes are necessarily flushed
        // on some builds, so give it a moment rather than declaring
        // failure on the very first check.
        for (var waited = 0; waited < 4000 && (!partFile.exists || partFile.length === 0); waited += 100) {
            $.sleep(100);
        }

        if (!partFile.exists) {
            return spidxFail("After Effects did not write the frame to: " + partFile.fsName
                + " (folder exists: " + folder.exists + ", writable: " + (new Folder(folder.fsName)).exists + ")");
        }
        if (partFile.length === 0) {
            try { partFile.remove(); } catch (e) {}
            return spidxFail("After Effects wrote an empty frame — is the composition resolution set to something renderable?");
        }

        // Only now does the file get the name (and extension) the engine
        // watches for, so it can never be picked up mid-write.
        var finalFile = new File(folder.fsName + "/" + baseName + suffix);
        if (finalFile.exists) { try { finalFile.remove(); } catch (e) {} }

        var size = partFile.length;
        // A rename can transiently fail right after a file is written —
        // most commonly antivirus/real-time-scan briefly holding a lock
        // on the just-created file — so retry a few times before giving
        // up instead of failing on the first try.
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
            + ',"comp":"' + spidxEscape(comp.name) + '"}';
    } catch (err) {
        if (partFile) { try { if (partFile.exists) partFile.remove(); } catch (e) {} }
        return spidxFail(err.toString());
    }
}

/* ========================================================================
 *  Leaderboard tab — text-layer / Essential Graphics helpers
 *
 *  Ported from the standalone SpidxLeaderboardPanel.jsx (ScriptUI dockable
 *  panel). The leaderboard data-fetching, table, search/region filter and
 *  clipboard copy all moved to the CEP side (client/index.js) — a CEP
 *  panel can just fetch() and use the DOM directly, so none of that
 *  ExtendScript-Socket/temp-bat-file plumbing from the original script is
 *  needed here anymore. All that's left on the ExtendScript side is what
 *  can only happen here: touching the actual AE layer.
 * ==================================================================== */

function spidxGetSelectedTextLayer() {
    var comp = app.project ? app.project.activeItem : null;
    if (!comp || !(comp instanceof CompItem)) {
        return { error: "Open a composition and select a text layer." };
    }
    var layer = comp.selectedLayers.length ? comp.selectedLayers[0] : null;
    if (!layer || !layer.property("Source Text")) {
        return { error: "Select a text layer in the composition." };
    }
    return { comp: comp, layer: layer };
}

function spidxInsertIntoSelectedTextLayer(text) {
    var found = spidxGetSelectedTextLayer();
    if (found.error) return { ok: false, error: found.error };
    try {
        app.beginUndoGroup("SpidxTracker: insert nick");
        var sourceTextProp = found.layer.property("Source Text");
        var doc = sourceTextProp.value;
        doc.text = text;
        sourceTextProp.setValue(doc);
        app.endUndoGroup();
        return { ok: true };
    } catch (e) {
        app.endUndoGroup();
        return { ok: false, error: e.toString() };
    }
}

// Exposes the Source Text of the selected layer as an Essential Property
// ("Nickname") in the Essential Graphics panel.
//
// Known AE quirks this works around:
// - addToMotionGraphicsTemplateAs() can throw on some AE builds/localized
//   UIs even when the plain addToMotionGraphicsTemplate() (default name)
//   works fine — so it falls back to that automatically.
// - canAddToMotionGraphicsTemplate() returning false almost always means
//   the property is already exposed (not a real error), so that's
//   reported explicitly instead of a generic "could not add".
function spidxExposeNickAsEssentialProperty() {
    var found = spidxGetSelectedTextLayer();
    if (found.error) return { ok: false, error: found.error };
    var sourceTextProp = found.layer.property("Source Text");
    var aeInfo = "AE " + app.version;

    if (typeof sourceTextProp.canAddToMotionGraphicsTemplate !== "function") {
        return { ok: false, error: "This After Effects build has no Essential Graphics scripting API (" + aeInfo + ")." };
    }

    if (!sourceTextProp.canAddToMotionGraphicsTemplate(found.comp)) {
        return { ok: false, alreadyAdded: true, error: "Already in Essential Graphics (or this comp/property does not support it)." };
    }

    app.beginUndoGroup("SpidxTracker: add Nick to Essential Graphics");
    try {
        sourceTextProp.addToMotionGraphicsTemplateAs(found.comp, "Nickname");
        app.endUndoGroup();
        return { ok: true };
    } catch (eNamed) {
        // Fallback: try without a custom name, in case *As() is the part that fails.
        try {
            sourceTextProp.addToMotionGraphicsTemplate(found.comp);
            app.endUndoGroup();
            return { ok: true, usedDefaultName: true };
        } catch (eDefault) {
            app.endUndoGroup();
            return {
                ok: false,
                error: "addToMotionGraphicsTemplateAs: " + eNamed.toString() +
                    " | addToMotionGraphicsTemplate: " + eDefault.toString() +
                    " (" + aeInfo + ")"
            };
        }
    }
}

// Called from the panel's "Insert + Essential Graphics" button. Inserts
// first, then tries to expose — if exposing fails (e.g. already added),
// the insert itself still counts as a success.
function spidxLeaderboardInsertAndExpose(text, alsoExpose) {
    try {
        var insertResult = spidxInsertIntoSelectedTextLayer(text);
        if (!insertResult.ok) {
            return '{"ok":false,"error":"' + spidxEscape(insertResult.error) + '"}';
        }

        if (!alsoExpose) {
            return '{"ok":true}';
        }

        var essentialResult = spidxExposeNickAsEssentialProperty();
        if (essentialResult.ok) {
            return '{"ok":true,"essentialAdded":true,"usedDefaultName":' + (essentialResult.usedDefaultName ? "true" : "false") + '}';
        }
        return '{"ok":true,"essentialAdded":false,"essentialAlreadyAdded":' + (essentialResult.alreadyAdded ? "true" : "false")
            + ',"essentialError":"' + spidxEscape(essentialResult.error) + '"}';
    } catch (err) {
        return '{"ok":false,"error":"' + spidxEscape(err.toString()) + '"}';
    }
}

/* ========================================================================
 *  Search tab — Animation Presets + "Nest" (precompose)
 *
 *  Not a port of FX Console (its search/overlay logic is compiled into
 *  FXConsole.aex, closed-source, never inspected) — this is a from-
 *  scratch implementation using only documented AE scripting: File.
 *  applyPreset() for presets, layers.precompose() for nest.
 * ==================================================================== */

// Presets live in two standard, documented locations — nothing guessed
// or hardcoded per-machine:
//   - Folder.appFolder/Support Files/Presets  (AE's own bundled presets)
//   - Documents/Adobe/After Effects/<any version>/User Presets
//     (anything saved via Animation > Save Animation Preset...)
// Every version subfolder under the second one gets checked, the same
// way the Premiere Media Encoder preset lookup avoids hardcoding a
// version number.
function spidxListPresets() {
    var results = [];
    var roots = [];

    try {
        var builtin = new Folder(Folder.appFolder.fsName + "/Support Files/Presets");
        if (builtin.exists) roots.push(builtin);
    } catch (e1) {}

    try {
        var docsAE = new Folder(Folder.myDocuments.fsName + "/Adobe/After Effects");
        if (docsAE.exists) {
            var verFolders = docsAE.getFiles(function (f) { return f instanceof Folder; });
            for (var v = 0; v < verFolders.length; v++) {
                var up = new Folder(verFolders[v].fsName + "/User Presets");
                if (up.exists) roots.push(up);
            }
        }
    } catch (e2) {}

    function walk(folder, prefix) {
        var items;
        try { items = folder.getFiles(); } catch (eWalk) { return; }
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item instanceof Folder) {
                walk(item, prefix ? (prefix + " / " + item.name) : item.name);
            } else if (/\.ffx$/i.test(item.name)) {
                results.push({ name: (prefix ? prefix + " / " : "") + item.name.replace(/\.ffx$/i, ""), path: item.fsName });
            }
        }
    }
    for (var r = 0; r < roots.length; r++) walk(roots[r], "");

    var parts = [];
    for (var j = 0; j < results.length; j++) {
        parts.push('{"name":"' + spidxEscape(results[j].name) + '","path":"' + spidxEscape(results[j].path) + '"}');
    }
    return '{"ok":true,"presets":[' + parts.join(",") + ']}';
}

function spidxApplyPreset(presetPath) {
    var comp = app.project && app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
    if (!comp) return '{"ok":false,"error":"No composition is active."}';
    if (!comp.selectedLayers.length) return '{"ok":false,"error":"Select at least one layer first."}';

    var f = new File(presetPath);
    if (!f.exists) return '{"ok":false,"error":"Preset file not found: ' + spidxEscape(presetPath) + '"}';

    app.beginUndoGroup("SpidxSearch: apply preset");
    try {
        for (var i = 0; i < comp.selectedLayers.length; i++) comp.selectedLayers[i].applyPreset(f);
        app.endUndoGroup();
        return '{"ok":true}';
    } catch (err) {
        app.endUndoGroup();
        return '{"ok":false,"error":"' + spidxEscape(err.toString()) + '"}';
    }
}

function spidxNestSelectedLayers() {
    var comp = app.project && app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
    if (!comp) return '{"ok":false,"error":"No composition is active."}';
    if (!comp.selectedLayers.length) return '{"ok":false,"error":"Select at least one layer first."}';

    var indices = [];
    for (var i = 0; i < comp.selectedLayers.length; i++) indices.push(comp.selectedLayers[i].index);

    app.beginUndoGroup("SpidxSearch: nest (precompose)");
    try {
        comp.layers.precompose(indices, "Nested Comp", true);
        app.endUndoGroup();
        return '{"ok":true}';
    } catch (err) {
        app.endUndoGroup();
        return '{"ok":false,"error":"' + spidxEscape(err.toString()) + '"}';
    }
}
