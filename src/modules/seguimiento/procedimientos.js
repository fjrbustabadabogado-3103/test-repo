import { ErrorValidacion } from '../captacion/intake.js';
import { CAPITALES, datosPreparacion } from '../preparacion/preparacion.js';
import { urlPortal } from '../documentos/expedientes.js';
import { calcularPlazo, diasHabilesRestantes } from './calendario.js';
import { iniciarCierre } from '../cierre/cierre.js';
import { textoCorto, hmacHex, igualSeguro } from '../../util.js';

export const CCAA_POR_PROVINCIA = {
  'Almería': 'Andalucía', 'Cádiz': 'Andalucía', 'Córdoba': 'Andalucía', 'Granada': 'Andalucía', 'Huelva': 'Andalucía', 'Jaén': 'Andalucía',
  'Málaga': 'Andalucía', 'Sevilla': 'Andalucía', 'Huesca': 'Aragón', 'Teruel': 'Aragón', 'Zaragoza': 'Aragón', 'Asturias': 'Principado de Asturias',
  'Baleares': 'Illes Balears', 'Las Palmas': 'Canarias', 'Santa Cruz de Tenerife': 'Canarias', 'Cantabria': 'Cantabria',
  'Ávila': 'Castilla y León', 'Burgos': 'Castilla y León', 'León': 'Castilla y León', 'Palencia': 'Castilla y León', 'Salamanca': 'Castilla y León',
  'Segovia': 'Castilla y León', 'Soria': 'Castilla y León', 'Valladolid': 'Castilla y León', 'Zamora': 'Castilla y León',
  'Albacete': 'Castilla-La Mancha', 'Ciudad Real': 'Castilla-La Mancha', 'Cuenca': 'Castilla-La Mancha', 'Guadalajara': 'Castilla-La Mancha', 'Toledo': 'Castilla-La Mancha',
  'Barcelona': 'Cataluña', 'Girona': 'Cataluña', 'Lleida': 'Cataluña', 'Tarragona': 'Cataluña',
  'Alicante': 'Comunitat Valenciana', 'Castellón': 'Comunitat Valenciana', 'Valencia': 'Comunitat Valenciana',
  'Badajoz': 'Extremadura', 'Cáceres': 'Extremadura', 'A Coruña': 'Galicia', 'Lugo': 'Galicia', 'Ourense': 'Galicia', 'Pontevedra': 'Galicia',
  'Madrid': 'Comunidad de Madrid', 'Murcia': 'Región de Murcia', 'Navarra': 'Comunidad Foral de Navarra',
  'Álava': 'País Vasco', 'Bizkaia': 'País Vasco', 'Gipuzkoa': 'País Vasco', 'La Rioja': 'La Rioja', 'Ceuta': 'Ceuta', 'Melilla': 'Melilla',
};

