' Spidx Uploader — silent launcher.
' Double-click this to start the helper + tray icon in the background,
' with no console window at all. Look for the Spidx icon near the clock.
'
' First time on a new machine, run App\start-tray.bat instead (once) so
' you can see the one-time setup/install steps and any errors.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = rootDir & "\App"
batPath = appDir & "\start-tray.bat"

If Not fso.FileExists(batPath) Then
    MsgBox "Couldn't find App\start-tray.bat next to this launcher." & vbCrLf & _
           "Make sure this file stays in the main Spidx Uploader folder.", _
           vbExclamation, "Spidx Uploader"
    WScript.Quit 1
End If

shell.CurrentDirectory = appDir
shell.Run """" & batPath & """", 0, False
