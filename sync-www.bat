@echo off
robocopy css www\css /E /PURGE
robocopy js www\js /E /PURGE
robocopy pages www\pages /E /PURGE
copy /Y index.html www\index.html
echo Done syncing www