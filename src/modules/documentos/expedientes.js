import { ErrorValidacion } from '../captacion/intake.js';
import { detectarTipo, limpiarNombre } from './almacen.js';
import { sumarDias, textoCorto } from '../../util.js';

const ESTADOS_CIVILES = ['soltero', 'casado', 'pareja_inscrita', 'separado_divorciado', 'viudo'];
const REGIMENES = ['gananciales', 'separacion', 'participacion', 'otro', 'no_sabe'];
const SITUACIONES = ['asalariado', 'autonomo', 'desempleado', 'pensionista', 'otro'];
const HECHOS = ['subido', 'validado', 'no_aplica'];

const noEncontrado = () => Object.assign(new Error('Expediente no encontrado.'), { statusCode: 404 });

/** Evalúa una condición `si` de config/documentos.json contra { respuestas, datos }. */
export function condicionCumple(si, contexto) {
  if (!si) return true;
  return Object.entries(si).every(([ruta, esperado]) => {
    const [ambito, campo] = ruta.split('.');
    const valor = contexto[ambito]?.[campo];
    if (Array.isArray(esperado)) return esperado.includes(valor);
    if (esperado && typeof esperado === 'object') {
      if ('>' in esperado) return typeof valor === 'number' && valor > esperado['>'];
      return false;
    }
    return valor === esperado;
  });
}

export function documentosAplicables(config, lead, datos = {}) {
  const contexto = { respuestas: lead.respuestas ?? {}, datos };
  return config.documentos.documentos.filter((d) => condicionCumple(d.si, contexto));
}

/** Alinea los documentos del expediente con los que exige el caso (sin borrar nada de lo ya subido). */
export function sincronizarDocumentos(ctx, expediente) {
  const lead = ctx.store.lead(expediente.lead_id);
  const aplicables = documentosAplicables(ctx.config, lead, expediente.datos);
  const claves = new Set(aplicables.map((d) => d.clave));
  for (const def of aplicables) ctx.store.asegurarDocumento(expediente.id, def.clave, def.obligatorio);
  for (const doc of ctx.store.documentosDeExpediente(expediente.id)) {
    if (!claves.has(doc.clave) && doc.estado === 'pendiente') ctx.store.actualizarDocumento(doc.id, { estado: 'no_aplica' });
  }
}

export function urlPortal(ctx, expediente) {
  return `${ctx.config.baseUrl}/expediente/${expediente.token}`;
}

/** Abre el expediente de un encargo activo y pide la documentación. Idempotente. */
export function abrirExpediente(ctx, encargo) {
  const existente = ctx.store.expedientePorEncargo(encargo.id);
  if (existente) return existente;
  const expediente = ctx.store.crearExpediente({ lead_id: encargo.lead_id, encargo_id: encargo.id });
  sincronizarDocumentos(ctx, expediente);
  ctx.store.registrarEvento(encargo.lead_id, 'expediente_abierto', { expedienteId: expediente.id });
  const extra = { enlace_documentos: urlPortal(ctx, expediente) };
  ctx.store.programar('mensaje', ctx.reloj(), { plantilla: 'documentos_solicitud', extra }, encargo.lead_id);
  ctx.store.programar('recordatorio_documentos', sumarDias(ctx.reloj(), ctx.config.documentos.recordatorioCadaDias), {
    expedienteId: expediente.id, numero: 1, grupo: 'documentos',
  }, encargo.lead_id);
  return expediente;
}

function pendientesObligatorios(ctx, expediente) {
  return ctx.store.documentosDeExpediente(expediente.id).filter((d) => d.obligatorio && !HECHOS.includes(d.estado));
}

