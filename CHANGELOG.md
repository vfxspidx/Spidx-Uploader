# Spidx Uploader 2.8.0 — what's new

**In short:** send a frame with one keyboard shortcut, switch between clients with presets, see every upload in a history, and a brand-new template browser in the Premiere Pro panel. Plus a lot of fixes that make installing and updating the panels smoother.

---

## ✨ New

### Send a frame with one shortcut
Press **Ctrl+Alt+U** while After Effects, Premiere Pro, Photoshop or VEGAS Pro is in front and the current frame is uploaded — just like clicking *Upload* in the Spidx panel.
**Ctrl+Alt+Shift+U** does the same through the Photoshop Camera Raw route (*Photoshop + Upload*, Pro).
- Change or turn off the shortcut in **Dashboard → Settings → Global shortcut**.
- Free for everyone.
- The Spidx panel must be open in that program (*Window → Extensions*). If it isn't, you get a small message telling you so.

### Client presets
Save your current setup — destination, Google Drive folder, image compression and Camera Raw action — as a named preset (for example *"Client A"*), then switch with one click.
- Manage presets in **Dashboard → Settings → Client presets**.
- Switch right from the **After Effects** and **Premiere Pro** panels (new *Preset* list).
- Shows **"Active (modified)"** if you changed a setting after applying a preset.
- Free for everyone.

### Upload history
New **History** tab in the Dashboard: your latest uploads (up to 500) with links. Copy a link again, search by file name or client, remove entries, or clear the list. Stored only on your computer.

### Premiere Pro: MOGRT templates (SPT add-on)
A new **MOGRT** tab turns your motion graphics templates into a browser — thumbnails, categories (Eliminations, Damage…), search, and animated previews when you hover a template.
- **Click a template** and it is placed at the playhead on a free video track above V1. It never touches your footage.
- Type a nick (or click a player in the *Leaderboard* tab) and it is written into the graphic automatically (Pro).
- Nothing to install in Premiere first.
- Part of the **Spidx Thumbnail Pack V3** (sold separately; included for Dev and Tester roles). The Premiere Pro panel can be installed with a Pro License **or** with the Pack.

### VEGAS Pro plugin is part of the app
Install it from the setup wizard or **Dashboard → Account → Plugins**. It builds the plugin for your VEGAS version automatically. Uploading from VEGAS Pro needs a **Pro** plan.
The VEGAS panel got a new look that matches the other panels, scales with the window and has smooth animations.

### Image compression settings
**Dashboard → Settings:** switch compression on or off and choose the target file size. Presets can use different sizes per client.

### Terms of Service, EULA & Privacy Policy
Links to the Terms, the End User License Agreement, the Privacy Policy and the Refund Policy are in the Dashboard (*Support & legal* and the footer on every tab). New installs accept them once in the setup wizard; existing users see a short banner. You are asked again only if the texts change.

### Self-test & diagnostics
**Dashboard → Account → Diagnostics** checks everything the uploader needs (Node, helper, folders, Google sign-in, license, internet, plugins) and tells you in plain words what is wrong. *Create diagnostics file* packs logs and versions for support — emails, tokens and your user name are removed. Also in the tray menu.

### Plugin updates inside the app
The Dashboard (and tray) tell you when a newer After Effects, Premiere Pro, VEGAS or Photoshop plugin is available and can download it. Then click *Update* next to the plugin.

### Combined license roles
A license can now carry several roles at once (for example **Pro + SPT**), shown in the Dashboard and the panels.

---

## 🔧 Improved
- **Photoshop panel installer** now runs Adobe's installer as administrator and shows the real result. The minimum Photoshop version the panel asks for was lowered as well.
- **Premiere Pro panel** remembers the incoming folder, batch size and other settings even after you update the panel, and finds the incoming folder by itself after a fresh install.
- **Locked features stay locked** until the uploader knows your plan (2–3 files per upload, *Photoshop + Upload*, Properties).
- **Safer license checks.** Edited or expired local license data is ignored. An optional stronger signature check can be switched on later without updating the app.
- **Dashboard** footer shows the version; the Support card now lists your Terms and Privacy links.

## 🐞 Fixed
- The tray app sometimes refused to start ("already running") after a restart or crash, or left an invisible process behind.
- A wrong menu item could run when an update notice appeared in the tray menu.
- If the tray app failed to start without a window, nothing was shown — now you get a message.
- Photoshop panel: the Dashboard could say *"installed"* when Adobe's installer had failed, or *"not installed"* right after a successful install. The After Effects panel (same name) was sometimes mistaken for it.
- Premiere Pro panel: 2–3 files per upload and other Pro features could be used before the plan was known.
- Premiere templates were copied to a folder Premiere doesn't read — they are inserted directly now.
- VEGAS Pro panel: crash when changing the Leaderboard region, drop-down staying open, overlapping text on disabled buttons.
- Windows installer: could end an unrelated program with a reused process number (now only the uploader's own), didn't include the Premiere templates, and failed to compile on newer Inno Setup.
- Compiler messages for the VEGAS plugin and the shortcut program were unreadable on Polish Windows.

---

## 📦 Versions in this release

| Part | Version |
|---|---|
| Spidx Uploader (app + installer) | **2.8.0** |
| After Effects panel | **2.8.0** |
| Premiere Pro panel | **2.8.0** |
| Photoshop panel | **2.8.0** |
| VEGAS Pro plugin | **2.8.0** |

## ⬆️ How to update
1. Close After Effects, Premiere Pro, Photoshop and VEGAS Pro. Quit the Spidx tray app.
2. Install the new version (or replace the files) and start **Spidx Uploader**.
3. Open **Dashboard → Account → Plugins** and click **Update** next to each plugin (programs must be closed). Photoshop shows a Windows administrator prompt; restart Photoshop afterwards.
4. In the Dashboard, read and accept the Terms of Service / Privacy Policy banner.

## ℹ️ Good to know
- The first start builds the small shortcut program (a few seconds). It uses a compiler that ships with Windows.
- The shortcut works in programs that have the **new** Spidx panel — update all plugins.
- Switching presets from the panel works in After Effects and Premiere Pro; in Photoshop and VEGAS Pro use the Dashboard.
- Older VEGAS plugin versions are not covered by the Pro requirement — update the plugin.
