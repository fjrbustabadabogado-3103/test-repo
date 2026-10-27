import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  origen TEXT NOT NULL,
  etapa TEXT NOT NULL,
  semaforo TEXT NOT NULL,
  puntuacion INTEGER NOT NULL,
  motivos TEXT NOT NULL,
  nombre TEXT,
  telefono TEXT,
  email TEXT,
  provincia TEXT,
  respuestas TEXT NOT NULL,
  atribucion TEXT NOT NULL,
  token_reserva TEXT NOT NULL UNIQUE,
  consentimiento_rgpd INTEGER NOT NULL DEFAULT 0,
  consentimiento_comunicaciones INTEGER NOT NULL DEFAULT 0,
  baja INTEGER NOT NULL DEFAULT 0,
  motivo_cierre TEXT,
  primer_contacto TEXT,
  anonimizado INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS leads_telefono ON leads(telefono);
CREATE INDEX IF NOT EXISTS leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS leads_etapa ON leads(etapa);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,
  datos TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS eventos_lead ON eventos(lead_id);

CREATE TABLE IF NOT EXISTS citas (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  codigo TEXT NOT NULL UNIQUE,
  inicio TEXT NOT NULL,
  fin TEXT NOT NULL,
  estado TEXT NOT NULL,
  url_videollamada TEXT NOT NULL,
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS citas_inicio ON citas(inicio);

CREATE TABLE IF NOT EXISTS encargos (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  token TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL,
  honorarios_cent INTEGER NOT NULL,
  entrada_cent INTEGER NOT NULL,
  num_cuotas INTEGER NOT NULL,
  provision_procurador_cent INTEGER NOT NULL,
  documento_html TEXT NOT NULL,
  documento_sha256 TEXT NOT NULL,
  plan TEXT NOT NULL,
  caduca TEXT NOT NULL,
  creado TEXT NOT NULL,
  enviado TEXT,
  firmado TEXT,
  evidencia_firma TEXT,
  inicio_inmediato INTEGER,
  fecha_inicio_servicio TEXT,
  otp_hash TEXT,
  otp_caduca TEXT,
  otp_intentos INTEGER NOT NULL DEFAULT 0,
  otp_envios INTEGER NOT NULL DEFAULT 0,
  pago_cliente_ref TEXT,
  pago_metodo_ref TEXT,
  pago_metodo_tipo TEXT,
  desistido TEXT
);

CREATE TABLE IF NOT EXISTS pagos (
  id TEXT PRIMARY KEY,
  encargo_id TEXT NOT NULL REFERENCES encargos(id),
  tipo TEXT NOT NULL,
  numero INTEGER NOT NULL,
  importe_cent INTEGER NOT NULL,
  vencimiento TEXT NOT NULL,
  estado TEXT NOT NULL,
  proveedor TEXT,
  referencia TEXT,
  url_pago TEXT,
  pagado TEXT,
  intentos INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pagos_encargo ON pagos(encargo_id);

CREATE TABLE IF NOT EXISTS tareas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT,
  tipo TEXT NOT NULL,
  vence TEXT NOT NULL,
  estado TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0,
  datos TEXT NOT NULL,
  ultimo_error TEXT,
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tareas_pendientes ON tareas(estado, vence);

CREATE TABLE IF NOT EXISTS salida (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT,
  fecha TEXT NOT NULL,
  canal TEXT NOT NULL,
  proveedor TEXT NOT NULL,
  destino TEXT NOT NULL,
  plantilla TEXT NOT NULL,
  contenido TEXT NOT NULL,
  estado TEXT NOT NULL,
  respuesta TEXT
);

CREATE TABLE IF NOT EXISTS gasto_publicidad (
  mes TEXT NOT NULL,
  origen TEXT NOT NULL,
  importe_cent INTEGER NOT NULL,
  PRIMARY KEY (mes, origen)
);
`;

export const ETAPAS = [
  'nuevo', 'contactado', 'cualificado', 'agendado', 'asistio', 'no_asistio',
  'propuesta', 'firmado', 'cliente', 'perdido', 'descartado', 'desistido',
];

const JSON_LEAD = ['motivos', 'respuestas', 'atribucion'];

export const nuevoId = () => randomUUID();
export const nuevoToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

function filaLead(fila) {
  if (!fila) return null;
  const lead = { ...fila };
  for (const campo of JSON_LEAD) lead[campo] = JSON.parse(lead[campo]);
  for (const campo of ['consentimiento_rgpd', 'consentimiento_comunicaciones', 'baja', 'anonimizado']) lead[campo] = Boolean(lead[campo]);
  return lead;
}

function filaJson(fila, campos) {
  if (!fila) return null;
  const copia = { ...fila };
  for (const campo of campos) if (copia[campo] != null) copia[campo] = JSON.parse(copia[campo]);
  return copia;
}

export class Store {
  constructor(path, reloj = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.reloj = reloj;
  }

  ahora() {
    return this.reloj().toISOString();
  }

  transaccion(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const resultado = fn();
      this.db.exec('COMMIT');
      return resultado;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- Leads ----------

  crearLead(datos) {
    const ahora = this.ahora();
    const lead = {
      id: nuevoId(),
      creado: ahora,
      actualizado: ahora,
      etapa: 'nuevo',
      token_reserva: nuevoToken(),
      ...datos,
    };
    this.db.prepare(`INSERT INTO leads (id, creado, actualizado, origen, etapa, semaforo, puntuacion, motivos, nombre, telefono, email,
      provincia, respuestas, atribucion, token_reserva, consentimiento_rgpd, consentimiento_comunicaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      lead.id, lead.creado, lead.actualizado, lead.origen, lead.etapa, lead.semaforo, lead.puntuacion,
      JSON.stringify(lead.motivos), lead.nombre ?? null, lead.telefono ?? null, lead.email ?? null, lead.provincia ?? null,
      JSON.stringify(lead.respuestas), JSON.stringify(lead.atribucion), lead.token_reserva,
      lead.consentimiento_rgpd ? 1 : 0, lead.consentimiento_comunicaciones ? 1 : 0,
    );
    return this.lead(lead.id);
  }

  lead(id) {
    return filaLead(this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id));
  }

  leadPorTokenReserva(token) {
    return filaLead(this.db.prepare('SELECT * FROM leads WHERE token_reserva = ?').get(token));
  }

  leadPorTelefono(telefono) {
    return filaLead(this.db.prepare('SELECT * FROM leads WHERE telefono = ? ORDER BY creado DESC LIMIT 1').get(telefono));
  }

  /** Lead abierto con el mismo teléfono o email creado desde `desde` (para no duplicar contactos). */
  leadDuplicado({ telefono, email }, desde) {
    if (!telefono && !email) return null;
    const fila = this.db.prepare(`SELECT * FROM leads WHERE creado >= ? AND anonimizado = 0
      AND etapa NOT IN ('perdido', 'descartado', 'desistido')
      AND ((telefono IS NOT NULL AND telefono = ?) OR (email IS NOT NULL AND email = ?))
      ORDER BY creado DESC LIMIT 1`).get(desde, telefono ?? '', email ?? '');
    return filaLead(fila);
  }

  actualizarLead(id, cambios) {
    const columnas = Object.keys(cambios);
    if (columnas.length === 0) return this.lead(id);
    const valores = columnas.map((c) => {
      const v = cambios[c];
      if (JSON_LEAD.includes(c)) return JSON.stringify(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v ?? null;
    });
    const sets = columnas.map((c) => `${c} = ?`).join(', ');
    this.db.prepare(`UPDATE leads SET ${sets}, actualizado = ? WHERE id = ?`).run(...valores, this.ahora(), id);
    return this.lead(id);
  }

  listarLeads({ etapa, semaforo, limite = 200 } = {}) {
    const condiciones = ['anonimizado = 0'];
    const params = [];
    if (etapa) { condiciones.push('etapa = ?'); params.push(etapa); }
    if (semaforo) { condiciones.push('semaforo = ?'); params.push(semaforo); }
    const filas = this.db.prepare(`SELECT * FROM leads WHERE ${condiciones.join(' AND ')} ORDER BY creado DESC LIMIT ?`).all(...params, limite);
    return filas.map(filaLead);
  }

  leadsCreadosEntre(desde, hasta) {
    return this.db.prepare('SELECT * FROM leads WHERE creado >= ? AND creado < ?').all(desde, hasta).map(filaLead);
  }

  // ---------- Eventos (historial) ----------

  registrarEvento(leadId, tipo, datos = {}) {
    this.db.prepare('INSERT INTO eventos (lead_id, fecha, tipo, datos) VALUES (?, ?, ?, ?)').run(leadId, this.ahora(), tipo, JSON.stringify(datos));
  }

  eventos(leadId) {
    return this.db.prepare('SELECT * FROM eventos WHERE lead_id = ? ORDER BY id').all(leadId).map((f) => filaJson(f, ['datos']));
  }

  eventosDeTipoEntre(tipo, desde, hasta) {
    return this.db.prepare('SELECT * FROM eventos WHERE tipo = ? AND fecha >= ? AND fecha < ?').all(tipo, desde, hasta).map((f) => filaJson(f, ['datos']));
  }

  // ---------- Citas ----------

  crearCita(datos) {
    const cita = { id: nuevoId(), creado: this.ahora(), estado: 'reservada', ...datos };
    this.db.prepare('INSERT INTO citas (id, lead_id, codigo, inicio, fin, estado, url_videollamada, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(cita.id, cita.lead_id, cita.codigo, cita.inicio, cita.fin, cita.estado, cita.url_videollamada, cita.creado);
    return cita;
  }

  cita(id) {
    return this.db.prepare('SELECT * FROM citas WHERE id = ?').get(id) ?? null;
  }

  citaPorCodigo(codigo) {
    return this.db.prepare('SELECT * FROM citas WHERE codigo = ?').get(codigo) ?? null;
  }

  citaActiva(leadId) {
    return this.db.prepare("SELECT * FROM citas WHERE lead_id = ? AND estado = 'reservada' ORDER BY inicio DESC LIMIT 1").get(leadId) ?? null;
  }

  citasDeLead(leadId) {
    return this.db.prepare('SELECT * FROM citas WHERE lead_id = ? ORDER BY inicio').all(leadId);
  }

  citasReservadasEntre(desde, hasta) {
    return this.db.prepare("SELECT * FROM citas WHERE estado = 'reservada' AND inicio < ? AND fin > ?").all(hasta, desde);
  }

  actualizarCita(id, cambios) {
    const columnas = Object.keys(cambios);
    this.db.prepare(`UPDATE citas SET ${columnas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...columnas.map((c) => cambios[c]), id);
    return this.cita(id);
  }

  // ---------- Encargos ----------

  crearEncargo(datos) {
    const encargo = { id: nuevoId(), token: nuevoToken(), estado: 'enviado', creado: this.ahora(), ...datos };
    this.db.prepare(`INSERT INTO encargos (id, lead_id, token, estado, honorarios_cent, entrada_cent, num_cuotas, provision_procurador_cent,
      documento_html, documento_sha256, plan, caduca, creado, enviado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      encargo.id, encargo.lead_id, encargo.token, encargo.estado, encargo.honorarios_cent, encargo.entrada_cent, encargo.num_cuotas,
      encargo.provision_procurador_cent, encargo.documento_html, encargo.documento_sha256, JSON.stringify(encargo.plan), encargo.caduca,
      encargo.creado, encargo.enviado ?? encargo.creado,
    );
    return this.encargo(encargo.id);
  }

  encargo(id) {
    return filaJson(this.db.prepare('SELECT * FROM encargos WHERE id = ?').get(id), ['evidencia_firma', 'plan']);
  }

  encargoPorToken(token) {
    return filaJson(this.db.prepare('SELECT * FROM encargos WHERE token = ?').get(token), ['evidencia_firma', 'plan']);
  }

  encargosDeLead(leadId) {
    return this.db.prepare('SELECT * FROM encargos WHERE lead_id = ? ORDER BY creado').all(leadId).map((f) => filaJson(f, ['evidencia_firma', 'plan']));
  }

  actualizarEncargo(id, cambios) {
    const columnas = Object.keys(cambios);
    const valores = columnas.map((c) => (['evidencia_firma', 'plan'].includes(c) ? JSON.stringify(cambios[c]) : cambios[c] ?? null));
    this.db.prepare(`UPDATE encargos SET ${columnas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...valores, id);
    return this.encargo(id);
  }

  // ---------- Pagos ----------

  crearPago(datos) {
    const pago = { id: nuevoId(), estado: 'pendiente', ...datos };
    this.db.prepare('INSERT INTO pagos (id, encargo_id, tipo, numero, importe_cent, vencimiento, estado) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(pago.id, pago.encargo_id, pago.tipo, pago.numero, pago.importe_cent, pago.vencimiento, pago.estado);
    return this.pago(pago.id);
  }

  pago(id) {
    return this.db.prepare('SELECT * FROM pagos WHERE id = ?').get(id) ?? null;
  }

  pagoPorReferencia(referencia) {
    return this.db.prepare('SELECT * FROM pagos WHERE referencia = ?').get(referencia) ?? null;
  }

  pagosDeEncargo(encargoId) {
    return this.db.prepare('SELECT * FROM pagos WHERE encargo_id = ? ORDER BY tipo DESC, numero').all(encargoId);
  }

  pagoPendienteDeTipo(encargoId, tipo) {
    return this.db.prepare("SELECT * FROM pagos WHERE encargo_id = ? AND tipo = ? AND estado != 'pagado' ORDER BY numero LIMIT 1").get(encargoId, tipo) ?? null;
  }

  pagosCobradosEntre(desde, hasta) {
    return this.db.prepare("SELECT * FROM pagos WHERE estado = 'pagado' AND pagado >= ? AND pagado < ?").all(desde, hasta);
  }

  actualizarPago(id, cambios) {
    const columnas = Object.keys(cambios);
    this.db.prepare(`UPDATE pagos SET ${columnas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...columnas.map((c) => cambios[c] ?? null), id);
    return this.pago(id);
  }

  // ---------- Tareas programadas ----------

  programar(tipo, vence, datos = {}, leadId = null) {
    const venceIso = vence instanceof Date ? vence.toISOString() : vence;
    const { lastInsertRowid } = this.db.prepare("INSERT INTO tareas (lead_id, tipo, vence, estado, datos, creado) VALUES (?, ?, ?, 'pendiente', ?, ?)")
      .run(leadId, tipo, venceIso, JSON.stringify(datos), this.ahora());
    return Number(lastInsertRowid);
  }

  /** Cancela las tareas pendientes de un lead. `grupo` filtra por datos.grupo (p. ej. 'seguimiento'). */
  cancelarTareas(leadId, grupo = null) {
    const pendientes = this.db.prepare("SELECT id, datos FROM tareas WHERE lead_id = ? AND estado = 'pendiente'").all(leadId);
    let canceladas = 0;
    for (const tarea of pendientes) {
      if (grupo && JSON.parse(tarea.datos).grupo !== grupo) continue;
      this.db.prepare("UPDATE tareas SET estado = 'cancelada' WHERE id = ?").run(tarea.id);
      canceladas += 1;
    }
    return canceladas;
  }

  tareasVencidas(limite = 50) {
    return this.db.prepare("SELECT * FROM tareas WHERE estado = 'pendiente' AND vence <= ? ORDER BY vence LIMIT ?")
      .all(this.ahora(), limite).map((f) => filaJson(f, ['datos']));
  }

  tareasPendientes(leadId) {
    return this.db.prepare("SELECT * FROM tareas WHERE lead_id = ? AND estado = 'pendiente' ORDER BY vence").all(leadId).map((f) => filaJson(f, ['datos']));
  }

  hayTareaPendiente(tipo) {
    return Boolean(this.db.prepare("SELECT 1 FROM tareas WHERE tipo = ? AND estado = 'pendiente' LIMIT 1").get(tipo));
  }

  completarTarea(id) {
    this.db.prepare("UPDATE tareas SET estado = 'hecha' WHERE id = ?").run(id);
  }

  reintentarTarea(id, intentos, vence, error) {
    this.db.prepare('UPDATE tareas SET intentos = ?, vence = ?, ultimo_error = ? WHERE id = ?').run(intentos, vence, String(error).slice(0, 2000), id);
  }

  fallarTarea(id, intentos, error) {
    this.db.prepare("UPDATE tareas SET estado = 'fallida', intentos = ?, ultimo_error = ? WHERE id = ?").run(intentos, String(error).slice(0, 2000), id);
  }

  // ---------- Bandeja de salida ----------

  registrarSalida({ leadId = null, canal, proveedor, destino, plantilla, contenido, estado, respuesta = null }) {
    this.db.prepare('INSERT INTO salida (lead_id, fecha, canal, proveedor, destino, plantilla, contenido, estado, respuesta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(leadId, this.ahora(), canal, proveedor, destino, plantilla, contenido, estado, respuesta == null ? null : JSON.stringify(respuesta));
  }

  salida(leadId = null) {
    if (leadId) return this.db.prepare('SELECT * FROM salida WHERE lead_id = ? ORDER BY id').all(leadId);
    return this.db.prepare('SELECT * FROM salida ORDER BY id DESC LIMIT 200').all();
  }

  // ---------- Gasto en publicidad ----------

  guardarGasto(mes, origen, importeCent) {
    this.db.prepare(`INSERT INTO gasto_publicidad (mes, origen, importe_cent) VALUES (?, ?, ?)
      ON CONFLICT(mes, origen) DO UPDATE SET importe_cent = excluded.importe_cent`).run(mes, origen, importeCent);
  }

  gastoEntreMeses(mesDesde, mesHasta) {
    return this.db.prepare('SELECT * FROM gasto_publicidad WHERE mes >= ? AND mes <= ?').all(mesDesde, mesHasta);
  }

  // ---------- RGPD ----------

  /** Anonimiza los leads cerrados sin contratar anteriores a `antesDe`. Devuelve cuántos. */
  anonimizarLeadsCerrados(antesDe) {
    const filas = this.db.prepare(`SELECT id FROM leads WHERE anonimizado = 0 AND actualizado < ?
      AND etapa IN ('perdido', 'descartado', 'no_asistio', 'nuevo', 'contactado', 'cualificado')`).all(antesDe);
    for (const { id } of filas) {
      this.db.prepare(`UPDATE leads SET nombre = NULL, telefono = NULL, email = NULL, respuestas = '{}', anonimizado = 1,
        atribucion = json_object('origen_anonimizado', json_extract(atribucion, '$.utm_campaign')) WHERE id = ?`).run(id);
      this.db.prepare("UPDATE salida SET destino = '[anonimizado]', contenido = '[anonimizado]' WHERE lead_id = ?").run(id);
      this.db.prepare("UPDATE tareas SET estado = 'cancelada' WHERE lead_id = ? AND estado = 'pendiente'").run(id);
    }
    return filas.length;
  }

  cerrar() {
    this.db.close();
  }
}