/** Vista del expediente para el portal del cliente y para el panel. */
export function resumenExpediente(ctx, expediente) {
  const defs = new Map(ctx.config.documentos.documentos.map((d) => [d.clave, d]));
  const documentos = ctx.store.documentosDeExpediente(expediente.id)
    .filter((d) => d.estado !== 'no_aplica')
    .map((d) => {
      const def = defs.get(d.clave) ?? { titulo: d.clave };
      return {
        id: d.id, clave: d.clave, titulo: def.titulo, descripcion: def.descripcion, comoObtenerlo: def.comoObtenerlo,
        obligatorio: d.obligatorio, estado: d.estado, motivoRechazo: d.motivo_rechazo,
        archivos: ctx.store.archivosDeDocumento(d.id).map((a) => ({ id: a.id, nombre: a.nombre, tamano: a.tamano, subido: a.subido })),
      };
    });
  const obligatorios = documentos.filter((d) => d.obligatorio);
  return {
    estado: expediente.estado,
    datos: expediente.datos,
    datosCompletos: Boolean(expediente.datos?.domicilio),
    documentos,
    progreso: {
      obligatorios: obligatorios.length,
      aportados: obligatorios.filter((d) => ['subido', 'validado'].includes(d.estado)).length,
      validados: obligatorios.filter((d) => d.estado === 'validado').length,
    },
    limites: {
      maxMbPorArchivo: ctx.config.documentos.maxMbPorArchivo,
      maxArchivosPorDocumento: ctx.config.documentos.maxArchivosPorDocumento,
    },
  };
}

export function expedienteParaCliente(ctx, token) {
  const expediente = ctx.store.expedientePorToken(token);
  if (!expediente) throw noEncontrado();
  return expediente;
}

function exigirAbierto(expediente) {
  if (['cerrado', 'documentacion_completa'].includes(expediente.estado)) {
    throw new ErrorValidacion('La documentación de este expediente ya está cerrada. Si necesita aportar algo más, responda a nuestro último mensaje.');
  }
}

/**
 * Datos complementarios para la memoria (art. 7.1º TRLC: cónyuge o pareja, fecha y régimen económico)
 * y para saber qué documentos adicionales hacen falta.
 */
export function guardarDatos(ctx, token, entrada) {
  const expediente = expedienteParaCliente(ctx, token);
  exigirAbierto(expediente);
  const b = entrada ?? {};
  const booleano = (v) => v === true || v === 'si';
  const datos = {
    domicilio: textoCorto(b.domicilio, 300),
    estado_civil: b.estado_civil,
    regimen_economico: b.regimen_economico || null,
    conyuge_nombre: textoCorto(b.conyuge_nombre, 120),
    fecha_matrimonio: /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_matrimonio ?? '') ? b.fecha_matrimonio : null,
    personas_a_cargo: Number.isInteger(Number(b.personas_a_cargo)) ? Math.max(0, Math.min(20, Number(b.personas_a_cargo))) : 0,
    situacion_laboral: b.situacion_laboral,
    tiene_inmuebles: booleano(b.tiene_inmuebles),
    tiene_vehiculos: booleano(b.tiene_vehiculos),
    procedimientos_judiciales: booleano(b.procedimientos_judiciales),
    causas: textoCorto(b.causas, 2000),
  };
  if (!datos.domicilio) throw new ErrorValidacion('Indique su domicilio completo.');
  if (!ESTADOS_CIVILES.includes(datos.estado_civil)) throw new ErrorValidacion('Indique su estado civil.');
  if (!SITUACIONES.includes(datos.situacion_laboral)) throw new ErrorValidacion('Indique su situación laboral.');
  if (['casado', 'pareja_inscrita'].includes(datos.estado_civil) && !datos.conyuge_nombre) {
    throw new ErrorValidacion('Indique el nombre de su cónyuge o pareja.');
  }
  if (datos.estado_civil === 'casado' && !REGIMENES.includes(datos.regimen_economico)) {
    throw new ErrorValidacion('Indique el régimen económico de su matrimonio (si no lo sabe, elija «No lo sé»).');
  }
  const actualizado = ctx.store.actualizarExpediente(expediente.id, { datos });
  sincronizarDocumentos(ctx, actualizado);
  actualizarEstadoTrasCambio(ctx, actualizado);
  ctx.store.registrarEvento(expediente.lead_id, 'datos_expediente', { expedienteId: expediente.id });
  return resumenExpediente(ctx, ctx.store.expediente(expediente.id));
}

