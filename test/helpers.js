import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { construirApp } from '../src/server.js';

/** Aplicación con base de datos en memoria, reloj controlable y proveedores simulados. */
export function crearEntorno({ inicio = '2026-10-26T07:00:00Z', env = {}, fetchImpl, config: cambios = {} } = {}) {
  let ahora = new Date(inicio);
  const reloj = () => new Date(ahora);
  const config = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://despacho.test', ...env }, cambios);
  const store = new Store(':memory:', reloj);
  const app = construirApp({ config, store, reloj, log: false, fetchImpl: fetchImpl ?? (async () => { throw new Error('red no disponible en tests'); }) });
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
