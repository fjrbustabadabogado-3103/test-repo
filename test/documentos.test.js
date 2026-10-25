import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_VERDE, entornoConArchivos, hastaCliente } from './helpers.js';
import { condicionCumple } from '../src/modules/documentos/expedientes.js';
import { detectarTipo, limpiarNombre } from '../src/modules/documentos/almacen.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

const DATOS_SOLTERO = {
  domicilio: 'Calle Mayor 1, 2º B, 28013 Madrid', estado_civil: 'soltero', situacion_laboral: 'asalariado', personas_a_cargo: '0',
  tiene_inmuebles: 'no', tiene_vehiculos: 'no', procedimientos_judiciales: 'no',
};

function subir(e, tokenExp, documentoId, contenido, nombre = 'documento.pdf', tipo = 'application/pdf') {
  return e.app.inject({
    method: 'PUT', url: `/api/expedientes/${tokenExp}/documentos/${documentoId}`, payload: contenido,
    headers: { 'content-type': tipo, 'x-nombre-archivo': encodeURIComponent(nombre) },
  });
}

test('condiciones de la lista de documentos', () => {
  const ctx = { respuestas: { ingresos_mensuales: 1500, vivienda_hipotecada: false, tipo_deudor: 'autonomo' }, datos: { estado_civil: 'casado' } };
  assert.equal(condicionCumple(undefined, ctx), true);
  assert.equal(condicionCumple({ 'respuestas.ingresos_mensuales': { '>': 0 } }, ctx), true);
  assert.equal(condicionCumple({ 'respuestas.vivienda_hipotecada': true }, ctx), false);
  assert.equal(condicionCumple({ 'respuestas.tipo_deudor': 'autonomo' }, ctx), true);
  assert.equal(condicionCumple({ 'datos.estado_civil': ['casado', 'pareja_inscrita'] }, ctx), true);
  assert.equal(condicionCumple({ 'datos.tiene_vehiculos': true }, ctx), false);
});

