@echo off
title Sistema de Control de Asistencia Universitaria
echo.
echo ========================================================
echo       SISTEMA DE CONTROL DE ASISTENCIA UNIVERSITARIA
echo ========================================================
echo.
REM Asegurar que la ruta de Node.js este en el PATH
if exist "C:\Program Files\nodejs" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)
if exist "%LOCALAPPDATA%\Programs\node" (
    set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
)
echo Verificando Node.js...
node.exe -v >nul 2>nul
if errorlevel 1 (
    echo [ERROR] No se pudo encontrar Node.js.
    echo Si lo acabas de instalar, por favor reinicia tu computadora.
    pause
    exit /b
)
echo Node.js detectado correctamente.
echo.
if not exist "node_modules" (
    echo Instalando librerias por primera vez, espere unos segundos...
    call npm.cmd install
)
echo Iniciando servidor y base de datos...
echo.
echo Abriendo navegador en: http://localhost:3000
echo (Para cerrar la aplicacion, simplemente cierra esta ventana)
echo ========================================================
echo.
start "" "http://localhost:3000"
node.exe server.js
pause
