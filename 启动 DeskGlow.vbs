Option Explicit
' DeskGlow 静默启动器：双击运行，不出现任何黑色控制台窗口
Dim sh, fso, root, exe

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "还没有安装运行环境。" & vbCrLf & vbCrLf & "请先双击运行「安装依赖.bat」。", 48, "DeskGlow"
  WScript.Quit 1
End If

sh.CurrentDirectory = root
sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
sh.Run """" & exe & """ launch.js", 0, False
