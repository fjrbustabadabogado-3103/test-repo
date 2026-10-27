import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crearEntorno, LEAD_VERDE } from './helpers.js';
import { crearCopia, descifrarCopia, listarCopias } from '../src/copias.js';
import { loadConfig, problemasProduccion, avisosProduccion } from '../src/config.js';

const CLAVE = Buffer.alloc(32, 7).toString('base64');

function entornoConCopias() {
  const directorio = mkdtempSync(join(tmpdir(), 'lso-copias-'));
  const e = crearEntorno({ env: { ARCHIVOS_CLAVE: CLAVE }, config: { copias: { activadas: true, directorio, hora: '03:00', retencionDias: 30 } } });
  return { ...e, directorio };
}

test('la copia de seguridad es una base de datos completa, cifrada y que detecta manipulaciones', async () => {
  const e = entornoConCopias();
  await e.app.inject({ method: 'POST', url: '/api/leads', payload: LEAD_VERDE });
  const { archivo } = crearCopia(e.ctx);
  const contenido = readFileSync(join(e.directorio, archivo));
  assert.ok(!contenido.includes(Buffer.from('María')), 'los datos personales no aparecen en claro');

  const restaurada = join(e.directorio, 'restaurada.sqlite');
  writeFileSync(restaurada, descifrarCopia(contenido, e.config));
  const db = new DatabaseSync(restaurada, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('SELECT nombre FROM leads').get().nombre, LEAD_VERDE.nombre);
  db.close();

  const alterado = Buffer.from(contenido);
  alterado[alterado.length - 1] ^= 1;
  assert.throws(() => descifrarCopia(alterado, e.config));
  const otraClave = loadConfig({ NODE_ENV: 'test', ARCHIVOS_CLAVE: Buffer.alloc(32, 9).toString('base64') });
  assert.throws(() => descifrarCopia(contenido, otraClave));
  await e.app.close();
});

test('las copias más antiguas que la retención se eliminan', async () => {
  const e = entornoConCopias();
  const primera = crearCopia(e.ctx).archivo;
  e.avanzar(60 * 24 * 20);
  crearCopia(e.ctx);
  e.avanzar(60 * 24 * 11);
  const { eliminadas } = crearCopia(e.ctx);
  assert.equal(eliminadas, 1);
  assert.ok(!listarCopias(e.config).includes(primera));
  assert.equal(listarCopias(e.config).length, 2);
  assert.ok(!readdirSync(e.directorio).some((n) => n.startsWith('.temporal')), 'no quedan temporales sin cifrar');
  await e.app.close();
});

test('la copia diaria se programa a la hora configurada y la serie sigue aunque falle', async () => {
  const e = entornoConCopias();
  e.ctx.worker.asegurarDiarias();
  await e.procesar();
  assert.equal(listarCopias(e.config).length, 1);
  const siguiente = e.store.db.prepare("SELECT vence FROM tareas WHERE tipo = 'copia_seguridad' AND estado = 'pendiente'").all();
  assert.equal(siguiente.length, 1);
  assert.equal(siguiente[0].vence, '2026-10-27T02:00:00.000Z', '03:00 en Madrid (horario de invierno)');

  // Directorio inutilizable: la tarea falla, se reintenta y la serie diaria se mantiene.
  e.ctx.config.copias.directorio = join(e.directorio, 'no-es-carpeta');
  writeFileSync(e.ctx.config.copias.directorio, 'x');
  e.fijar('2026-10-27T02:00:00Z');
  await e.procesar();
  const pendientes = e.store.db.prepare("SELECT intentos FROM tareas WHERE tipo = 'copia_seguridad' AND estado = 'pendiente' ORDER BY vence").all();
  assert.deepEqual(pendientes.map((t) => t.intentos), [1, 0], 'un reintento y la copia del día siguiente');
  await e.app.close();
});

test('una tarea diaria que agota sus reintentos se vuelve a programar', async () => {
  const e = crearEntorno();
  e.ctx.worker.asegurarDiarias();
  e.store.db.prepare("UPDATE tareas SET estado = 'fallida' WHERE tipo = 'revisar_plazos'").run();
  assert.equal(e.store.hayTareaPendiente('revisar_plazos'), false);
  e.ctx.worker.asegurarDiarias();
  assert.equal(e.store.hayTareaPendiente('revisar_plazos'), true);
  assert.equal(e.store.hayTareaPendiente('copia_seguridad'), false, 'fuera de producción las copias son opcionales');
  await e.app.close();
});

test('producción exige un canal de mensajería y avisos al equipo', () => {
  const base = { NODE_ENV: 'production', ADMIN_TOKEN: 'a'.repeat(32), APP_SECRET: 'b'.repeat(32), BASE_URL: 'https://lso.example.es', PAGOS_PROVEEDOR: 'stripe', STRIPE_WEBHOOK_SECRET: 'whsec_x', ARCHIVOS_CLAVE: CLAVE };
  const sin = problemasProduccion(loadConfig(base));
  assert.ok(sin.some((p) => p.includes('canal de mensajería')));
  assert.ok(sin.some((p) => p.includes('EQUIPO_')));
  const con = problemasProduccion(loadConfig({ ...base, RESEND_API_KEY: 're_x', EQUIPO_EMAIL: 'equipo@example.es' }));
  assert.ok(!con.some((p) => p.includes('canal de mensajería') || p.includes('EQUIPO_')));
  const config = loadConfig({ ...base, RESEND_API_KEY: 're_x' });
  assert.equal(config.copias.activadas, true, 'las copias se activan solas en producción');
  assert.ok(avisosProduccion(config).some((a) => a.includes('WhatsApp')));
});

test('la IP de las evidencias solo se toma de X-Forwarded-For si llega desde el proxy de la red privada', async () => {
  const e = crearEntorno();
  e.app.get('/prueba-ip', async (req) => ({ ip: req.ip }));
  const ip = async (remoteAddress, xff) => (await e.app.inject({ url: '/prueba-ip', remoteAddress, headers: { 'x-forwarded-for': xff } })).json().ip;
  assert.equal(await ip('172.18.0.3', '203.0.113.9'), '203.0.113.9', 'a través del proxy HTTPS (red de Docker)');
  assert.equal(await ip('198.51.100.7', '203.0.113.9'), '198.51.100.7', 'desde internet, la cabecera falsificada se ignora');
  await e.app.close();
});
