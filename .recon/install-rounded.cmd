@echo off
rem Install the rounded-window archive once the desktop app has closed.
"D:\deepseek-kernel-harness\python\kiln\runtime\.venv\Scripts\pythonw.exe" "D:\deepseek-kernel-harness\.recon\install-archive.py" "D:\Deepseek-Desktop\resources\app.asar" "D:\deepseek-kernel-harness\.recon\app.asar.rounded" "D:\deepseek-kernel-harness\.recon\install-backups" "D:\deepseek-kernel-harness\.recon\install-staging" --wait --receipt "D:\deepseek-kernel-harness\.recon\rounded-install.json"
