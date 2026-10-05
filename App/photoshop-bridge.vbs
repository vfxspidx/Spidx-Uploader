' Spidx Uploader — Photoshop bridge launcher.
'
' Attaches to an ALREADY RUNNING Photoshop over COM and hands it the job
' .jsx script, passing the remaining command-line arguments straight
' through via DoJavaScriptFile. Deliberately does NOT start Photoshop:
' GetObject fails immediately if nothing is running, and that failure is
' reported back as clean JSON on stdout so server.js can fall back to
' uploading the raw frame instead of hanging.
'
' Usage: cscript //Nologo photoshop-bridge.vbs <job.jsx> <arg1> <arg2> ...
Option Explicit

Dim jsxPath, jsArgs, i

If WScript.Arguments.Count < 1 Then
    WScript.StdOut.WriteLine "{""ok"":false,""error"":""photoshop-bridge.vbs called with no job script.""}"
    WScript.Quit 1
End If

jsxPath = WScript.Arguments(0)

ReDim jsArgs(WScript.Arguments.Count - 2)
For i = 1 To WScript.Arguments.Count - 1
    jsArgs(i - 1) = WScript.Arguments(i)
Next

Dim appRef
On Error Resume Next
Set appRef = GetObject(, "Photoshop.Application")
If Err.Number <> 0 Or appRef Is Nothing Then
    WScript.StdOut.WriteLine "{""ok"":false,""error"":""Photoshop is not running.""}"
    WScript.Quit 1
End If
On Error Goto 0

Dim result
On Error Resume Next
result = appRef.DoJavaScriptFile(jsxPath, jsArgs)
If Err.Number <> 0 Then
    WScript.StdOut.WriteLine "{""ok"":false,""error"":""Photoshop bridge call failed: " & Replace(Err.Description, """", "'") & """}"
    WScript.Quit 1
End If
On Error Goto 0

WScript.StdOut.WriteLine result
