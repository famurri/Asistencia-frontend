@echo off
title Sistema de Asistencia - Modo Online Compartido
echo.
echo ========================================================
echo   INICIANDO ASISTENCIA EN LINEA (ENLACE PARA ALUMNOS)
echo ========================================================
echo.
if exist "C:\Program Files\nodejs" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)
echo 1. Iniciando servidor y base de datos...
start "" node.exe server.js
timeout /t 2 >nul
echo 2. Generando enlace publico en internet...
echo.
echo Copia el enlace 'url: https://...' que aparecera a continuacion
echo y compartelo con tus alumnos para que entren desde su celular:
echo.
call npx.cmd --yes localtunnel --port 3000
pause
