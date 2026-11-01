# Spidx Uploader 3.0.0 - what's new

**In short:** the new SE 3 engine. Render videos straight from Premiere Pro or VEGAS Pro and upload them to Google Drive or WorkUpload, and the whole Dashboard now speaks 9 languages.

## New
- **Render & upload video** (Premiere Pro, VEGAS Pro): pick your own render preset/template, the host renders (no extra compression), the helper uploads the finished file. Clips from 1 s to 30 min.
- **Resumable Google Drive upload** for big files: live progress and speed in the Dashboard, Cancel button, survives network drops, and continues after a restart or crash.
- **Languages:** English, Polish, German, French, Spanish, Portuguese (BR), Italian, Turkish, Russian - Dashboard, setup wizard, tray. Change in Dashboard → Language (Auto = Windows language).
- Video files are only picked up once fully written, so half-rendered files are never uploaded.
- **Dashboard rebuilt:** side menu (Overview, History, Activity, Templates, Settings, Status, Account), live status hero, recent uploads, History with thumbnails and filters, searchable Settings with autosave, Status page with health checks and a copyable report, light/dark theme, banner when a new app version or newer panels are available.
- **Templates (Dashboard):** add .aep files and map each composition + text layer to a template without editing `templates.json`; the After Effects SPT tab re-reads the list every time it opens.
- **Leaderboard** now goes through the helper, so the After Effects / Premiere panels no longer run with Chromium's web security disabled (`--disable-web-security` is gone). The helper has to be running for the Leaderboard to load.
- **Render (After Effects / Premiere):** names with spaces no longer make the render look like it produced no file, a live clock shows while the host app is busy, and errors now say what AE or Premiere reported.
- **Licence proof bound to the computer:** with the RSA key installed the app also requires a second signature that is only valid on the computer it was issued to, so a licence file copied to another PC does not work. Proofs are valid 14 days offline.
- **Updater window:** a small app-style window (open it from the tray's "Update available" item, or Dashboard > Account > Open the updater) that checks the version, downloads the installer with progress and a Cancel button, starts it, and can check and repair the installed panels.
- **Render allowance counted on the server:** the free plan's 15 renders a month are now counted by the licence server per Google account and per computer (signed answers; 3 renders per month are let through offline and reported later). `render-usage.json` is only a cache of the server's answer.
- **Batches are for thumbnails only:** while "Files per upload" is 2 or 3, or a batch is being collected, "Render & upload" is blocked in the After Effects, Premiere Pro and VEGAS Pro panels (with a note saying why). A rendered video is always its own upload and never joins a batch of stills.
- **WorkUpload survives a closed tab:** if the WorkUpload tab or browser window is closed during an upload, the helper notices at once (the waiting loops used to poll a dead page for minutes, or for hours with a big video), opens a new tab and starts the upload again without using up a retry (up to 3 times). An upload that still fails is remembered and can be sent again with the "Retry now" button on the Dashboard Overview; the files are never deleted by a failure. A tab you open yourself no longer gets taken over by the helper.
- **Thumbnail Pack content is delivered by the server, not the installer:** the After Effects templates and presets and the Premiere Pro MOGRT templates are no longer inside the installer or the panels. The licence server gives them only to an account that has the Pack (role SPT, or dev / tester) and only to one of its registered computers; the helper downloads them into `%APPDATA%\Spidx Uploader\pack`, checks every file against a signed checksum, keeps them up to date and removes them if the account loses the Pack. Dashboard > Templates shows the state, has a Sync now button and keeps the user's own templates separate. Setup for the owner: `Tools\PACK-README.txt`.
- **Panels in 9 languages:** the After Effects, Premiere Pro and VEGAS Pro panels now follow the language chosen in the Dashboard (the helper hands them the dictionary). Texts without a translation, and texts that contain names or numbers, stay in English.
- **New look for the setup wizard and the installer:** the first-run wizard opens in its own app window with the same glass design as the Dashboard and the Updater, and the Inno installer has the new branding images.
- **Clean-up:** the dead "needs Pro" messages for Premiere Pro and VEGAS Pro, an unused field in the VEGAS plugin and outdated README sentences were removed.
- **VEGAS Pro panel size:** the panel now follows the screen's own scaling (100% = normal size, 125%, 150% ... scale with Windows) instead of a fixed 1.3x enlargement, so it is as big as VEGAS's own UI on any computer and the whole panel is about a quarter shorter. A manual override is `panelScale` in `%APPDATA%\Spidx Uploader\vegas-panel-config.json`; the old, automatically saved `uiScale` is ignored.
- **VEGAS Pro panel in a narrow dock:** the header no longer cuts off the name (the plan badge shortens to "TESTER" and, in a very narrow dock, the name shrinks a little and the small "S" steps aside), and the "Photoshop + Upload" button wraps onto two lines ("PS + Upload" when even that does not fit) instead of being clipped.
- **New plans:** the free plan now includes the Premiere Pro panel and the VEGAS Pro plugin, with 15 video renders per calendar month (Render & upload, counted across all apps; stills are not counted). Pro has unlimited renders and uploads. The Dashboard shows the count and warns before the limit; the panels warn before a render that would be refused. A video over the limit is moved to `incoming\rejected`, never deleted.
- **New logo:** the gradient "S" is now the logo everywhere: Dashboard, setup wizard, tray, desktop shortcut and the After Effects and Premiere Pro panel icons (the Photoshop panel keeps its old icon until it is rebuilt).
- Panels got the same glass look as the Dashboard. The Dashboard's HTML/CSS/JS moved out of `dashboard.js` into `App\dashboard-ui\`.

## Notes
- VEGAS render is new and needs a rebuild of the plugin (`build.bat`).
- Panels (Premiere, After Effects, VEGAS, Photoshop) are still English-only for now.

---

