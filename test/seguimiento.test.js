import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entornoConArchivos, hastaListo, tareasEquipo } from './helpers.js';
import { domingoDePascua, esInhabil, calcularPlazo, diasHabilesRestantes } from '../src/modules/seguimiento/calendario.js';

// ---------------- Cómputo (arts. 130, 133 y 135 LEC) ----------------

test('Pascua, fiestas nacionales y días inhábiles del art. 130.2 LEC', () => {
  assert.equal(domingoDePascua(2026), '2026-04-05');
  assert.equal(domingoDePascua(2027), '2027-03-28');
  assert.equal(esInhabil('2026-04-03'), true, 'Viernes Santo');
  assert.equal(esInhabil('2026-10-12'), true, 'Fiesta Nacional');
  assert.equal(esInhabil('2026-10-13'), false);
  assert.equal(esInhabil('2026-10-17'), true, 'sábado');
  assert.equal(esInhabil('2026-08-14'), true, 'agosto');
  assert.equal(esInhabil('2026-08-14', { urgente: true }), false, 'agosto hábil en actuaciones urgentes (art. 133.2)');
  assert.equal(esInhabil('2026-12-28'), true, 'entre el 24 de diciembre y el 6 de enero');
  assert.equal(esInhabil('2027-01-06'), true);
  assert.equal(esInhabil('2027-01-07'), false);
  assert.equal(esInhabil('2026-09-11', { autonomicos: { 2026: ['2026-09-11'] } }), true, 'festivo autonómico cargado');
  assert.equal(esInhabil('2026-11-09', { locales: ['2026-11-09'] }), true, 'festivo local');
});

test('plazos en días hábiles: agosto, festivos, Navidad y encadenados', () => {
  const r = calcularPlazo({ diesAQuo: '2026-07-28', cantidad: 15, unidad: 'habiles' });
  assert.equal(r.inicio, '2026-07-29', 'empieza el día siguiente (art. 133.1)');
  assert.equal(r.vence, '2026-09-16', 'agosto no cuenta');
  assert.equal(r.limitePresentacion, '2026-09-17', 'hasta las 15:00 del día hábil siguiente (art. 135.5)');
  assert.ok(r.avisos.some((a) => /festivos autonómicos/.test(a)));
  assert.ok(r.avisos.some((a) => /festivos locales/.test(a)));

  const conDiada = calcularPlazo({ diesAQuo: '2026-07-28', cantidad: 15, unidad: 'habiles', autonomicos: { 2026: ['2026-09-11'] }, locales: ['2026-09-24'] });
  assert.equal(conDiada.vence, '2026-09-17');
  assert.equal(conDiada.avisos.length, 0, 'con el calendario cargado no hay avisos');

  assert.equal(calcularPlazo({ diesAQuo: '2026-09-16', cantidad: 10, unidad: 'habiles' }).vence, '2026-09-30', 'encadenado: corre desde el día siguiente al vencimiento del anterior');
  assert.equal(calcularPlazo({ diesAQuo: '2026-12-18', cantidad: 5, unidad: 'habiles' }).vence, '2027-01-08', 'del 24 de diciembre al 6 de enero no cuenta');
  assert.equal(calcularPlazo({ diesAQuo: '2026-07-30', cantidad: 3, unidad: 'habiles', urgente: true }).vence, '2026-08-04');
});

test('plazos por meses y prórroga al siguiente hábil (art. 133.3 y 133.4 LEC)', () => {
  assert.equal(calcularPlazo({ diesAQuo: '2026-01-31', cantidad: 1, unidad: 'meses' }).vence, '2026-03-02', 'sin 31 de febrero: último del mes (sábado) → lunes');
  assert.equal(calcularPlazo({ diesAQuo: '2026-06-15', cantidad: 2, unidad: 'meses' }).vence, '2026-09-01', '15 de agosto es inhábil → 1 de septiembre');
  assert.throws(() => calcularPlazo({ diesAQuo: '15/06/2026', cantidad: 2, unidad: 'meses' }));
  assert.throws(() => calcularPlazo({ diesAQuo: '2026-06-15', cantidad: 0, unidad: 'habiles' }));
});

test('días hábiles restantes', () => {
  assert.equal(diasHabilesRestantes('2026-09-14', '2026-09-16', {}), 2);
  assert.equal(diasHabilesRestantes('2026-09-16', '2026-09-16', {}), 0);
  assert.equal(diasHabilesRestantes('2026-09-17', '2026-09-16', {}), -1);
  assert.equal(diasHabilesRestantes('2026-09-11', '2026-09-14', {}), 1, 'el fin de semana no cuenta');
});

