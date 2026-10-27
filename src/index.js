import { loadConfig, problemasProduccion } from './config.js';
import { construirApp } from './server.js';

const config = loadConfig();
const problemas = problemasProduccion(config);
if (config.produccion && problemas.length) {
  console.error(`No se puede arrancar en producción:\n- ${problemas.join('\n- ')}`);
  process.exit(1);
}
if (!config.produccion && problemas.length) {
  console.warn(`Modo desarrollo. Pendiente antes de producción:\n- ${problemas.join('\n- ')}`);
}

const app = construirApp({ config });
app.ctx.worker.iniciar(config.intervaloWorkerMs);

const cerrar = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Servidor en ${config.baseUrl} · panel: ${config.baseUrl}/admin${config.produccion ? '' : ` (token de desarrollo: ${config.adminToken})`}`);