const noEncontrado = () => Object.assign(new Error('No encontrado.'), { statusCode: 404 });
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function hoyEnZona(ctx) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ctx.config.agenda.zona, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(ctx.reloj()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function calendarioDe(ctx, procedimiento) {
  return {
    ccaa: procedimiento.ccaa,
    autonomicos: ctx.config.calendario.autonomicos?.[procedimiento.ccaa] ?? {},
    locales: procedimiento.festivos_locales ?? [],
  };
}

/** Crea el procedimiento con los datos de la preparación (órgano, comunidad y sede). Idempotente. */
export function asegurarProcedimiento(ctx, expediente) {
  const existente = ctx.store.procedimientoDeExpediente(expediente.id);
  if (existente) return existente;
  const lead = ctx.store.lead(expediente.lead_id);
  return ctx.store.crearProcedimiento({
    expediente_id: expediente.id,
    organo: datosPreparacion(ctx, expediente).tribunal || null,
    ccaa: CCAA_POR_PROVINCIA[lead.provincia] ?? null,
    localidad: CAPITALES[lead.provincia] ?? null,
    estado: 'preparado',
  });
}

function expedienteDe(ctx, expedienteId) {
  const expediente = ctx.store.expediente(expedienteId);
  if (!expediente) throw noEncontrado();
  return expediente;
}

/** Recalcula los vencimientos pendientes (p. ej. tras cargar festivos locales), respetando los plazos encadenados. */
export function recalcularPlazos(ctx, procedimiento) {
  const calendario = calendarioDe(ctx, procedimiento);
  const plazos = ctx.store.plazosDeProcedimiento(procedimiento.id).sort((a, b) => a.creado.localeCompare(b.creado));
  for (const plazo of plazos) {
    if (plazo.estado !== 'pendiente') continue;
    let diesAQuo = plazo.dies_a_quo;
    if (plazo.encadenado_a) {
      const previo = ctx.store.plazo(plazo.encadenado_a);
      if (previo) diesAQuo = previo.vence;
    }
    const r = calcularPlazo({ diesAQuo, cantidad: plazo.cantidad, unidad: plazo.unidad, urgente: plazo.urgente, ...calendario });
    ctx.store.actualizarPlazo(plazo.id, { dies_a_quo: diesAQuo, vence: r.vence, limite_presentacion: r.limitePresentacion, avisos_calendario: r.avisos });
  }
}

export function actualizarDatosProcedimiento(ctx, expedienteId, cuerpo) {
  const expediente = expedienteDe(ctx, expedienteId);
  const procedimiento = asegurarProcedimiento(ctx, expediente);
  const b = cuerpo ?? {};
  const cambios = {};
  for (const [campo, max] of [['organo', 200], ['numero', 60], ['nig', 40], ['localidad', 120], ['notas', 2000]]) {
    if (campo in b) cambios[campo] = textoCorto(b[campo], max);
  }
  if ('ccaa' in b) {
    if (b.ccaa && !(b.ccaa in (ctx.config.calendario.autonomicos ?? {}))) throw new ErrorValidacion('Comunidad autónoma no válida.');
    cambios.ccaa = b.ccaa || null;
  }
  if ('festivos_locales' in b) {
    const lista = Array.isArray(b.festivos_locales) ? b.festivos_locales : String(b.festivos_locales ?? '').split(/[\s,;]+/).filter(Boolean);
    if (lista.some((f) => !FECHA.test(f))) throw new ErrorValidacion('Festivos locales: use fechas AAAA-MM-DD separadas por comas.');
    cambios.festivos_locales = [...new Set(lista)].sort();
  }
  const actualizado = ctx.store.actualizarProcedimiento(procedimiento.id, cambios);
  recalcularPlazos(ctx, actualizado);
  return actualizado;
}

function crearPlazoDesde(ctx, procedimiento, actuacion, def, diesAQuo, encadenadoA = null) {
  const r = calcularPlazo({ diesAQuo, cantidad: def.cantidad, unidad: def.unidad, urgente: def.urgente === true, ...calendarioDe(ctx, procedimiento) });
  return ctx.store.crearPlazo({
    procedimiento_id: procedimiento.id, actuacion_id: actuacion.id, clave: def.clave, titulo: def.titulo, base: def.base ?? null,
    parte: def.parte ?? 'nuestro', dies_a_quo: diesAQuo, cantidad: def.cantidad, unidad: def.unidad, urgente: def.urgente === true,
    encadenado_a: encadenadoA, vence: r.vence, limite_presentacion: r.limitePresentacion, avisos_calendario: r.avisos,
  });
}

/**
 * Registra una actuación del procedimiento: cambia el estado, genera los plazos del catálogo (o uno libre),
 * cancela o da por cumplidos los que correspondan y, si procede, informa al cliente (art. 48.5 EGAE).
 */
export function registrarActuacion(ctx, expedienteId, cuerpo) {
  const expediente = expedienteDe(ctx, expedienteId);
  const b = cuerpo ?? {};
  const def = ctx.config.procesal.actuaciones[b.tipo];
  if (!def) throw new ErrorValidacion('Tipo de actuación no válido.');
  if (!FECHA.test(b.fecha ?? '')) throw new ErrorValidacion('Indique la fecha (AAAA-MM-DD) de la actuación o de su notificación.');
  if (b.fecha > hoyEnZona(ctx)) throw new ErrorValidacion('La fecha no puede ser futura.');
  if (b.tipo === 'presentacion_solicitud' && !ctx.store.preparacion(expediente.id).listo) {
    throw new ErrorValidacion('El expediente no está marcado como listo para presentar (módulo 5).');
  }

  let plazoLibre = null;
  if (def.plazoLibre && b.plazo?.cantidad) {
    const cantidad = Number(b.plazo.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 366) throw new ErrorValidacion('Indique la duración del plazo.');
    if (!['habiles', 'meses', 'naturales'].includes(b.plazo.unidad)) throw new ErrorValidacion('Unidad del plazo no válida.');
    const titulo = textoCorto(b.plazo.titulo, 200);
    if (!titulo) throw new ErrorValidacion('Describa el plazo.');
    plazoLibre = { clave: 'libre', titulo, base: textoCorto(b.plazo.base, 200), cantidad, unidad: b.plazo.unidad, parte: b.plazo.parte === 'tercero' ? 'tercero' : 'nuestro', urgente: b.plazo.urgente === true };
  }

  const resultado = ctx.store.transaccion(() => {
    const procedimiento = asegurarProcedimiento(ctx, expediente);
    const visible = b.visibleCliente ?? def.visibleCliente ?? false;
    const actuacion = ctx.store.crearActuacion({
      procedimiento_id: procedimiento.id, tipo: b.tipo, fecha: b.fecha, titulo: textoCorto(b.titulo, 200) || def.titulo,
      detalle: textoCorto(b.detalle, 2000), visible_cliente: visible,
    });
    const pendientes = ctx.store.plazosDeProcedimiento(procedimiento.id).filter((p) => p.estado === 'pendiente');
    for (const clave of def.cancela ?? []) {
      for (const p of pendientes.filter((x) => x.clave === clave)) ctx.store.actualizarPlazo(p.id, { estado: 'cancelado', notas: `Cancelado por: ${actuacion.titulo}` });
    }
    for (const clave of def.cumple ?? []) {
      for (const p of pendientes.filter((x) => x.clave === clave)) ctx.store.actualizarPlazo(p.id, { estado: 'cumplido', cumplido: b.fecha });
    }
    const creados = {};
    for (const definicion of def.plazos ?? []) {
      const previo = definicion.encadenadoA ? creados[definicion.encadenadoA] : null;
      creados[definicion.clave] = crearPlazoDesde(ctx, procedimiento, actuacion, definicion, previo ? previo.vence : b.fecha, previo?.id ?? null);
    }
    if (plazoLibre) creados.libre = crearPlazoDesde(ctx, procedimiento, actuacion, plazoLibre, b.fecha);
    if (def.estado) ctx.store.actualizarProcedimiento(procedimiento.id, { estado: def.estado });
    return { procedimiento: ctx.store.procedimiento(procedimiento.id), actuacion, plazos: Object.values(creados), visible };
  });

  ctx.store.registrarEvento(expediente.lead_id, 'actuacion_procesal', { tipo: b.tipo, fecha: b.fecha, plazos: resultado.plazos.length });
  if (resultado.visible) {
    const novedad = def.mensajeCliente ?? resultado.actuacion.detalle ?? resultado.actuacion.titulo;
    ctx.store.programar('mensaje', ctx.reloj(), { plantilla: 'novedad_procedimiento', extra: { novedad, enlace_documentos: urlPortal(ctx, expediente) } }, expediente.lead_id);
  }
  if (['auto_exoneracion_concedida', 'auto_exoneracion_denegada'].includes(b.tipo)) {
    iniciarCierre(ctx, expediente, { motivo: b.tipo === 'auto_exoneracion_concedida' ? 'exoneracion_concedida' : 'exoneracion_denegada', fecha: b.fecha });
  }
  const eventosEquipo = { auto_exoneracion_concedida: 'EXONERACIÓN CONCEDIDA', auto_exoneracion_denegada: 'URGENTE: exoneración DENEGADA, valorar recurso' };
  if (eventosEquipo[b.tipo]) ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: eventosEquipo[b.tipo] } }, expediente.lead_id);
  return resultado;
}

