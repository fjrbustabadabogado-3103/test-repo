import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { claveCifrado } from './modules/documentos/almacen.js';

const CABECERA = Buffer.from('LSOCOPIA1');
const PATRON = /^copia-(\d{8})-(\d{6})\.sqlite\.gz\.cifrado$/;

const sello = (fecha) => fecha.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Copia de seguridad de la base de datos: instantánea coherente con VACUUM INTO (válida aunque la aplicación
 * esté escribiendo), comprimida y cifrada con AES-256-GCM con la misma clave que los documentos.
 * Borra las copias más antiguas que la retención configurada.
 */
export function crearCopia(ctx) {
  const { directorio, retencionDias } = ctx.config.copias;
  mkdirSync(directorio, { recursive: true });
  const ahora = ctx.reloj();
  const temporal = join(directorio, `.temporal-${randomBytes(6).toString('hex')}.sqlite`);
  try {
    ctx.store.db.prepare('VACUUM INTO ?').run(temporal);
    const iv = randomBytes(12);
    const cifrador = createCipheriv('aes-256-gcm', claveCifrado(ctx.config), iv);
    const cifrado = Buffer.concat([cifrador.update(gzipSync(readFileSync(temporal))), cifrador.final()]);
    const archivo = `copia-${sello(ahora)}.sqlite.gz.cifrado`;
    writeFileSync(join(directorio, archivo), Buffer.concat([CABECERA, iv, cifrador.getAuthTag(), cifrado]), { mode: 0o600 });
    const limite = sello(new Date(ahora.getTime() - retencionDias * 86_400_000));
    const eliminadas = readdirSync(directorio).filter((n) => {
      const m = n.match(PATRON);
      return m && `${m[1]}-${m[2]}` < limite;
    });
    for (const n of eliminadas) rmSync(join(directorio, n));
    return { archivo, eliminadas: eliminadas.length };
  } finally {
    rmSync(temporal, { force: true });
  }
}

/** Devuelve los bytes de la base de datos SQLite contenida en una copia. Falla si el archivo se ha alterado o la clave no es la correcta. */
export function descifrarCopia(contenido, config) {
  if (!contenido.subarray(0, CABECERA.length).equals(CABECERA)) throw new Error('No es una copia de seguridad de esta aplicación.');
  const iv = contenido.subarray(CABECERA.length, CABECERA.length + 12);
  const etiqueta = contenido.subarray(CABECERA.length + 12, CABECERA.length + 28);
  const descifrador = createDecipheriv('aes-256-gcm', claveCifrado(config), iv);
  descifrador.setAuthTag(etiqueta);
  return gunzipSync(Buffer.concat([descifrador.update(contenido.subarray(CABECERA.length + 28)), descifrador.final()]));
}

/** Copias existentes, de la más reciente a la más antigua. */
export function listarCopias(config) {
  try {
    return readdirSync(config.copias.directorio).filter((n) => PATRON.test(n)).sort().reverse();
  } catch {
    return [];
  }
}
