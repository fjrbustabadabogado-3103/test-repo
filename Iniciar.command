#!/bin/bash
# Arranque con doble clic para Mac: instala lo necesario, inicia la herramienta y abre el navegador.
# Para detenerla, cierra esta ventana o pulsa Control + C.

cd "$(dirname "$0")" || exit 1
# Rutas habituales de Node.js en Mac (instalador oficial y Homebrew), por si la sesión no las incluye.
export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH}"

PUERTO="${PORT:-3000}"
URL="http://localhost:${PUERTO}"

pausa_y_salir() {
  echo ""
  read -r -p "Pulsa Enter para cerrar esta ventana." _
  exit 1
}

echo "=============================================="
echo "  Bustabad Abogados · Segunda Oportunidad"
echo "=============================================="
echo ""

# 1. Node.js 22.13 o superior
if ! command -v node >/dev/null 2>&1; then
  echo "No se ha encontrado Node.js en este Mac."
  echo "Abriendo la página de descarga: instala la versión «LTS» y vuelve a hacer doble clic en este archivo."
  open "https://nodejs.org/es/download"
  pausa_y_salir
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Tu versión de Node.js ($(node -v)) es antigua: hace falta la 22.13 o superior."
  echo "Abriendo la página de descarga: instala la versión «LTS» y vuelve a hacer doble clic en este archivo."
  open "https://nodejs.org/es/download"
  pausa_y_salir
fi

# 2. Si ya está en marcha, solo abre el navegador
if curl -fsS "${URL}/health" >/dev/null 2>&1; then
  echo "La herramienta ya estaba en marcha. Abriendo el navegador…"
  open "${URL}"
  open "${URL}/admin"
  exit 0
fi

# 3. Dependencias (solo la primera vez o si han cambiado)
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "Instalando lo necesario (solo la primera vez, puede tardar un minuto)…"
  if ! npm install --no-audit --no-fund; then
    echo ""
    echo "No se pudo completar la instalación. Comprueba tu conexión a internet y vuelve a intentarlo."
    pausa_y_salir
  fi
  touch node_modules
fi

# 4. Arranque
echo ""
echo "Iniciando la herramienta…"
PORT="${PUERTO}" BASE_URL="${URL}" node --disable-warning=ExperimentalWarning src/index.js &
SERVIDOR=$!
trap 'kill "${SERVIDOR}" 2>/dev/null; exit 0' INT TERM HUP EXIT

for _ in $(seq 1 60); do
  if curl -fsS "${URL}/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "${SERVIDOR}" 2>/dev/null; then
    echo ""
    echo "La herramienta no ha podido arrancar. Revisa los mensajes de arriba."
    pausa_y_salir
  fi
  sleep 0.5
done

echo ""
echo "----------------------------------------------"
echo "  Lista. Se abrirán dos pestañas:"
echo "  · Página de captación:  ${URL}"
echo "  · Panel del despacho:   ${URL}/admin   (token: dev-admin)"
echo ""
echo "  Es una versión de prueba: los WhatsApp, correos y pagos son simulados."
echo "  Los avisos «Pendiente antes de producción» de arriba son normales en esta versión."
echo "  Deja esta ventana abierta mientras la uses."
echo "  Para detenerla, cierra esta ventana o pulsa Control + C."
echo "----------------------------------------------"
open "${URL}"
open "${URL}/admin"

wait "${SERVIDOR}"