export function marcarPlazo(ctx, plazoId, { estado, notas }) {
  const plazo = ctx.store.plazo(plazoId);
  if (!plazo) throw noEncontrado();
  if (!['cumplido', 'cancelado', 'pendiente'].includes(estado)) throw new ErrorValidacion('Estado no válido.');
  return ctx.store.actualizarPlazo(plazo.id, {
    estado, cumplido: estado === 'cumplido' ? hoyEnZona(ctx) : null, alertas_enviadas: estado === 'pendiente' ? [] : plazo.alertas_enviadas,
    ...(notas !== undefined ? { notas: textoCorto(notas, 1000) } : {}),
  });
}

function conRestantes(ctx, plazo, procedimiento) {
  return { ...plazo, restantes: plazo.estado === 'pendiente' ? diasHabilesRestantes(hoyEnZona(ctx), plazo.vence, calendarioDe(ctx, procedimiento)) : null };
}

export function resumenSeguimiento(ctx, expedienteId) {
  const expediente = expedienteDe(ctx, expedienteId);
  const procedimiento = ctx.store.procedimientoDeExpediente(expediente.id);
  return {
    procedimiento,
    estadoTexto: procedimiento ? ctx.config.procesal.estados[procedimiento.estado] ?? procedimiento.estado : null,
    actuaciones: procedimiento ? ctx.store.actuacionesDeProcedimiento(procedimiento.id) : [],
    plazos: procedimiento ? ctx.store.plazosDeProcedimiento(procedimiento.id).map((p) => conRestantes(ctx, p, procedimiento)) : [],
    catalogo: Object.fromEntries(Object.entries(ctx.config.procesal.actuaciones).map(([k, v]) => [k, { titulo: v.titulo, plazoLibre: Boolean(v.plazoLibre) }])),
    comunidades: Object.keys(ctx.config.calendario.autonomicos ?? {}),
    listoParaPresentar: Boolean(ctx.store.preparacion(expediente.id).listo),
  };
}

