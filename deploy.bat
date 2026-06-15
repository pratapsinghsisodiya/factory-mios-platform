@echo off
echo ========================================
echo  FACTORY-MIOS — Deploy to Server
echo ========================================
echo.

echo [1/3] Pushing to GitHub...
git push origin main
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Push failed. Try setting your token:
    echo   git remote set-url origin https://YOUR_TOKEN@github.com/operatorsinghsisodiya/oee-dashboard.git
    pause
    exit /b 1
)
echo Push OK.
echo.

echo [2/3] Connecting to server and pulling...
ssh root@localhost "cd /opt/oee-dashboard-app && git stash && git pull origin main && pm2 restart oee-dashboard && pm2 logs oee-dashboard --lines 10 --nostream"
echo.

echo [3/3] Done! Dashboard: http://localhost:3000
echo.
pause
