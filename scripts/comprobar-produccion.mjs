// Comprueba la configuración de producción sin arrancar la aplicación: npm run comprobar
// Lee las variables del entorno (o de un archivo: node --env-file=.env scripts/comprobar-produccion.mjs).
import { loadConfig, problemasProduccion, avisosProduccion } from '../src/config.js';

const config = loadConfig({ ...process.env, NODE_ENV: 'production' });
const problemas = problemasProduccion(config);
const avisos = avisosProduccion(config);

console.log(`Dirección pública: ${config.baseUrl}`);
console.log(`Base de datos: ${config.dbPath} · documentos: ${config.archivos.directorio} · copias: ${config.copias.directorio} (cada día a las ${config.copias.hora}, ${config.copias.retencionDias} días)`);
if (problemas.length) console.log(`\nImpiden arrancar (${problemas.length}):\n- ${problemas.join('\n- ')}`);
if (avisos.length) console.log(`\nConviene revisar (${avisos.length}):\n- ${avisos.join('\n- ')}`);
if (!problemas.length) console.log('\nLa configuración permite arrancar en producción.');
process.exit(problemas.length ? 1 : 0);
