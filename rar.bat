@echo off
if %1.==. exit
"C:\Program Files\WinRAR\winrar.exe" u -r -x".venv\" %1
