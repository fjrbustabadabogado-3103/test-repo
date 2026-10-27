import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { entornoConArchivos, hastaListo, tareasEquipo, LEAD_VERDE, PDF } from './helpers.js';

const GOOGLE = 'https://g.page/r/ejemplo/review';
const configCierre = (cambios = {}) => {
  const base = loadConfig({ NODE_ENV: 'test' }).cierre;
  return { ...base, ...cambios, resenas: { ...base.resenas, urlGoogle: GOOGLE, ...(cambios.resenas ?? {}) } };
};

/** Expediente con la exoneración concedida en la fecha indicada. */
async function hastaExoneracion(e, { lead: datosLead, fecha = '2026-10-26' } = {}) {
  const { lead, expediente, base } = await hastaListo(e, datosLead ? { lead: datosLead } : {});
  await e.admin('POST', `${base}/listo`, { listo: true });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'presentacion_solicitud', fecha: '2026-10-20' });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'presentacion_exoneracion', fecha: '2026-10-22' });
  const r = await e.admin('POST', `${base}/actuaciones`, { tipo: 'auto_exoneracion_concedida', fecha });
  assert.equal(r.statusCode, 200, r.body);
  await e.procesar();
  return { lead: e.store.lead(lead.id), expediente, base, cierre: e.store.cierre(expediente.id) };
}

const enviados = (e, leadId, plantilla) => e.store.salida(leadId).filter((s) => s.plantilla === plantilla);