// ---------------- Flujo del procedimiento ----------------

test('presentación, edicto del concurso sin masa, plazos encadenados, festivos locales y alertas', async () => {
  const e = entornoConArchivos();
  const { lead, expediente, base } = await hastaListo(e);
  const actuar = (cuerpo) => e.admin('POST', `${base}/actuaciones`, cuerpo);

  const prematura = await actuar({ tipo: 'presentacion_solicitud', fecha: '2026-10-26' });
  assert.equal(prematura.statusCode, 400, 'no se presenta si el expediente no está listo (módulo 5)');
  assert.equal((await e.admin('POST', `${base}/listo`, { listo: true })).statusCode, 200);
  assert.equal((await actuar({ tipo: 'presentacion_solicitud', fecha: '2026-12-01' })).statusCode, 400, 'fecha futura');
  assert.equal((await actuar({ tipo: 'inventado', fecha: '2026-10-26' })).statusCode, 400);

  const presentada = await actuar({ tipo: 'presentacion_solicitud', fecha: '2026-10-26' });
  assert.equal(presentada.statusCode, 200, presentada.body);
  let s = presentada.json();
  assert.equal(s.procedimiento.estado, 'presentado');
  assert.equal(s.procedimiento.organo, 'Sección de lo Mercantil del Tribunal de Instancia de Madrid');
  assert.equal(s.procedimiento.ccaa, 'Comunidad de Madrid');
  await e.procesar();
  assert.ok(e.store.salida(lead.id).some((m) => m.plantilla === 'novedad_procedimiento' && /presentado en el juzgado/.test(m.contenido)));

  s = (await actuar({ tipo: 'publicacion_edicto', fecha: '2026-10-26' })).json();
  const acreedores = s.plazos.find((p) => p.clave === 'plazo_acreedores_ac');
  const exoneracion = s.plazos.find((p) => p.clave === 'solicitud_exoneracion');
  assert.equal(acreedores.vence, '2026-11-16', '15 días hábiles (art. 37 ter.1 TRLC)');
  assert.equal(acreedores.parte, 'tercero');
  assert.equal(exoneracion.vence, '2026-11-30', '10 días hábiles desde el vencimiento anterior (art. 501.1 TRLC)');
  assert.equal(exoneracion.encadenado_a, acreedores.id);
  assert.ok(exoneracion.avisos_calendario.length > 0, 'sin calendario autonómico ni local: verificar');

  // Festivo local (9 de noviembre en Madrid capital): se recalculan ambos plazos
  assert.equal((await e.admin('PUT', `${base}/procedimiento`, { festivos_locales: '09/11/2026' })).statusCode, 400);
  s = (await e.admin('PUT', `${base}/procedimiento`, { festivos_locales: '2026-11-09, 2026-05-15', numero: 'CNA 1234/2026' })).json();
  assert.equal(s.plazos.find((p) => p.clave === 'plazo_acreedores_ac').vence, '2026-11-17');
  assert.equal(s.plazos.find((p) => p.clave === 'solicitud_exoneracion').vence, '2026-12-01');

  // Alerta a 5 días hábiles y paso del plazo de terceros
  e.fijar('2026-11-24T08:00:00Z');
  e.store.programar('revisar_plazos', e.reloj());
  await e.procesar();
  assert.equal(tareasEquipo(e, 'quedan 5 día').length, 1);
  assert.equal(tareasEquipo(e, 'Ha transcurrido el plazo de terceros').length, 1);
  e.store.programar('revisar_plazos', e.reloj());
  await e.procesar();
  assert.equal(tareasEquipo(e, 'quedan 5 día').length, 1, 'cada alerta se envía una vez');

  // Vencido sin presentar
  e.fijar('2026-12-02T08:00:00Z');
  e.store.programar('revisar_plazos', e.reloj());
  await e.procesar();
  const vencida = tareasEquipo(e, 'PLAZO VENCIDO');
  assert.equal(vencida.length, 1);
  assert.match(vencida[0], /hasta las 15:00 del 2026-12-02/);
  s = (await e.admin('GET', `${base}/seguimiento`)).json();
  assert.equal(s.plazos.find((p) => p.clave === 'solicitud_exoneracion').estado, 'vencido');

  // El cliente ve solo lo que se le comunica
  const portal = (await e.app.inject({ url: `/api/expedientes/${expediente.token}` })).json();
  assert.equal(portal.seguimiento.estado, 'Plazo para los acreedores; después pediremos la cancelación de sus deudas', 'el cliente ve estados sin tecnicismos');
  assert.deepEqual(portal.seguimiento.actuaciones.map((a) => a.titulo), ['Presentación de la solicitud de concurso', 'Publicación del edicto en el BOE (concurso sin masa)']);
  await e.app.close();
});