/** Vista para el cliente: estado y actuaciones marcadas como visibles. */
export function seguimientoParaCliente(ctx, expediente) {
  const procedimiento = ctx.store.procedimientoDeExpediente(expediente.id);
  if (!procedimiento) return null;
  return {
    estado: ctx.config.procesal.estadosCliente?.[procedimiento.estado] ?? ctx.config.procesal.estados[procedimiento.estado] ?? procedimiento.estado,
    actuaciones: ctx.store.actuacionesDeProcedimiento(procedimiento.id).filter((a) => a.visible_cliente).map((a) => ({ fecha: a.fecha, titulo: a.titulo })),
  };
}

/** Agenda de plazos pendientes de todos los expedientes, del más urgente al menos. */
export function agendaPlazos(ctx) {
  return ctx.store.plazosPendientes().map((plazo) => {
    const procedimiento = ctx.store.procedimiento(plazo.procedimiento_id);
    const expediente = ctx.store.expediente(procedimiento.expediente_id);
    const lead = ctx.store.lead(expediente.lead_id);
    return { ...conRestantes(ctx, plazo, procedimiento), expedienteId: expediente.id, leadId: lead.id, cliente: lead.nombre, organo: procedimiento.organo, numero: procedimiento.numero };
  }).sort((a, b) => a.vence.localeCompare(b.vence));
}

/** Tarea diaria: alertas escalonadas de plazos propios y marca de vencidos o transcurridos. */
export function revisarPlazos(ctx) {
  const umbrales = ctx.config.procesal.alertasDiasHabiles ?? [5, 2, 1, 0];
  let alertas = 0;
  for (const p of agendaPlazos(ctx)) {
    const avisar = (evento) => {
      ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento } }, p.leadId);
      alertas += 1;
    };
    if (p.restantes < 0) {
      if (p.parte === 'nuestro') {
        ctx.store.actualizarPlazo(p.id, { estado: 'vencido' });
        avisar(`PLAZO VENCIDO el ${p.vence}: ${p.titulo}. Presentación posible hasta las 15:00 del ${p.limite_presentacion} (art. 135.5 LEC)`);
      } else {
        ctx.store.actualizarPlazo(p.id, { estado: 'transcurrido' });
        avisar(`Ha transcurrido el plazo de terceros: ${p.titulo}. Compruebe si hubo escritos y registre la actuación`);
      }
      continue;
    }
    if (p.parte !== 'nuestro') continue;
    const umbral = umbrales.filter((u) => p.restantes <= u).sort((a, b) => a - b)[0];
    if (umbral == null || p.alertas_enviadas.includes(umbral)) continue;
    ctx.store.actualizarPlazo(p.id, { alertas_enviadas: [...p.alertas_enviadas, umbral] });
    avisar(p.restantes === 0
      ? `PLAZO: vence HOY ${p.titulo} (${p.base ?? ''})`
      : `PLAZO: ${p.titulo} vence el ${p.vence}, quedan ${p.restantes} día(s) hábil(es)`);
  }
  return alertas;
}

// ---------------- Calendario .ics para Google Calendar u Outlook ----------------

export const claveCalendario = (ctx) => hmacHex(ctx.config.appSecret, 'calendario-plazos').slice(0, 32);
export const claveCalendarioValida = (ctx, clave) => igualSeguro(clave, claveCalendario(ctx));

export function icsPlazos(ctx) {
  const escapar = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const compacta = (iso) => iso.replace(/-/g, '');
  const eventos = agendaPlazos(ctx).flatMap((p) => [
    'BEGIN:VEVENT',
    `UID:plazo-${p.id}@bustabad-lso`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;VALUE=DATE:${compacta(p.vence)}`,
    `SUMMARY:${escapar(`${p.parte === 'nuestro' ? 'VENCE' : 'Plazo terceros'}: ${p.titulo} · ${p.cliente ?? ''}`)}`,
    `DESCRIPTION:${escapar(`${p.base ?? ''}\n${p.organo ?? ''} ${p.numero ?? ''}\nPresentación hasta las 15:00 del ${p.limite_presentacion} (art. 135.5 LEC)\n${(p.avisos_calendario ?? []).join('\n')}`)}`,
    ...(p.parte === 'nuestro' ? ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Plazo procesal', 'TRIGGER:-P2D', 'END:VALARM'] : []),
    'END:VEVENT',
  ]);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bustabad Abogados//Plazos LSO//ES', 'X-WR-CALNAME:Plazos procesales', ...eventos, 'END:VCALENDAR', ''].join('\r\n');
}
