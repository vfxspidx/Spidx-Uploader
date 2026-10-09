Spidx Uploader — VEGAS Pro plugin
=================================

PRO ONLY (v1.1.0): uploading from VEGAS needs a Pro plan. The panel locks its Upload buttons
for Free/other plans, and every file is tagged ".vg" (spidx_123.vg.png) so the helper itself
refuses it for a non-Pro licence (the refused file is moved to incoming\rejected). The tag is
removed again before uploading. An OLD plugin version (no tag) is not recognised by the helper -
update the plugin from the Dashboard.

EASIEST WAY (no manual building):
    - Setup wizard, step "Connect your panels" -> "Install the VEGAS Pro plugin", or
    - Dashboard -> Account -> Plugins -> VEGAS Pro plugin -> Install / Update / Uninstall, or
    - double-click "Install VEGAS Plugin.bat" in this folder (or tick the
      VEGAS option in the Windows installer).
    Close VEGAS first. A console window (with an admin prompt) finds your VEGAS,
    builds SpidxUploader.dll for it, copies it into VEGAS's "Application Extensions"
    folder and pre-fills the panel's incoming folder. Then open
    View > Extensions > Spidx Uploader in VEGAS.
    "Uninstall VEGAS Plugin.bat" removes it again.

    Files here: SpidxUploaderExtension.cs (source), install-vegas.js (installer
    logic), version.txt (plugin version shown in the Dashboard), build.bat (old
    manual build, still works).

The rest of this file is the technical background.
----------------------------------------------------------------------

Spidx Uploader — VEGAS Pro (Application Extension)
====================================================

WHAT THIS IS
    A real, dockable panel inside VEGAS — the VEGAS twin of the After
    Effects (CEP) and Photoshop (UXP) panels. Same protocol (the same
    small files in App\incoming) and the same LOOK as the current AE panel
    (panel-ae.html): colors, radii, px font sizes, paddings and margins are
    taken from that file's CSS, not approximated.

    - FLUID WIDTH: the panel fills whatever width the VEGAS dock has (no
      more fixed 420px) — resize the dock and every row re-lays-out, like
      the HTML panel does.
    - SIZE: everything (fonts, paddings, buttons, radii) is scaled 1.3x
      relative to the AE panel, because VEGAS's own UI is bigger than
      Adobe's narrow sidebar. To change it, edit "uiScale" (e.g. 1.0, 1.5,
      1.75) in %APPDATA%\Spidx Uploader\vegas-panel-config.json and
      restart VEGAS (default 1.3 if the key is missing).
    - Fonts are pixel-sized exactly like the CSS (12.5px title, 10.5px
      sub-text, 11.5px segmented buttons, ...), Segoe UI / Segoe UI Semibold.
    - Header: gradient "S" mark, title, tier badge (FREE/PRO/DEV/TESTER +
      trial days) colored per tier.
    - Tabs: Uploader / Leaderboard (active = solid accent).
    - Status card (border turns green/red), progress track, "FILES PER
      UPLOAD" label with the CSS letter-spacing, 1/2/3 segmented control.
    - Buttons side by side like the AE panel: "Upload" (solid accent) +
      "Photoshop + Upload" (secondary, 1.5px border). Photoshop + Upload is
      disabled until a Camera Raw Action is configured in the Dashboard.
    - File row, batch dots + Send now / Cancel, footer link + path
      (path truncated from the left, like direction: rtl in the CSS).
    - ANIMATIONS (same as the AE panel's CSS transitions): 150ms hover /
      active cross-fades on buttons, tabs and the 1/2/3 control, smooth
      progress-bar fill + sliding indeterminate bar while uploading, status
      card pulse on every status change, Leaderboard rows slide/fade in.
      One shared 15ms timer, only running while something animates.
    - Leaderboard: rounded Region select (dark dropdown), Refresh, rounded
      search field, a hand-drawn player table that matches the HTML one
      (dark header, hairline rows, hover/selected tint, thin dark
      scrollbar, mouse wheel), a Copy Nick button.

BUILD (one-time, or after any code change)
    1. Run build.bat in this folder. It compiles SpidxUploaderExtension.cs
       into SpidxUploader.dll using csc.exe (ships with every Windows
       .NET Framework install — no Visual Studio needed).
    2. If it can't find your VEGAS install automatically, open build.bat
       in a text editor and add your actual install folder to the list
       near the top, then run it again.

INSTALL
    1. Find your VEGAS "Application Extensions" folder — typically:
       %ProgramData%\Vegas Pro\<version>.0\Application Extensions\
    2. Copy the SpidxUploader.dll that build.bat produced into that
       folder.
    3. Restart VEGAS.

USE
    View > Extensions > Spidx Uploader opens the panel. First use asks
    you to pick App\incoming (via "Change incoming folder"); remembered
    after that, along with batch count and Drive folder name, across
    VEGAS restarts.

TWO UPLOAD ROUTES, ONE FILE-NAMING RULE
    "Upload" writes a plain "<name>.png" — uploads straight through.
    "Photoshop + Upload" writes "<name>.ps.png" — the ".ps." marker tells
    Spider Engine (server.js's needsCameraRaw()) to route it through
    Photoshop's Camera Raw Action first. Same rule the After Effects
    panel uses, so both panels share one running Spider Engine with no
    server-side changes.

LEADERBOARD TAB (SpidxTracker / Fortnite)
    Region filter, search (debounced, same as the AE panel), Refresh,
    and an offline cache (.leaderboard-cache.json in App\incoming, same
    file/format the AE panel writes) that kicks in automatically if the
    API is unreachable. Talks to the same API the AE panel does
    (http://169.58.221.14:8080/api/fortnite).

    "Copy Nick" is included and fully working (Clipboard.SetText — a
    plain, reliable .NET API).

    The AE panel's "Replace Text" is intentionally NOT in the VEGAS panel:
    it inserts a text layer via ExtendScript, and VEGAS scripting cannot set
    a text generator's text content. Use "Copy Nick" and paste the name.

    The player list is a custom-drawn control (no stock ListView), so the
    header, rows and scrollbar are dark like the AE panel's table.

IF SOMETHING GOES WRONG
    Errors during panel setup or Send/Upload now show a "Spidx Uploader —
    diagnostic" dialog with the real .NET exception type, message, and
    stack trace — not VEGAS's own generic "An invalid argument was
    specified" box, which swallows everything useful. Paste that whole
    dialog's text back for a real fix.

    Written against VEGAS's published Application Extension API
    (ICustomCommandModule, CustomCommand, DockableControl,
    LoadDockView/ActivateDockView, PersistDockWindowState/
    AutoLoadCommand on DockableControl — MAGIX's "VEGAS Pro Scripting
    FAQs", Section 4) and the AE panel's real CSS/JS as the visual and
    protocol reference — not invented from scratch. But never compiled
    or run inside a real VEGAS install outside of your machine. Every
    round so far has needed one real fix after an actual compile/run;
    expect that to continue, especially after a rewrite this size
    (~2500 lines) — a fresh compile error or a new runtime diagnostic
    dialog is the normal next step, not a sign something is badly wrong.

    Older VEGAS versions (13 and below) use `Sony.Vegas` instead of
    `ScriptPortal.Vegas` — swap the `using` line at the top of the .cs
    file AND point build.bat at Sony.Vegas.dll instead if needed.