/** Pasa a revisión cuando están todos los obligatorios aportados, y vuelve a recogida si deja de estarlo. */
function actualizarEstadoTrasCambio(ctx, expediente) {
  const faltan = pendientesObligatorios(ctx, expediente).length > 0 || !expediente.datos?.domicilio;
  if (!faltan && expediente.estado === 'recogida_documentos') {
    ctx.store.actualizarExpediente(expediente.id, { estado: 'en_revision' });
    ctx.store.registrarEvento(expediente.lead_id, 'documentacion_aportada', { expedienteId: expediente.id });
    ctx.store.programar('aviso_equipo', ctx.reloj(), {
      plantilla: 'aviso_equipo_evento', extra: { evento: 'Documentación aportada: pendiente de revisión' },
    }, expediente.lead_id);
  } else if (faltan && expediente.estado === 'en_revision') {
    ctx.store.actualizarExpediente(expediente.id, { estado: 'recogida_documentos' });
  }
}

export async function subirArchivo(ctx, token, documentoId, { contenido, nombre }) {
  const expediente = expedienteParaCliente(ctx, token);
  exigirAbierto(expediente);
  const documento = ctx.store.documento(documentoId);
  if (!documento || documento.expediente_id !== expediente.id || documento.estado === 'no_aplica') throw noEncontrado();
  if (documento.estado === 'validado') throw new ErrorValidacion('Este documento ya está revisado y validado.');

  const limites = ctx.config.documentos;
  if (!contenido?.length) throw new ErrorValidacion('El archivo está vacío.');
  if (contenido.length > limites.maxMbPorArchivo * 1024 * 1024) throw new ErrorValidacion(`El archivo supera ${limites.maxMbPorArchivo} MB.`);
  const tipo = detectarTipo(contenido);
  if (!tipo) throw new ErrorValidacion('Formato no admitido. Suba un PDF o una foto (JPG, PNG, HEIC o WEBP).');
  if (ctx.store.archivosDeDocumento(documento.id).length >= limites.maxArchivosPorDocumento) {
    throw new ErrorValidacion(`Máximo ${limites.maxArchivosPorDocumento} archivos por documento.`);
  }
  if (ctx.store.bytesDeExpediente(expediente.id) + contenido.length > limites.maxMbPorExpediente * 1024 * 1024) {
    throw new ErrorValidacion('Se ha alcanzado el espacio máximo del expediente. Contacte con el despacho.');
  }

  const guardado = await ctx.almacen.guardar(expediente.id, contenido);
  const archivo = ctx.store.crearArchivo({
    documento_id: documento.id, nombre: limpiarNombre(nombre, tipo.ext), tipo_mime: tipo.mime, tamano: contenido.length, ...guardado,
  });
  ctx.store.actualizarDocumento(documento.id, { estado: 'subido', motivo_rechazo: null });
  ctx.store.registrarEvento(expediente.lead_id, 'archivo_subido', { documento: documento.clave, archivoId: archivo.id, tamano: archivo.tamano });
  actualizarEstadoTrasCambio(ctx, ctx.store.expediente(expediente.id));
  return resumenExpediente(ctx, ctx.store.expediente(expediente.id));
}

export async function eliminarArchivo(ctx, token, archivoId) {
  const expediente = expedienteParaCliente(ctx, token);
  exigirAbierto(expediente);
  const archivo = ctx.store.archivo(archivoId);
  const documento = archivo && ctx.store.documento(archivo.documento_id);
  if (!archivo || archivo.eliminado || !documento || documento.expediente_id !== expediente.id) throw noEncontrado();
  if (documento.estado === 'validado') throw new ErrorValidacion('No se puede eliminar un archivo de un documento ya validado.');
  ctx.store.marcarArchivoEliminado(archivo.id);
  await ctx.almacen.borrar(archivo);
  if (ctx.store.archivosDeDocumento(documento.id).length === 0) ctx.store.actualizarDocumento(documento.id, { estado: 'pendiente' });
  ctx.store.registrarEvento(expediente.lead_id, 'archivo_eliminado', { documento: documento.clave, archivoId });
  actualizarEstadoTrasCambio(ctx, ctx.store.expediente(expediente.id));
  return resumenExpediente(ctx, ctx.store.expediente(expediente.id));
}

