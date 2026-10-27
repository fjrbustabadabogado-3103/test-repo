import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { nuevoId } from '../../store.js';
import { sha256 } from '../../util.js';

/** Tipos admitidos, identificados por su firma binaria y no por lo que diga el navegador. */
const TIPOS = [
  { mime: 'application/pdf', ext: 'pdf', es: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', ext: 'jpg', es: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', es: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/heic', ext: 'heic', es: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'image/webp', ext: 'webp', es: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export function detectarTipo(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return TIPOS.find((t) => t.es(buffer)) ?? null;
}

export const TIPOS_ADMITIDOS = TIPOS.map((t) => t.mime);

/** Nombre de archivo seguro para mostrar y descargar (sin rutas ni caracteres de control). */
export function limpiarNombre(nombre, ext) {
  const base = String(nombre ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, 120);
  const sinExt = base.replace(/\.[^.]{1,5}$/, '') || 'documento';
  return `${sinExt}.${ext}`;
}

/**
 * Almacén de documentos cifrados con AES-256-GCM. Cada archivo tiene su propio vector de inicialización
 * y etiqueta de autenticación, de modo que cualquier manipulación del fichero se detecta al descifrar.
 */
/** Clave AES-256 de ARCHIVOS_CLAVE; en desarrollo y pruebas, derivada de APP_SECRET. Cifra documentos y copias de seguridad. */
export function claveCifrado(config) {
  return Buffer.from(config.archivos.clave || '', 'base64').length === 32
    ? Buffer.from(config.archivos.clave, 'base64')
    : createHash('sha256').update(`archivos:${config.appSecret}`).digest();
}

export function crearAlmacen(config) {
  const clave = claveCifrado(config);
  const raiz = config.archivos.directorio;

  return {
    async guardar(expedienteId, contenido) {
      const iv = randomBytes(12);
      const cifrador = createCipheriv('aes-256-gcm', clave, iv);
      const cifrado = Buffer.concat([cifrador.update(contenido), cifrador.final()]);
      const ruta = join(expedienteId, `${nuevoId()}.bin`);
      const destino = join(raiz, ruta);
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, cifrado, { mode: 0o600 });
      return { ruta, iv: iv.toString('base64'), etiqueta: cifrador.getAuthTag().toString('base64'), sha256: sha256(contenido) };
    },

    async leer(archivo) {
      const cifrado = await readFile(join(raiz, archivo.ruta));
      const descifrador = createDecipheriv('aes-256-gcm', clave, Buffer.from(archivo.iv, 'base64'));
      descifrador.setAuthTag(Buffer.from(archivo.etiqueta, 'base64'));
      return Buffer.concat([descifrador.update(cifrado), descifrador.final()]);
    },

    async borrar(archivo) {
      await rm(join(raiz, archivo.ruta), { force: true });
    },
  };
}