test('detección de formato por contenido y nombres seguros', () => {
  assert.equal(detectarTipo(PDF).mime, 'application/pdf');
  assert.equal(detectarTipo(JPG).mime, 'image/jpeg');
  assert.equal(detectarTipo(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(limpiarNombre('../../etc/passwd', 'pdf'), 'passwd.pdf');
  assert.equal(limpiarNombre('nómina "marzo".exe', 'pdf'), 'nómina marzo.pdf');
});

test('con inicio inmediato el expediente se abre al cobrar la entrada, con la lista adaptada al caso', async () => {
  const e = entornoConArchivos();
  const { lead } = await hastaCliente(e);
  const expediente = e.store.expedienteDeLead(lead.id);
  assert.ok(expediente);
  assert.equal(expediente.estado, 'recogida_documentos');
  const claves = e.store.documentosDeExpediente(expediente.id).map((d) => d.clave);
  for (const clave of ['dni', 'poder_procurador', 'empadronamiento', 'irpf', 'cirbe', 'certificado_aeat', 'certificado_tgss', 'deudas', 'ingresos']) {
    assert.ok(claves.includes(clave), `falta ${clave}`);
  }
  assert.ok(!claves.includes('hipoteca'), 'no tiene hipoteca');
  assert.ok(!claves.includes('autonomo'), 'no es autónomo');
  const mensaje = e.store.salida(lead.id).find((s) => s.plantilla === 'documentos_solicitud');
  assert.ok(mensaje?.contenido.includes(`/expediente/${expediente.token}`));
  await e.app.close();
});

test('sin inicio inmediato, los documentos se piden al terminar el plazo de desistimiento', async () => {
  const e = entornoConArchivos();
  const { lead } = await hastaCliente(e, { inicioInmediato: false });
  assert.equal(e.store.expedienteDeLead(lead.id), null);
  e.avanzar(60 * 24 * 14 + 1);
  await e.procesar();
  assert.ok(e.store.expedienteDeLead(lead.id));
  await e.app.close();
});

test('datos complementarios: validación y documentos que se añaden o dejan de aplicar', async () => {
  const e = entornoConArchivos();
  const { lead } = await hastaCliente(e);
  const exp = e.store.expedienteDeLead(lead.id);
  const guardar = (datos) => e.app.inject({ method: 'POST', url: `/api/expedientes/${exp.token}/datos`, payload: datos });

  assert.equal((await guardar({ ...DATOS_SOLTERO, domicilio: '' })).statusCode, 400);
  assert.equal((await guardar({ ...DATOS_SOLTERO, estado_civil: 'casado' })).statusCode, 400, 'falta el cónyuge (art. 7.1º TRLC)');
  const casado = await guardar({ ...DATOS_SOLTERO, estado_civil: 'casado', conyuge_nombre: 'Pedro Ruiz', regimen_economico: 'gananciales', tiene_vehiculos: 'si' });
  assert.equal(casado.statusCode, 200, casado.body);
  let claves = casado.json().documentos.map((d) => d.clave);
  assert.ok(claves.includes('matrimonio') && claves.includes('vehiculos'));

  const soltero = await guardar(DATOS_SOLTERO);
  claves = soltero.json().documentos.map((d) => d.clave);
  assert.ok(!claves.includes('matrimonio') && !claves.includes('vehiculos'), 'los que ya no aplican desaparecen');
  await e.app.close();
});

test('subida cifrada, validación de formato y tamaño, descarga íntegra y borrado', async () => {
  const e = entornoConArchivos({ documentos: { maxMbPorArchivo: 1 } });
  const { lead } = await hastaCliente(e);
  const exp = e.store.expedienteDeLead(lead.id);
  const dni = e.store.documentosDeExpediente(exp.id).find((d) => d.clave === 'dni');

  const ok = await subir(e, exp.token, dni.id, JPG, 'dni delante.jpeg', 'image/jpeg');
  assert.equal(ok.statusCode, 200, ok.body);
  const documento = ok.json().documentos.find((d) => d.clave === 'dni');
  assert.equal(documento.estado, 'subido');
  assert.equal(documento.archivos[0].nombre, 'dni delante.jpg');

  // En disco solo hay datos cifrados
  const carpeta = join(e.directorio, exp.id);
  const [fichero] = readdirSync(carpeta);
  const enDisco = readFileSync(join(carpeta, fichero));
  assert.ok(!enDisco.subarray(0, 4).equals(JPG.subarray(0, 4)), 'el archivo está cifrado');
  assert.equal(statSync(join(carpeta, fichero)).mode & 0o777, 0o600);

  // El panel lo descarga íntegro y deja constancia
  const descarga = await e.admin('GET', `/archivos/${documento.archivos[0].id}`);
  assert.equal(descarga.statusCode, 200);
  assert.ok(descarga.rawPayload.equals(JPG));
  assert.equal(descarga.headers['cache-control'], 'no-store');
  assert.ok(e.store.eventos(lead.id).some((ev) => ev.tipo === 'archivo_consultado'));
  assert.equal((await e.app.inject({ url: `/admin/api/archivos/${documento.archivos[0].id}` })).statusCode, 401);

  // Formatos falsos y tamaño excesivo
  const falso = await subir(e, exp.token, dni.id, Buffer.from('<script>alert(1)</script> aaaaaaaaaaaa'), 'virus.pdf');
  assert.equal(falso.statusCode, 400);
  const grande = await subir(e, exp.token, dni.id, Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10)]));
  assert.ok([400, 413].includes(grande.statusCode), `tamaño excesivo → ${grande.statusCode}`);
  const html = await e.app.inject({ method: 'PUT', url: `/api/expedientes/${exp.token}/documentos/${dni.id}`, payload: 'hola', headers: { 'content-type': 'text/html' } });
  assert.equal(html.statusCode, 415);

  // Quitar el archivo devuelve el documento a pendiente
  const borrado = await e.app.inject({ method: 'DELETE', url: `/api/expedientes/${exp.token}/archivos/${documento.archivos[0].id}` });
  assert.equal(borrado.statusCode, 200);
  assert.equal(borrado.json().documentos.find((d) => d.clave === 'dni').estado, 'pendiente');
  assert.equal(readdirSync(carpeta).length, 0, 'el fichero se borra del disco');
  await e.app.close();
});