/** Revisión del abogado: validar o pedir que se vuelva a subir con un motivo. */
export function revisarDocumento(ctx, documentoId, { decision, motivo }) {
  const documento = ctx.store.documento(documentoId);
  if (!documento) throw noEncontrado();
  const expediente = ctx.store.expediente(documento.expediente_id);
  if (expediente.estado === 'cerrado') throw new ErrorValidacion('El expediente está cerrado.');
  const def = ctx.config.documentos.documentos.find((d) => d.clave === documento.clave);

  if (decision === 'rechazar') {
    const razon = textoCorto(motivo, 300);
    if (!razon) throw new ErrorValidacion('Indique el motivo para que el cliente sepa qué corregir.');
    ctx.store.actualizarDocumento(documento.id, { estado: 'rechazado', motivo_rechazo: razon, revisado: ctx.store.ahora() });
    ctx.store.registrarEvento(expediente.lead_id, 'documento_rechazado', { documento: documento.clave, motivo: razon });
    if (expediente.estado !== 'recogida_documentos') ctx.store.actualizarExpediente(expediente.id, { estado: 'recogida_documentos', documentacion_completa: null });
    ctx.store.programar('mensaje', ctx.reloj(), {
      plantilla: 'documento_rechazado', extra: { documento: def?.titulo ?? documento.clave, motivo: razon, enlace_documentos: urlPortal(ctx, expediente) },
    }, expediente.lead_id);
    return ctx.store.documento(documento.id);
  }

  if (decision !== 'validar') throw new ErrorValidacion('Decisión no válida.');
  if (ctx.store.archivosDeDocumento(documento.id).length === 0 && documento.clave !== 'poder_procurador') {
    throw new ErrorValidacion('No se puede validar un documento sin archivos.');
  }
  ctx.store.actualizarDocumento(documento.id, { estado: 'validado', motivo_rechazo: null, revisado: ctx.store.ahora() });
  ctx.store.registrarEvento(expediente.lead_id, 'documento_validado', { documento: documento.clave });

  const actual = ctx.store.expediente(expediente.id);
  const todosValidados = ctx.store.documentosDeExpediente(actual.id).every((d) => !d.obligatorio || ['validado', 'no_aplica'].includes(d.estado));
  if (todosValidados && actual.datos?.domicilio && actual.estado !== 'documentacion_completa') {
    ctx.store.actualizarExpediente(actual.id, { estado: 'documentacion_completa', documentacion_completa: ctx.store.ahora() });
    ctx.store.cancelarTareas(actual.lead_id, 'documentos');
    ctx.store.registrarEvento(actual.lead_id, 'documentacion_completa', { expedienteId: actual.id });
    ctx.store.programar('mensaje', ctx.reloj(), { plantilla: 'documentacion_completa' }, actual.lead_id);
    ctx.store.programar('aviso_equipo', ctx.reloj(), {
      plantilla: 'aviso_equipo_evento', extra: { evento: 'Documentación completa y validada: preparar la solicitud' },
    }, actual.lead_id);
  }
  return ctx.store.documento(documento.id);
}

/** Tarea programada: recordatorio mientras falten documentos obligatorios. */
export async function recordarDocumentos(ctx, tarea, lead) {
  const expediente = ctx.store.expediente(tarea.datos.expedienteId);
  if (!expediente || expediente.estado !== 'recogida_documentos') return 'omitida';
  const pendientes = pendientesObligatorios(ctx, expediente).length + (expediente.datos?.domicilio ? 0 : 1);
  if (pendientes === 0) return 'omitida';
  await ctx.mensajeria.enviar(lead, 'documentos_recordatorio', { pendientes, enlace_documentos: urlPortal(ctx, expediente) });
  const { recordatorioCadaDias, maxRecordatorios } = ctx.config.documentos;
  if (tarea.datos.numero < maxRecordatorios) {
    ctx.store.programar('recordatorio_documentos', sumarDias(ctx.reloj(), recordatorioCadaDias), {
      expedienteId: expediente.id, numero: tarea.datos.numero + 1, grupo: 'documentos',
    }, lead.id);
  } else {
    ctx.store.programar('aviso_equipo', ctx.reloj(), {
      plantilla: 'aviso_equipo_evento', extra: { evento: `Documentación incompleta tras ${maxRecordatorios} recordatorios: llamar al cliente` },
    }, lead.id);
  }
  return 'enviado';
}

export function cerrarExpedienteDeEncargo(ctx, encargoId) {
  const expediente = ctx.store.expedientePorEncargo(encargoId);
  if (expediente) ctx.store.actualizarExpediente(expediente.id, { estado: 'cerrado' });
}