test('exoneración concedida: valoración a los 2 días y recordatorios de reseña dentro de los 30 días (art. 20.4 TRLGDCU)', async () => {
  const e = entornoConArchivos({ config: { cierre: configCierre() } });
  // Cliente que no aceptó comunicaciones comerciales: se le escribe por la relación contractual (art. 21.2 LSSI)
  const { lead, cierre } = await hastaExoneracion(e, { lead: { ...LEAD_VERDE, acepta_comunicaciones: false } });
  assert.equal(cierre.motivo, 'exoneracion_concedida');
  assert.equal(cierre.servicio_completado, '2026-10-26');
  const programadas = e.store.tareasPendientes(lead.id).filter((t) => t.tipo === 'cierre_mensaje').map((t) => [t.datos.plantilla, t.vence]);
  assert.deepEqual(programadas, [
    ['valoracion_solicitud', '2026-10-28T09:00:00.000Z'],
    ['resena_recordatorio', '2026-11-05T09:00:00.000Z'],
    ['resena_recordatorio', '2026-11-15T09:00:00.000Z'],
  ]);

  e.fijar('2026-10-28T09:01:00Z');
  await e.procesar();
  const [valoracion] = enviados(e, lead.id, 'valoracion_solicitud');
  assert.ok(valoracion, 'se envía aunque no aceptara comunicaciones: es cliente (art. 21.2 LSSI)');
  assert.match(valoracion.contenido, /\/valoracion\//);
  assert.match(valoracion.contenido, /BAJA/);

  // Abre el enlace de reseña: se registra y no se le vuelve a recordar
  const clic = await e.app.inject({ url: `/resena/${cierre.token}` });
  assert.equal(clic.statusCode, 302);
  assert.equal(clic.headers.location, GOOGLE);
  e.fijar('2026-11-15T09:01:00Z');
  await e.procesar();
  assert.equal(enviados(e, lead.id, 'resena_recordatorio').length, 0);
  assert.ok(e.store.cierre(cierre.expediente_id).resena_clic);
  await e.app.close();
});

test('recordatorios: fuera de los 30 días no se envían y la baja se respeta', async () => {
  const e = entornoConArchivos({ config: { cierre: configCierre({ resenas: { recordatoriosDias: [10, 35] } }) } });
  const { lead, cierre } = await hastaExoneracion(e);
  assert.equal(e.store.tareasPendientes(lead.id).filter((t) => t.datos.plantilla === 'resena_recordatorio').length, 1, 'el de 35 días no se programa');
  e.store.programar('cierre_mensaje', e.reloj(), { expedienteId: cierre.expediente_id, plantilla: 'resena_recordatorio' }, lead.id);
  e.fijar('2026-11-27T09:00:00Z');
  await e.procesar();
  assert.equal(enviados(e, lead.id, 'resena_recordatorio').length, 0, 'pasados 30 días no se pide reseña');

  const e2 = entornoConArchivos({ config: { cierre: configCierre() } });
  const { lead: lead2 } = await hastaExoneracion(e2);
  e2.store.actualizarLead(lead2.id, { baja: true });
  e2.fijar('2026-10-28T09:01:00Z');
  await e2.procesar();
  assert.equal(enviados(e2, lead2.id, 'valoracion_solicitud').length, 0);
  await Promise.all([e.app.close(), e2.app.close()]);
});

test('valoración: sin filtrar por la nota, alerta si es baja, testimonio con autorización separada y revocable', async () => {
  const e = entornoConArchivos({ config: { cierre: configCierre() } });
  const { cierre } = await hastaExoneracion(e);
  const url = `/api/valoracion/${cierre.token}`;
  assert.equal((await e.app.inject({ url: `/valoracion/${cierre.token}` })).statusCode, 200);
  assert.equal((await e.app.inject({ url: '/valoracion/no-existe' })).statusCode, 404);
  assert.match((await e.app.inject({ url })).json().consentimiento, /art\. 20\.2\.e/);

  assert.equal((await e.app.inject({ method: 'POST', url, payload: { nps: 11 } })).statusCode, 400);
  assert.equal((await e.app.inject({ method: 'POST', url, payload: { nps: 5, testimonio: { autoriza: true, texto: 'corto', firma: 'iniciales' } } })).statusCode, 400);
  const valorada = await e.app.inject({
    method: 'POST', url, headers: { 'user-agent': 'Prueba/1.0' },
    payload: { nps: 5, comentario: 'Tardaron en contestar.', testimonio: { autoriza: true, texto: 'Me explicaron todo con claridad y me quitaron un peso de encima.', firma: 'iniciales' } },
  });
  assert.equal(valorada.statusCode, 200, valorada.body);
  assert.equal(valorada.json().resena, `https://despacho.test/resena/${cierre.token}`, 'se ofrece la reseña también con nota baja (sin filtrar a los satisfechos)');
  assert.match(valorada.json().referido, /\?ref=/);
  assert.equal(tareasEquipo(e, 'poco satisfecho (5/10)').length, 1);
  assert.equal((await e.app.inject({ method: 'POST', url, payload: { nps: 9 } })).statusCode, 409);

  const guardado = e.store.cierre(cierre.expediente_id);
  assert.equal(guardado.testimonio.autorizado, true);
  assert.equal(guardado.testimonio.userAgent, 'Prueba/1.0');
  assert.match(guardado.testimonio.consentimiento, /art\. 7\.3 RGPD/);
  let panel = (await e.admin('GET', '/cierre')).json();
  assert.equal(panel.testimonios.length, 1);
  assert.equal(panel.testimonios[0].firma, 'M. L. F.');

  const revocado = await e.app.inject({ method: 'POST', url: `${url}/revocar` });
  assert.equal(revocado.json().testimonio.autorizado, false);
  assert.equal(tareasEquipo(e, 'Testimonio revocado').length, 1);
  panel = (await e.admin('GET', '/cierre')).json();
  assert.equal(panel.testimonios.length, 0);
  assert.equal(panel.metricas.nps, -100);
  await e.app.close();
});

test('recomendaciones: el enlace del cliente atribuye los nuevos leads sin avisar a quien recomendó', async () => {
  const e = entornoConArchivos({ config: { cierre: configCierre() } });
  const { lead, cierre } = await hastaExoneracion(e);
  const mensajesAntes = e.store.salida(lead.id).length;
  const nuevo = await e.app.inject({
    method: 'POST', url: '/api/leads',
    payload: { ...LEAD_VERDE, nombre: 'Pedro Gil Sanz', telefono: '622333444', email: 'pedro@example.com', atribucion: { ref: cierre.codigo_referido } },
  });
  assert.equal(nuevo.statusCode, 201);
  await e.procesar();
  const m = (await e.admin('GET', '/cierre')).json().metricas;
  assert.equal(m.leadsReferidos, 1);
  assert.equal(m.clientesReferidos, 0);
  assert.equal(e.store.salida(lead.id).length, mensajesAntes, 'secreto profesional: no se comunica nada a quien recomendó');
  assert.equal((await e.admin('GET', `/expedientes/${cierre.expediente_id}/cierre`)).json().cierre.referidos, 1);
  await e.app.close();
});

test('archivo, plazo de conservación (art. 1964.2 CC) y eliminación de documentos', async () => {
  const e = entornoConArchivos({ config: { cierre: configCierre() } });
  const { lead, expediente, base } = await hastaListo(e);
  assert.equal((await e.admin('POST', `${base}/archivar`, {})).statusCode, 400, 'sin resolución no se archiva');
  await e.admin('POST', `${base}/listo`, { listo: true });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'presentacion_solicitud', fecha: '2026-10-20' });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'notificacion', fecha: '2026-10-26', plazo: { titulo: 'Aportar documento', cantidad: 5, unidad: 'habiles' } });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'auto_exoneracion_concedida', fecha: '2026-10-26' });
  assert.equal((await e.admin('POST', `${base}/archivar`, {})).statusCode, 400, 'con plazos propios pendientes no se archiva');
  const libre = e.store.plazosDeProcedimiento(e.store.procedimientoDeExpediente(expediente.id).id).find((p) => p.clave === 'libre');
  await e.admin('POST', `/plazos/${libre.id}`, { estado: 'cumplido' });

  const archivado = await e.admin('POST', `${base}/archivar`, {});
  assert.equal(archivado.statusCode, 200, archivado.body);
  assert.equal(archivado.json().cierre.conservar_hasta, '2031-10-26');
  assert.equal(e.store.expediente(expediente.id).estado, 'cerrado');
  assert.equal(e.store.procedimientoDeExpediente(expediente.id).estado, 'archivado');
  const dni = e.store.documentosDeExpediente(expediente.id).find((d) => d.clave === 'dni');
  const subida = await e.app.inject({ method: 'PUT', url: `/api/expedientes/${expediente.token}/documentos/${dni.id}`, payload: PDF, headers: { 'content-type': 'application/pdf' } });
  assert.equal(subida.statusCode, 400, 'el portal queda cerrado');
  assert.equal((await e.admin('POST', `${base}/eliminar-documentos`, {})).statusCode, 400, 'antes del plazo no se eliminan');

  const archivo = e.store.archivosDeDocumento(dni.id)[0];
  const ruta = join(e.directorio, archivo.ruta);
  assert.ok(existsSync(ruta));
  e.fijar('2031-10-26T08:30:00Z');
  await e.procesar();
  assert.equal(tareasEquipo(e, 'Fin del plazo de conservación').length, 1);
  const eliminados = await e.admin('POST', `${base}/eliminar-documentos`, {});
  assert.equal(eliminados.statusCode, 200, eliminados.body);
  assert.ok(eliminados.json().eliminados > 0);
  assert.ok(!existsSync(ruta), 'el fichero cifrado se borra del disco');
  assert.ok(e.store.eventos(lead.id).some((ev) => ev.tipo === 'documentos_eliminados'));
  await e.app.close();
});

