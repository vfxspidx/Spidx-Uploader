/* ========================================================================
 *  Spidx Uploader — Photoshop bridge job
 *
 *  Run inside an already-running Photoshop via DoJavaScriptFile (see
 *  App/photoshop-bridge.vbs / App/photoshop-bridge.js). Not a panel
 *  script — this is a one-shot job.
 *
 *  Behavior: the frame After Effects saved is dropped in as a NEW LAYER
 *  at the bottom of whatever document is currently active in Photoshop
 *  (e.g. a particles/overlay template already open and set up) — it no
 *  longer opens a separate new document per frame. The Camera Raw Action
 *  runs on just that new layer, then a flattened, throwaway duplicate of
 *  the whole document (particles + frame, composited) is what actually
 *  gets saved as the JPG and uploaded. The real open document is never
 *  flattened or saved — only a disposable copy of it is.
 *
 *  Arguments (via DoJavaScriptFile's Arguments array):
 *    arguments[0]  input PNG path (from After Effects)
 *    arguments[1]  Action Set name
 *    arguments[2]  Action name
 *    arguments[3]  output JPG path to write the result to
 *
 *  Returns a JSON string — this is the script's own return value, which
 *  DoJavaScriptFile hands back to the .vbs caller and Node reads off
 *  stdout. Failures come back as data instead of a thrown COM error, so
 *  server.js can fall back to uploading the raw frame cleanly.
 * ==================================================================== */

function spidxEscape(value) {
    var s = String(value);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '"' || c === "\\") out += "\\" + c;
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else out += c;
    }
    return out;
}

// The top-level `arguments` here is what DoJavaScriptFile actually fills
// in (Photoshop's own mechanism for passing args into a loaded script —
// not a function parameter list). It has to be captured up here, at
// top-level scope, and handed into the IIFE below explicitly — inside a
// `(function () {...})()` with no declared parameters, `arguments`
// would refer to *that* function's own empty argument list instead,
// which is exactly the bug that produced "Input file does not exist:
// undefined" (inputPath was silently undefined).
var spidxInputPath  = arguments[0];
var spidxActionSet  = arguments[1];
var spidxActionName = arguments[2];
var spidxOutputPath = arguments[3];

(function (inputPath, actionSet, actionName, outputPath) {
    var tempDoc = null;
    var newLayer = null;
    var flatDup = null;
    var targetDoc = null;

    try {
        var inFile = new File(inputPath);
        if (!inFile.exists) {
            return '{"ok":false,"error":"Input file does not exist: ' + spidxEscape(inputPath) + '"}';
        }

        if (app.documents.length === 0) {
            return '{"ok":false,"error":"No document is open in Photoshop \\u2014 open your particles/template project first, then try again."}';
        }
        targetDoc = app.activeDocument;

        // Bring the frame in as a new layer at the bottom of the active
        // document's stack, instead of opening it as its own document.
        tempDoc = app.open(inFile);
        newLayer = tempDoc.activeLayer.duplicate(targetDoc, ElementPlacement.PLACEATEND);
        tempDoc.close(SaveOptions.DONOTSAVECHANGES);
        tempDoc = null;

        newLayer.name = "AE Frame";
        app.activeDocument = targetDoc;
        targetDoc.activeLayer = newLayer;

        try {
            app.doAction(actionName, actionSet);
        } catch (actionErr) {
            // Leave the document the way it was before this run — a
            // half-processed leftover layer would be worse than none.
            try { newLayer.remove(); } catch (eRemove) {}
            return '{"ok":false,"error":"Action \\"' + spidxEscape(actionName) + '\\" (set \\"' + spidxEscape(actionSet)
                + '\\") failed or was not found \\u2014 check the names match the Actions panel exactly. '
                + spidxEscape(actionErr.toString()) + '"}';
        }

        // Export the composited result (particles + new frame) without
        // touching the real, still-open document — duplicate-and-merge
        // makes a disposable flattened copy, save that, throw it away.
        flatDup = targetDoc.duplicate(undefined, true);
        var outFile = new File(outputPath);
        var jpgOptions = new JPEGSaveOptions();
        jpgOptions.quality = 12;
        flatDup.saveAs(outFile, jpgOptions, true);
        flatDup.close(SaveOptions.DONOTSAVECHANGES);

        return '{"ok":true,"outputPath":"' + spidxEscape(outFile.fsName) + '"}';
    } catch (err) {
        try { if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
        try { if (flatDup) flatDup.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        return '{"ok":false,"error":"' + spidxEscape(err.toString()) + '"}';
    }
})(spidxInputPath, spidxActionSet, spidxActionName, spidxOutputPath);