test('administrador concursal, informe, presentación de la exoneración, traslado y resolución', async () => {
  const e = entornoConArchivos();
  const { base } = await hastaListo(e);
  await e.admin('POST', `${base}/listo`, { listo: true });
  const actuar = async (cuerpo) => {
    const r = await e.admin('POST', `${base}/actuaciones`, cuerpo);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  await actuar({ tipo: 'presentacion_solicitud', fecha: '2026-10-20' });
  await actuar({ tipo: 'publicacion_edicto', fecha: '2026-10-21' });
  let s = await actuar({ tipo: 'solicitud_administrador', fecha: '2026-10-26' });
  assert.equal(s.procedimiento.estado, 'administracion_concursal');
  assert.equal(s.plazos.find((p) => p.clave === 'solicitud_exoneracion').estado, 'cancelado');

  s = await actuar({ tipo: 'informe_administrador', fecha: '2026-10-26' });
  const nuevo = s.plazos.find((p) => p.clave === 'solicitud_exoneracion' && p.estado === 'pendiente');
  assert.equal(nuevo.vence, '2026-11-09');

  s = await actuar({ tipo: 'presentacion_exoneracion', fecha: '2026-10-26' });
  assert.equal(s.plazos.find((p) => p.id === nuevo.id).estado, 'cumplido');
  assert.equal(s.procedimiento.estado, 'exoneracion_solicitada');

  s = await actuar({ tipo: 'traslado_exoneracion', fecha: '2026-10-26' });
  assert.equal(s.plazos.find((p) => p.clave === 'alegaciones_exoneracion').base, 'art. 501.4 TRLC');

  const sinTitulo = await e.admin('POST', `${base}/actuaciones`, { tipo: 'notificacion', fecha: '2026-10-26', plazo: { cantidad: 5, unidad: 'habiles' } });
  assert.equal(sinTitulo.statusCode, 400);
  s = await actuar({ tipo: 'notificacion', fecha: '2026-10-26', detalle: 'Diligencia de ordenación', plazo: { titulo: 'Aportar certificado actualizado', cantidad: 5, unidad: 'habiles', base: 'requerimiento del juzgado' } });
  const libre = s.plazos.find((p) => p.clave === 'libre');
  assert.equal(libre.vence, '2026-11-02');
  assert.equal((await e.admin('POST', `/plazos/${libre.id}`, { estado: 'cumplido' })).json().estado, 'cumplido');
  assert.equal((await e.admin('POST', `/plazos/${libre.id}`, { estado: 'pendiente' })).json().estado, 'pendiente');
  assert.equal((await e.admin('POST', `/plazos/${libre.id}`, { estado: 'raro' })).statusCode, 400);

  s = await actuar({ tipo: 'auto_exoneracion_concedida', fecha: '2026-10-26' });
  assert.equal(s.procedimiento.estado, 'exoneracion_concedida');
  assert.equal(tareasEquipo(e, 'EXONERACIÓN CONCEDIDA').length, 1);
  await e.app.close();
});

test('agenda de plazos y calendario .ics con clave', async () => {
  const e = entornoConArchivos();
  const { base } = await hastaListo(e);
  await e.admin('POST', `${base}/listo`, { listo: true });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'presentacion_solicitud', fecha: '2026-10-26' });
  await e.admin('POST', `${base}/actuaciones`, { tipo: 'publicacion_edicto', fecha: '2026-10-26' });

  const agenda = (await e.admin('GET', '/plazos')).json();
  assert.deepEqual(agenda.plazos.map((p) => p.clave), ['plazo_acreedores_ac', 'solicitud_exoneracion']);
  assert.equal(agenda.plazos[0].cliente, 'María López Fernández');
  assert.equal(agenda.plazos[0].restantes, 15);
  const url = new URL(agenda.calendario);
  const ics = await e.app.inject({ url: `${url.pathname}${url.search}` });
  assert.equal(ics.statusCode, 200);
  assert.match(ics.body, /DTSTART;VALUE=DATE:20261130/);
  assert.match(ics.body, /SUMMARY:VENCE: Presentar la solicitud de exoneración/);
  assert.match(ics.body, /TRIGGER:-P2D/);
  assert.equal((await e.app.inject({ url: '/calendario/plazos.ics?clave=mala' })).statusCode, 404);
  assert.equal((await e.app.inject({ url: '/admin/api/plazos' })).statusCode, 401);
  await e.app.close();
});