test('desistimiento y exoneración denegada también cierran el expediente', async () => {
  const e = entornoConArchivos({ config: { cierre: configCierre() } });
  const { lead, expediente } = await hastaListo(e);
  const encargo = e.store.encargo(expediente.encargo_id);
  assert.equal((await e.app.inject({ method: 'POST', url: `/api/encargos/${encargo.token}/desistir`, payload: { confirmo: true } })).statusCode, 200);
  const cierre = e.store.cierre(expediente.id);
  assert.equal(cierre.motivo, 'desistimiento');
  assert.equal(cierre.conservar_hasta, '2031-10-26');
  assert.ok(!e.store.tareasPendientes(lead.id).some((t) => t.tipo === 'cierre_mensaje'), 'no se pide valoración a quien desiste');

  const e2 = entornoConArchivos({ config: { cierre: configCierre() } });
  const { lead: lead2, base } = await hastaListo(e2);
  await e2.admin('POST', `${base}/listo`, { listo: true });
  await e2.admin('POST', `${base}/actuaciones`, { tipo: 'presentacion_solicitud', fecha: '2026-10-20' });
  await e2.admin('POST', `${base}/actuaciones`, { tipo: 'auto_exoneracion_denegada', fecha: '2026-10-26' });
  const denegado = e2.store.cierre(e2.store.expedienteDeLead(lead2.id).id);
  assert.equal(denegado.motivo, 'exoneracion_denegada');
  assert.ok(!e2.store.tareasPendientes(lead2.id).some((t) => t.tipo === 'cierre_mensaje'));
  assert.equal(tareasEquipo(e2, 'DENEGADA').length, 1);
  await Promise.all([e.app.close(), e2.app.close()]);
});