test('revisión: todo aportado → revisión; corrección; todo validado → documentación completa', async () => {
  const e = entornoConArchivos();
  const { lead } = await hastaCliente(e);
  const exp = e.store.expedienteDeLead(lead.id);
  await e.app.inject({ method: 'POST', url: `/api/expedientes/${exp.token}/datos`, payload: DATOS_SOLTERO });
  const obligatorios = e.store.documentosDeExpediente(exp.id).filter((d) => d.obligatorio && d.estado !== 'no_aplica');
  for (const doc of obligatorios) assert.equal((await subir(e, exp.token, doc.id, PDF, `${doc.clave}.pdf`)).statusCode, 200);
  await e.procesar();
  assert.equal(e.store.expediente(exp.id).estado, 'en_revision');
  assert.ok(e.store.eventos(lead.id).some((ev) => ev.tipo === 'documentacion_aportada'));

  // El abogado pide corregir el certificado de Hacienda
  const aeat = obligatorios.find((d) => d.clave === 'certificado_aeat');
  assert.equal((await e.admin('POST', `/documentos/${aeat.id}/revision`, { decision: 'rechazar' })).statusCode, 400, 'el motivo es obligatorio');
  assert.equal((await e.admin('POST', `/documentos/${aeat.id}/revision`, { decision: 'rechazar', motivo: 'Está caducado: pida uno nuevo' })).statusCode, 200);
  await e.procesar();
  assert.equal(e.store.expediente(exp.id).estado, 'recogida_documentos');
  const aviso = e.store.salida(lead.id).find((s) => s.plantilla === 'documento_rechazado');
  assert.match(aviso.contenido, /Está caducado/);
  const portal = (await e.app.inject({ url: `/api/expedientes/${exp.token}` })).json();
  assert.equal(portal.documentos.find((d) => d.clave === 'certificado_aeat').motivoRechazo, 'Está caducado: pida uno nuevo');

  await subir(e, exp.token, aeat.id, PDF, 'aeat-nuevo.pdf');
  assert.equal(e.store.expediente(exp.id).estado, 'en_revision');

  for (const doc of obligatorios) {
    const r = await e.admin('POST', `/documentos/${doc.id}/revision`, { decision: 'validar' });
    assert.equal(r.statusCode, 200, r.body);
  }
  await e.procesar();
  const final = e.store.expediente(exp.id);
  assert.equal(final.estado, 'documentacion_completa');
  assert.ok(final.documentacion_completa);
  assert.ok(e.store.salida(lead.id).some((s) => s.plantilla === 'documentacion_completa'));
  assert.ok(!e.store.tareasPendientes(lead.id).some((t) => t.tipo === 'recordatorio_documentos'), 'se cancelan los recordatorios');
  const tarde = await subir(e, exp.token, obligatorios[0].id, PDF);
  assert.equal(tarde.statusCode, 400, 'el expediente completo ya no admite cambios');

  const ficha = (await e.admin('GET', `/leads/${lead.id}`)).json();
  assert.equal(ficha.expediente.estado, 'documentacion_completa');
  assert.equal(ficha.expediente.progreso.validados, ficha.expediente.progreso.obligatorios);
  await e.app.close();
});

test('recordatorios cada 3 días con el número de documentos pendientes y aviso al equipo al final', async () => {
  const e = entornoConArchivos({ documentos: { maxRecordatorios: 2 } });
  const { lead } = await hastaCliente(e);
  e.avanzar(60 * 24 * 3 + 1);
  await e.procesar();
  const primero = e.store.salida(lead.id).filter((s) => s.plantilla === 'documentos_recordatorio');
  assert.equal(primero.length, 1);
  assert.match(primero[0].contenido, /nos faltan \d+ documento/);
  e.avanzar(60 * 24 * 3 + 1);
  await e.procesar();
  assert.equal(e.store.salida(lead.id).filter((s) => s.plantilla === 'documentos_recordatorio').length, 2);
  assert.ok(!e.store.tareasPendientes(lead.id).some((t) => t.tipo === 'recordatorio_documentos'), 'no hay más recordatorios tras el máximo');
  await e.app.close();
});

test('el desistimiento cierra el expediente', async () => {
  const e = entornoConArchivos();
  const { lead, tokenEncargo } = await hastaCliente(e);
  const exp = e.store.expedienteDeLead(lead.id);
  assert.equal((await e.app.inject({ method: 'POST', url: `/api/encargos/${tokenEncargo}/desistir`, payload: { confirmo: true } })).statusCode, 200);
  assert.equal(e.store.expediente(exp.id).estado, 'cerrado');
  const dni = e.store.documentosDeExpediente(exp.id).find((d) => d.clave === 'dni');
  assert.equal((await subir(e, exp.token, dni.id, PDF)).statusCode, 400);
  await e.app.close();
});

test('portal: página y enlaces no válidos', async () => {
  const e = entornoConArchivos();
  const { lead } = await hastaCliente(e);
  const exp = e.store.expedienteDeLead(lead.id);
  const pagina = await e.app.inject({ url: `/expediente/${exp.token}` });
  assert.equal(pagina.statusCode, 200);
  assert.match(pagina.body, /Documentación de su expediente/);
  assert.equal((await e.app.inject({ url: '/expediente/no-existe' })).statusCode, 404);
  assert.equal((await e.app.inject({ url: '/api/expedientes/no-existe' })).statusCode, 404);
  const ajeno = await subir(e, exp.token, 'documento-de-otro', PDF);
  assert.equal(ajeno.statusCode, 404);
  assert.equal((await e.app.inject({ url: '/static/expediente.js' })).statusCode, 200);
  await e.app.close();
});
