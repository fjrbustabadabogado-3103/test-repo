import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { construirApp } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Aplicación con base de datos en memoria, reloj controlable y proveedores simulados. */
export function crearEntorno({ inicio = '2026-10-26T07:00:00Z', env = {}, fetchImpl, config: cambios = {}, ia } = {}) {
  let ahora = new Date(inicio);
  const reloj = () => new Date(ahora);
  const config = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://despacho.test', ...env }, cambios);
  const store = new Store(':memory:', reloj);
  const app = construirApp({ config, store, reloj, log: false, ia, fetchImpl: fetchImpl ?? (async () => { throw new Error('red no disponible en tests'); }) });
  return {
    app,
    store,
    config,
    ctx: app.ctx,
    reloj,
    avanzar(minutos) {
      ahora = new Date(ahora.getTime() + minutos * 60_000);
    },
    fijar(iso) {
      ahora = new Date(iso);
    },
    async procesar() {
      return app.ctx.worker.procesar();
    },
    admin(metodo, url, payload) {
      return app.inject({ method: metodo, url: `/admin/api${url}`, headers: { authorization: `Bearer ${config.adminToken}` }, payload });
    },
  };
}

export const LEAD_VERDE = {
  nombre: 'María López Fernández',
  telefono: '600 111 222',
  email: 'maria@example.com',
  provincia: 'Madrid',
  tipo_deudor: 'particular',
  deuda_total: '45000',
  num_acreedores: '5',
  deuda_hacienda: '0',
  deuda_seguridad_social: '0',
  ingresos_mensuales: '1500',
  vivienda_hipotecada: 'no',
  deuda_alimentos: 'no',
  antecedentes: 'no',
  exoneracion_previa: 'no',
  acepta_privacidad: true,
  acepta_comunicaciones: true,
  atribucion: { utm_source: 'facebook', utm_campaign: 'lso-madrid' },
};

export function entornoConArchivos(opciones = {}) {
  const directorio = mkdtempSync(join(tmpdir(), 'lso-archivos-'));
  const documentos = { ...loadConfig({ NODE_ENV: 'test' }).documentos, ...(opciones.documentos ?? {}) };
  const e = crearEntorno({ config: { archivos: { directorio, clave: '' }, documentos, ...(opciones.config ?? {}) }, ia: opciones.ia });
  return { ...e, directorio };
}

/** Lleva un lead hasta cliente con la entrada pagada. */
export async function hastaCliente(e, { inicioInmediato = true, lead: datosLead = LEAD_VERDE } = {}) {
  await e.app.inject({ method: 'POST', url: '/api/leads', payload: datosLead });
  await e.procesar();
  const lead = e.store.listarLeads().find((l) => l.telefono === '34' + datosLead.telefono.replace(/\D/g, '').slice(-9));
  const { url } = (await e.admin('POST', `/leads/${lead.id}/propuesta`, { honorarios: 2400, entrada: 400, numCuotas: 4 })).json();
  const token = url.split('/').pop();
  await e.app.inject({ method: 'POST', url: `/api/encargos/${token}/codigo`, payload: {} });
  const codigo = e.store.salida(lead.id).filter((s) => s.plantilla === 'codigo_firma').at(-1).contenido.match(/\b(\d{6})\b/)[1];
  const encargo = e.store.encargoPorToken(token);
  const { urlPago } = (await e.app.inject({
    method: 'POST', url: `/api/encargos/${token}/firmar`,
    payload: { nombre: datosLead.nombre, dni: '12345678Z', aceptaHoja: true, aceptaPago: true, inicioInmediato, documentoSha256: encargo.documento_sha256, codigo },
  })).json();
  await e.app.inject({ url: new URL(urlPago).pathname });
  await e.procesar();
  return { lead: e.store.lead(lead.id), encargo: e.store.encargo(encargo.id), tokenEncargo: token };
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

export async function hastaListo(e, opciones = {}) {
  const { lead } = await hastaCliente(e, opciones);
  const exp = e.store.expedienteDeLead(lead.id);
  await e.app.inject({
    method: 'POST', url: `/api/expedientes/${exp.token}/datos`,
    payload: { domicilio: 'Calle Mayor 1, Madrid', estado_civil: 'soltero', situacion_laboral: 'asalariado', tiene_inmuebles: 'no', tiene_vehiculos: 'no', procedimientos_judiciales: 'no', causas: 'Despido.' },
  });
  for (const doc of e.store.documentosDeExpediente(exp.id).filter((d) => d.obligatorio && d.estado !== 'no_aplica')) {
    await e.app.inject({ method: 'PUT', url: `/api/expedientes/${exp.token}/documentos/${doc.id}`, payload: PDF, headers: { 'content-type': 'application/pdf' } });
    await e.admin('POST', `/documentos/${doc.id}/revision`, { decision: 'validar' });
  }
  const base = `/expedientes/${exp.id}`;
  const a = (await e.admin('POST', `${base}/acreedores`, { nombre: 'Banco', tipo: 'financiera', importe: 9000, domicilio: 'Calle Banco 1', vencimiento: '2025-01-10' })).json();
  await e.admin('PATCH', `/acreedores/${a.id}`, { revisado: true });
  await e.admin('PUT', `${base}/preparacion`, { historia: 'Historia.', ruta: 'sin_masa', procurador: 'Dña. Procuradora' });
  return { lead, expediente: exp, base };
}

/** Avisos al equipo programados cuyo texto contiene `texto`. */
export const tareasEquipo = (e, texto) => e.store.db.prepare("SELECT datos FROM tareas WHERE tipo = 'aviso_equipo'").all()
  .map((t) => JSON.parse(t.datos).extra?.evento ?? '').filter((ev) => ev.includes(texto));
