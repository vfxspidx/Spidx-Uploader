Spidx Uploader - global shortcut
================================
Press a shortcut while After Effects, Premiere Pro, Photoshop or VEGAS Pro is in front and the
current frame is sent, like clicking Upload in the Spidx panel there.
    Ctrl+Alt+U          Upload
    Ctrl+Alt+Shift+U    Photoshop + Upload (Camera Raw route, a Pro feature)
Change or turn it off in the Dashboard: Settings > Global shortcut. Free for everyone.

Requirements: the Spidx tray app is running and the Spidx panel is OPEN in that program
(Window > Extensions > Spidx Uploader). If it isn't, a balloon says so.

How it works: SpidxHotkey.cs is built into SpidxHotkey.exe by App\hotkey.js the first time it is
needed (csc.exe ships with Windows - no Visual Studio). It registers the system-wide shortcut, finds
out which program is in front and writes incoming\.capture-request.json; the panel in that program
answers in incoming\.capture-ack.json and does the upload. incoming\.hotkey-status.json says whether
the shortcut is active ("already used by another program" if another app owns the combination).

Manual build:  csc /target:winexe /out:SpidxHotkey.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll SpidxHotkey.cs
