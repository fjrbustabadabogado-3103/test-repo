#!/bin/sh
# Crea deploy/.env a partir de .env.ejemplo con claves aleatorias nuevas. No sobrescribe un .env existente.
set -eu
cd "$(dirname "$0")"
if [ -e .env ]; then
  echo "Ya existe deploy/.env: no se modifica (las claves actuales cifran los datos existentes)." >&2
  exit 1
fi
umask 077
sed \
  -e "s|^ADMIN_TOKEN=__GENERAR__|ADMIN_TOKEN=$(openssl rand -hex 24)|" \
  -e "s|^APP_SECRET=__GENERAR__|APP_SECRET=$(openssl rand -hex 32)|" \
  -e "s|^ARCHIVOS_CLAVE=__GENERAR__|ARCHIVOS_CLAVE=$(openssl rand -base64 32)|" \
  .env.ejemplo > .env
echo "Creado deploy/.env con claves nuevas. Guarde ADMIN_TOKEN y ARCHIVOS_CLAVE en un gestor de contraseñas"
echo "y complete DOMINIO, mensajería, avisos al equipo y Stripe. Después: docker compose run --rm app npm run comprobar"
