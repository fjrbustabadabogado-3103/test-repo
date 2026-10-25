@echo off
rem Arranque con doble clic para Windows: instala lo necesario, inicia la herramienta y abre el navegador.
rem Para detenerla, cierra esta ventana o pulsa Control + C.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Bustabad Abogados - Segunda Oportunidad

if "%PORT%"=="" set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo ==============================================
echo   Bustabad Abogados - Segunda Oportunidad
echo ==============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto sin_node

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto node_antiguo

node scripts\abrir-navegador.mjs "%URL%" --comprobar
if not errorlevel 1 goto ya_en_marcha

if exist node_modules goto arrancar
echo Instalando lo necesario: solo la primera vez, puede tardar un minuto...
call npm install --no-audit --no-fund
if errorlevel 1 goto error_instalacion

:arrancar
echo.
echo Iniciando la herramienta...
set "BASE_URL=%URL%"
start "" /b node scripts\abrir-navegador.mjs "%URL%"
node --disable-warning=ExperimentalWarning src\index.js
echo.
echo La herramienta se ha detenido.
pause
exit /b 0

:ya_en_marcha
echo La herramienta ya estaba en marcha. Abriendo el navegador...
start "" "%URL%"
start "" "%URL%/admin"
exit /b 0

:sin_node
echo No se ha encontrado Node.js en este ordenador.
echo Se abrirá la página de descarga: instala la versión LTS y vuelve a hacer doble clic en este archivo.
start "" "https://nodejs.org/es/download"
pause
exit /b 1

:node_antiguo
echo Tu versión de Node.js es antigua: hace falta la 22.13 o superior.
echo Se abrirá la página de descarga: instala la versión LTS y vuelve a hacer doble clic en este archivo.
start "" "https://nodejs.org/es/download"
pause
exit /b 1

:error_instalacion
echo.
echo No se pudo completar la instalación. Comprueba tu conexión a internet y vuelve a intentarlo.
pause
exit /b 1
