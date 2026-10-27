// Restaura una copia de seguridad cifrada de la base de datos.
//   node scripts/restaurar-copia.mjs --listar
//   node scripts/restaurar-copia.mjs <copia.sqlite.gz.cifrado> <destino.sqlite> [--forzar]
// Necesita la misma ARCHIVOS_CLAVE con la que se hizo la copia. Detenga la aplicación antes de sustituir la base de datos en uso.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { descifrarCopia, listarCopias } from '../src/copias.js';

const config = loadConfig();
const args = process.argv.slice(2);

if (args[0] === '--listar') {
  const copias = listarCopias(config);
  console.log(copias.length ? copias.map((c) => join(config.copias.directorio, c)).join('\n') : `No hay copias en ${config.copias.directorio}`);
  process.exit(0);
}

const [origen, destino] = args.filter((a) => !a.startsWith('--'));
if (!origen || !destino) {
  console.error('Uso: node scripts/restaurar-copia.mjs <copia.sqlite.gz.cifrado> <destino.sqlite> [--forzar]');
  process.exit(2);
}
if (existsSync(destino) && !args.includes('--forzar')) {
  console.error(`${destino} ya existe. Añada --forzar para sustituirlo (detenga antes la aplicación).`);
  process.exit(2);
}

let bytes;
try {
  bytes = descifrarCopia(readFileSync(origen), config);
} catch (error) {
  console.error(`No se pudo descifrar la copia: ${error.message.includes('authenticate') ? 'la clave no es la correcta o el archivo está dañado.' : error.message}`);
  process.exit(1);
}
// Los diarios -wal/-shm de la base de datos sustituida se aplicarían sobre la restaurada y la dañarían.
for (const sufijo of ['-wal', '-shm', '-journal']) rmSync(destino + sufijo, { force: true });
writeFileSync(destino, bytes, { mode: 0o600 });

const db = new DatabaseSync(destino, { readOnly: true });
const integridad = db.prepare('PRAGMA integrity_check').get();
const cuenta = (tabla) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n;
console.log(`Restaurada en ${destino} · integridad: ${Object.values(integridad)[0]}`);
console.log(`Leads: ${cuenta('leads')} · encargos: ${cuenta('encargos')} · expedientes: ${cuenta('expedientes')} · plazos: ${cuenta('plazos')}`);
db.close();
