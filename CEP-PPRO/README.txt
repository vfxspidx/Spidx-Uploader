Spidx Uploader — Premiere Pro port
===================================

This is a port of CEP-AE (the After Effects panel) to Premiere Pro.
It's a separate CEP extension bundle (com.spidx.uploader.ppro) that
installs and runs independently of the AE panel — you can have both
installed at once, on the same machine, pointed at the same App\incoming
folder, and the Spider Engine (App/server.js) serves both without any
changes on its side.

Install
-------
1. Read PRESET-SETUP.txt FIRST and create pngframe.epr — the panel
   can't export a frame without it (see "What had to change" below).
2. Close Premiere Pro.
3. Run "Install PPRO Panel.bat".
4. Open Premiere Pro > Window > Extensions > Spidx Uploader.
5. Click "Change incoming folder" and point it at the same
   App\incoming folder the Photoshop/AE panels use.

What's identical to the AE panel
---------------------------------
- The whole batch/engine-status protocol: .batch-config.json,
  .batch-status.json, .engine-status.json, .batch-force-send,
  .batch-cancel — byte-for-byte the same files, same folder.
- The UI shell: same look, same Uploader tab, same tier badge, batch
  selector, Drive folder-name field.
- The Leaderboard tab's data fetching, table, search, region filter and
  "Copy Nick" button — all pure client-side JS, host-independent.
- client/index.js's structure for the Uploader tab — a near line-for-
  line port of CEP-AE/client/index.js, only renamed keys/labels.

What had to change
-------------------
1. Frame export (host/spidx.jsx spidxSaveFrame). After Effects has
   CompItem.saveFrameToPng() — a single call, no setup. Premiere Pro's
   DOM has no equivalent method on Sequence; confirmed against Adobe's
   own Scripting Guide. The scripted route is: set in/out points to the
   current frame, then Sequence.exportAsMediaDirect(path, presetPath,
   ENCODE_IN_TO_OUT) with a PNG export preset (.epr). That preset is
   not something a script can generate — it has to come from Premiere's
   own Export Media dialog once. This is an Adobe API limitation, not a
   design choice on this port's part. See PRESET-SETUP.txt.

2. Leaderboard "Insert + Essential Graphics" button — replaced with a
   new Properties tab, not just a clipboard workaround. Premiere Pro
   DOES have a scriptable route into a selected Graphics/MOGRT clip's
   Essential Graphics text fields: TrackItem.getMGTComponent() +
   ComponentParam.getValue()/.setValue() (confirmed against Adobe's
   forum, since this specific call isn't in the official docs — see the
   long comment above spidxSelectedGraphicsClip() in host/spidx.jsx for
   the two real version-dependent quirks it works around). The
   Properties tab tracks the Timeline selection automatically (same
   POLL_MS interval the Uploader tab already uses for engine status —
   no manual Refresh needed): select a Graphics clip, pick a detected
   text property, pick a nick from Leaderboard (or type one), click
   Apply. It writes straight into the MOGRT the way the AE version
   wrote into a text layer. Treat it as best-effort per .mogrt rather
   than guaranteed — Adobe's own forum shows this API's exact value
   shape changing across Premiere versions.

3. The native Program Monitor "Export Frame" button (camera icon,
   Ctrl+Shift+E) is NOT scriptable — confirmed on Adobe's own forum
   (an Adobe engineer's answer to "is it possible to export a frame
   using the SDK" points to exportAsMediaDirect + a preset; the more
   obvious-looking exportFramePNG() is widely reported as returning
   false and exporting nothing). exportAsMediaDirect + pngframe.epr is
   the only working route, not a workaround chosen over a simpler one.

3. Manifest: Host changed from AEFT to PPRO, minimum app version 14.0
   (Premiere Pro 2020, the first build with a reliable
   exportAsMediaDirect for this purpose), bundle ID
   com.spidx.uploader.ppro so it installs alongside the AE panel
   without conflicting.

Files
-----
CSXS/manifest.xml        Extension manifest (PPRO host)
client/index.html        Panel UI (Uploader / Leaderboard / Properties tabs)
client/index.js          Panel logic
host/spidx.jsx           ExtendScript host — frame export + MOGRT properties
presets/                 Optional — a copy of pngframe.epr here still works, but is no longer required (see PRESET-SETUP.txt)
icons/                   Reused from the AE panel
Install PPRO Panel.bat   Installer (PlayerDebugMode + copy to CEP extensions)
PRESET-SETUP.txt         One-time PNG preset setup, read this first
