' Run this once to add a "Spidx Uploader" icon to your Desktop.
' Double-clicking that icon afterwards starts the app silently in the
' background (no console window) — same as running "Spidx Uploader.vbs"
' directly, just with a proper icon you can also pin to Start/Taskbar.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = rootDir & "\Spidx Uploader.vbs"
iconPath = rootDir & "\App\tray-icon.ico"
desktopDir = shell.SpecialFolders("Desktop")
shortcutPath = desktopDir & "\Spidx Uploader.lnk"

If Not fso.FileExists(launcherPath) Then
    MsgBox "Couldn't find 'Spidx Uploader.vbs' next to this file.", vbExclamation, "Spidx Uploader"
    WScript.Quit 1
End If

Set link = shell.CreateShortcut(shortcutPath)
link.TargetPath = launcherPath
link.WorkingDirectory = rootDir & "\App"
If fso.FileExists(iconPath) Then
    link.IconLocation = iconPath
End If
link.Description = "Spidx Uploader — starts in the background, no window"
link.Save

MsgBox "Done! A 'Spidx Uploader' icon was added to your Desktop." & vbCrLf & _
       "Use it from now on to start the app in the background.", _
       vbInformation, "Spidx Uploader"
