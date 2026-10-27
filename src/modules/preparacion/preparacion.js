import Anthropic from '@anthropic-ai/sdk';
import { ErrorValidacion } from '../captacion/intake.js';
import { exonerablePublico } from '../cualificacion/scoring.js';
import { TIPOS_ACREEDOR, GARANTIAS, TIPOS_BIEN, extraerDatos, filasDesdeExtraccion, iaDisponible } from './extraccion.js';
import { aCentimos, textoCorto, normalizarEmail } from '../../util.js';

/**
 * Capital de cada provincia: sede habitual de la Sección de lo Mercantil competente para el concurso de persona
 * natural (art. 87.1 y 87.7 LOPJ, redacción LO 1/2025). Hay excepciones (art. 87.3 y 87.4): el abogado debe confirmarlo.
 */
export const CAPITALES = {
  'A Coruña': 'A Coruña', 'Álava': 'Vitoria-Gasteiz', 'Albacete': 'Albacete', 'Alicante': 'Alicante', 'Almería': 'Almería',
  'Asturias': 'Oviedo', 'Ávila': 'Ávila', 'Badajoz': 'Badajoz', 'Baleares': 'Palma', 'Barcelona': 'Barcelona', 'Bizkaia': 'Bilbao',
  'Burgos': 'Burgos', 'Cáceres': 'Cáceres', 'Cádiz': 'Cádiz', 'Cantabria': 'Santander', 'Castellón': 'Castellón de la Plana',
  'Ceuta': 'Ceuta', 'Ciudad Real': 'Ciudad Real', 'Córdoba': 'Córdoba', 'Cuenca': 'Cuenca', 'Gipuzkoa': 'Donostia/San Sebastián',
  'Girona': 'Girona', 'Granada': 'Granada', 'Guadalajara': 'Guadalajara', 'Huelva': 'Huelva', 'Huesca': 'Huesca', 'Jaén': 'Jaén',
  'La Rioja': 'Logroño', 'Las Palmas': 'Las Palmas de Gran Canaria', 'León': 'León', 'Lleida': 'Lleida', 'Lugo': 'Lugo',
  'Madrid': 'Madrid', 'Málaga': 'Málaga', 'Melilla': 'Melilla', 'Murcia': 'Murcia', 'Navarra': 'Pamplona', 'Ourense': 'Ourense',
  'Palencia': 'Palencia', 'Pontevedra': 'Pontevedra', 'Salamanca': 'Salamanca', 'Santa Cruz de Tenerife': 'Santa Cruz de Tenerife',
  'Segovia': 'Segovia', 'Sevilla': 'Sevilla', 'Soria': 'Soria', 'Tarragona': 'Tarragona', 'Teruel': 'Teruel', 'Toledo': 'Toledo',
  'Valencia': 'Valencia', 'Valladolid': 'Valladolid', 'Zamora': 'Zamora', 'Zaragoza': 'Zaragoza',
};

export const CLASES = ['privilegio_especial', 'privilegio_general', 'ordinario', 'subordinado'];
export const RUTAS = ['sin_masa', 'plan_pagos', 'liquidacion'];

const noEncontrado = () => Object.assign(new Error('No encontrado.'), { statusCode: 404 });

export function expedienteParaPreparar(ctx, id) {
  const expediente = ctx.store.expediente(id);
  if (!expediente) throw noEncontrado();
  return expediente;
}

function exigirEditable(ctx, expediente) {
  if (expediente.estado === 'cerrado') throw new ErrorValidacion('El expediente está cerrado.');
  if (ctx.store.preparacion(expediente.id).listo) throw new ErrorValidacion('El expediente está marcado como listo para presentar. Reábralo para editar.');
}

function enumOpcional(valor, lista, nombre) {
  if (valor == null || valor === '') return null;
  if (!lista.includes(valor)) throw new ErrorValidacion(`Valor no válido para ${nombre}.`);
  return valor;
}

function importe(valor, nombre) {
  if (valor == null || valor === '') return null;
  const cent = aCentimos(valor);
  if (cent == null) throw new ErrorValidacion(`Importe no válido en ${nombre}.`);
  return cent;
}

function fecha(valor) {
  if (valor == null || valor === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new ErrorValidacion('Fecha no válida (AAAA-MM-DD).');
  return valor;
}

/** Normaliza los campos editables (importes en euros en la entrada, céntimos en la base de datos). */
function camposAcreedor(b) {
  const campos = {};
  if ('nombre' in b) campos.nombre = textoCorto(b.nombre, 200);
  if ('nif' in b) campos.nif = textoCorto(b.nif, 20);
  if ('domicilio' in b) campos.domicilio = textoCorto(b.domicilio, 300);
  if ('email' in b) campos.email = b.email ? normalizarEmail(b.email) ?? (() => { throw new ErrorValidacion('Email no válido.'); })() : null;
  if ('tipo' in b) campos.tipo = enumOpcional(b.tipo, TIPOS_ACREEDOR, 'tipo') ?? 'otro';
  if ('concepto' in b) campos.concepto = textoCorto(b.concepto, 200);
  if ('importe' in b) campos.importe_cent = importe(b.importe, 'el importe');
  if ('vencimiento' in b) campos.vencimiento = fecha(b.vencimiento);
  if ('garantia' in b) campos.garantia = enumOpcional(b.garantia, GARANTIAS, 'garantía') ?? 'ninguna';
  if ('garantia_detalle' in b) campos.garantia_detalle = textoCorto(b.garantia_detalle, 300);
  if ('procedimiento_judicial' in b) campos.procedimiento_judicial = textoCorto(b.procedimiento_judicial, 300);
  if ('clase' in b) campos.clase = enumOpcional(b.clase, CLASES, 'clase');
  if ('notas' in b) campos.notas = textoCorto(b.notas, 1000);
  if ('revisado' in b) campos.revisado = b.revisado === true;
  return campos;
}

function camposBien(b) {
  const campos = {};
  if ('tipo' in b) campos.tipo = enumOpcional(b.tipo, TIPOS_BIEN, 'tipo') ?? 'otro';
  if ('descripcion' in b) campos.descripcion = textoCorto(b.descripcion, 300);
  if ('ubicacion' in b) campos.ubicacion = textoCorto(b.ubicacion, 200);
  if ('datos_registrales' in b) campos.datos_registrales = textoCorto(b.datos_registrales, 300);
  if ('valor_adquisicion' in b) campos.valor_adquisicion_cent = importe(b.valor_adquisicion, 'el valor de adquisición');
  if ('valor_mercado' in b) campos.valor_mercado_cent = importe(b.valor_mercado, 'el valor de mercado');
  if ('cargas' in b) campos.cargas = textoCorto(b.cargas, 300);
  if ('cargas_importe' in b) campos.cargas_cent = importe(b.cargas_importe, 'las cargas');
  if ('embargable' in b) campos.embargable = b.embargable == null || b.embargable === '' ? null : b.embargable === true;
  if ('notas' in b) campos.notas = textoCorto(b.notas, 1000);
  if ('revisado' in b) campos.revisado = b.revisado === true;
  return campos;
}

const TABLAS = { acreedores: camposAcreedor, bienes: camposBien };

export function crearPartida(ctx, expedienteId, tabla, cuerpo) {
  const expediente = expedienteParaPreparar(ctx, expedienteId);
  exigirEditable(ctx, expediente);
  const campos = TABLAS[tabla](cuerpo ?? {});
  if (tabla === 'acreedores' && !campos.tipo) campos.tipo = 'otro';
  if (tabla === 'bienes' && !campos.tipo) campos.tipo = 'otro';
  return ctx.store.crearPartida(tabla, expediente.id, { ...campos, origen: 'manual' });
}

export function editarPartida(ctx, tabla, id, cuerpo) {
  const partida = ctx.store.partida(tabla, id);
  if (!partida) throw noEncontrado();
  exigirEditable(ctx, ctx.store.expediente(partida.expediente_id));
  return ctx.store.actualizarPartida(tabla, id, TABLAS[tabla](cuerpo ?? {}));
}

export function borrarPartida(ctx, tabla, id) {
  const partida = ctx.store.partida(tabla, id);
  if (!partida) throw noEncontrado();
  exigirEditable(ctx, ctx.store.expediente(partida.expediente_id));
  ctx.store.borrarPartida(tabla, id);
}

/** Valores por defecto de la preparación a partir de lo que ya sabemos del cliente. */
function preparacionInicial(ctx, expediente) {
  const lead = ctx.store.lead(expediente.lead_id);
  const capital = CAPITALES[lead.provincia] ?? '';
  const d = expediente.datos ?? {};
  const actividad = {
    asalariado: 'Trabajador/a por cuenta ajena.', autonomo: 'Trabajador/a por cuenta propia (autónomo/a).', desempleado: 'En situación de desempleo.',
    pensionista: 'Pensionista.', otro: '',
  }[d.situacion_laboral] ?? '';
  return {
    tribunal: capital ? `Sección de lo Mercantil del Tribunal de Instancia de ${capital}` : '',
    historia: '',
    actividad,
    establecimientos: lead.respuestas?.tipo_deudor === 'autonomo' ? '' : 'No es titular de establecimientos, oficinas ni explotaciones.',
    causas: d.causas ?? '',
    ruta: null,
    procurador: '',
    poder: '',
    costePrevistoEuros: ctx.config.preparacion?.costePrevistoProcedimientoEuros ?? null,
  };
}

export function datosPreparacion(ctx, expediente) {
  const guardada = ctx.store.preparacion(expediente.id);
  return { ...preparacionInicial(ctx, expediente), ...guardada.datos, listo: guardada.listo };
}

export function guardarDatosPreparacion(ctx, expedienteId, cuerpo) {
  const expediente = expedienteParaPreparar(ctx, expedienteId);
  exigirEditable(ctx, expediente);
  const b = cuerpo ?? {};
  const actual = datosPreparacion(ctx, expediente);
  const datos = {
    tribunal: textoCorto(b.tribunal ?? actual.tribunal, 200),
    historia: textoCorto(b.historia ?? actual.historia, 8000),
    actividad: textoCorto(b.actividad ?? actual.actividad, 4000),
    establecimientos: textoCorto(b.establecimientos ?? actual.establecimientos, 2000),
    causas: textoCorto(b.causas ?? actual.causas, 8000),
    ruta: enumOpcional(b.ruta ?? actual.ruta, RUTAS, 'ruta'),
    procurador: textoCorto(b.procurador ?? actual.procurador, 200),
    poder: textoCorto(b.poder ?? actual.poder, 300),
    costePrevistoEuros: b.costePrevistoEuros === '' ? null : b.costePrevistoEuros != null ? Number(b.costePrevistoEuros) : actual.costePrevistoEuros,
  };
  if (datos.costePrevistoEuros != null && !(datos.costePrevistoEuros >= 0)) throw new ErrorValidacion('Coste previsto no válido.');
  ctx.store.guardarPreparacion(expediente.id, { datos });
  return datosPreparacion(ctx, ctx.store.expediente(expediente.id));
}

const suma = (lista, campo) => lista.reduce((s, x) => s + (x[campo] ?? 0), 0);

/**
 * Indicadores para que el abogado decida la vía. No sustituyen su criterio: la clasificación de créditos,
 * la inembargabilidad y la vía procesal las decide él.
 */
export function indicadores(ctx, expediente) {
  const acreedores = ctx.store.partidas('acreedores', expediente.id);
  const bienes = ctx.store.partidas('bienes', expediente.id);
  const limite = ctx.config.cualificacion.limiteExoneracionPublica;
  const porTipo = (tipo) => acreedores.filter((a) => a.tipo === tipo);

  const pasivo = suma(acreedores, 'importe_cent');
  const aeat = suma(porTipo('aeat'), 'importe_cent');
  const tgss = suma(porTipo('seguridad_social'), 'importe_cent');
  const alimentos = suma(porTipo('alimentos'), 'importe_cent');
  const garantiaReal = suma(acreedores.filter((a) => ['hipotecaria', 'prendaria'].includes(a.garantia)), 'importe_cent');
  // art. 489.1.5º TRLC: el límite se aplica por separado a la AEAT y a la Seguridad Social.
  const publicoNoExonerable = aeat - Math.round(exonerablePublico(aeat / 100, limite) * 100) + tgss - Math.round(exonerablePublico(tgss / 100, limite) * 100);

  const activo = suma(bienes, 'valor_mercado_cent');
  const embargables = bienes.filter((b) => b.embargable === true);
  const pendientesEmbargabilidad = bienes.filter((b) => b.embargable == null).length;
  const libreEmbargable = embargables.reduce((s, b) => s + Math.max(0, (b.valor_mercado_cent ?? 0) - (b.cargas_cent ?? 0)), 0);
  const costeCent = (datosPreparacion(ctx, expediente).costePrevistoEuros ?? null) == null ? null : Math.round(datosPreparacion(ctx, expediente).costePrevistoEuros * 100);

  const sinMasa = [];
  if (bienes.length > 0 && pendientesEmbargabilidad === 0) {
    if (embargables.length === 0) sinMasa.push({ letra: 'a', texto: 'No consta ningún bien o derecho embargable.' });
    else {
      if (costeCent != null && libreEmbargable < costeCent) sinMasa.push({ letra: 'c', texto: 'Los bienes libres de cargas valen menos que el coste previsto del procedimiento.' });
      if (embargables.every((b) => (b.cargas_cent ?? 0) > (b.valor_mercado_cent ?? 0))) sinMasa.push({ letra: 'd', texto: 'Las cargas superan el valor de mercado de los bienes.' });
    }
  } else if (bienes.length === 0) {
    sinMasa.push({ letra: 'a', texto: 'No hay bienes inventariados todavía: compruebe el inventario antes de concluir.' });
  }

  return {
    acreedores: acreedores.length,
    bienes: bienes.length,
    pasivoCent: pasivo,
    aeatCent: aeat,
    seguridadSocialCent: tgss,
    publicoNoExonerableCent: publicoNoExonerable,
    alimentosCent: alimentos,
    garantiaRealCent: garantiaReal,
    exonerableEstimadoCent: Math.max(0, pasivo - publicoNoExonerable - alimentos - garantiaReal),
    activoCent: activo,
    libreEmbargableCent: libreEmbargable,
    pendientesEmbargabilidad,
    indiciosSinMasa: sinMasa,
  };
}

/** Lo que falta para poder presentar, con la norma que lo exige. */
export function comprobaciones(ctx, expediente) {
  const datos = datosPreparacion(ctx, expediente);
  const acreedores = ctx.store.partidas('acreedores', expediente.id);
  const bienes = ctx.store.partidas('bienes', expediente.id);
  const faltas = [];
  const falta = (texto, base) => faltas.push({ texto, base });

  if (expediente.estado !== 'documentacion_completa') falta('La documentación del cliente no está completa y validada.', 'módulo 4');
  if (acreedores.length === 0) falta('No hay acreedores en la relación.', 'art. 7.3º TRLC');
  for (const a of acreedores) {
    const nombre = a.nombre ?? '(sin nombre)';
    if (!a.revisado) falta(`Acreedor «${nombre}» sin revisar.`, 'revisión del abogado');
    const vacios = [['nombre', a.nombre], ['domicilio', a.domicilio], ['importe', a.importe_cent], ['vencimiento', a.vencimiento]].filter(([, v]) => v == null || v === '').map(([k]) => k);
    if (vacios.length) falta(`Acreedor «${nombre}»: falta ${vacios.join(', ')}.`, 'art. 7.3º TRLC');
    if (a.garantia !== 'ninguna' && !a.garantia_detalle) falta(`Acreedor «${nombre}»: describa la garantía.`, 'art. 7.3º TRLC');
  }
  for (const b of bienes) {
    const nombre = b.descripcion ?? '(sin descripción)';
    if (!b.revisado) falta(`Bien «${nombre}» sin revisar.`, 'revisión del abogado');
    if (b.valor_mercado_cent == null) falta(`Bien «${nombre}»: falta la estimación del valor de mercado.`, 'art. 7.2º TRLC');
    if (b.tipo === 'inmueble' && !b.datos_registrales) falta(`Bien «${nombre}»: faltan los datos registrales.`, 'art. 7.2º TRLC');
    if (b.embargable == null) falta(`Bien «${nombre}»: indique si es embargable.`, 'art. 37 bis TRLC');
  }
  if (!datos.historia) falta('Memoria: falta la historia económica y jurídica.', 'art. 7.1º TRLC');
  if (!datos.actividad) falta('Memoria: falta la actividad de los tres últimos años.', 'art. 7.1º TRLC');
  if (!datos.causas) falta('Memoria: faltan las causas de la insolvencia.', 'art. 7.1º TRLC');
  if (['casado', 'pareja_inscrita'].includes(expediente.datos?.estado_civil) && !expediente.datos?.conyuge_nombre) {
    falta('Memoria: faltan los datos del cónyuge o pareja.', 'art. 7.1º TRLC');
  }
  if (!datos.tribunal) falta('Indique el órgano competente.', 'arts. 44 y 45 TRLC; art. 87 LOPJ');
  if (!datos.ruta) falta('Elija la vía: concurso sin masa, plan de pagos o liquidación.', 'arts. 37 bis, 486 y 501 TRLC');
  if (!datos.procurador) falta('Indique el procurador.', 'arts. 6.2 y 510 TRLC');
  return faltas;
}

export function resumenPreparacion(ctx, expediente) {
  const lead = ctx.store.lead(expediente.lead_id);
  return {
    expediente: { id: expediente.id, estado: expediente.estado, datos: expediente.datos },
    cliente: { id: lead.id, nombre: lead.nombre, provincia: lead.provincia, respuestas: lead.respuestas },
    preparacion: datosPreparacion(ctx, expediente),
    acreedores: ctx.store.partidas('acreedores', expediente.id),
    bienes: ctx.store.partidas('bienes', expediente.id),
    indicadores: indicadores(ctx, expediente),
    faltas: comprobaciones(ctx, expediente),
    ia: iaDisponible(ctx.config),
    extracciones: ctx.store.extraccionesDeExpediente(expediente.id),
    archivos: ctx.store.documentosDeExpediente(expediente.id).flatMap((d) => ctx.store.archivosDeDocumento(d.id).map((a) => ({
      id: a.id, nombre: a.nombre, tipo_mime: a.tipo_mime, documento: d.clave,
    }))),
  };
}

export function marcarListo(ctx, expedienteId, listo) {
  const expediente = expedienteParaPreparar(ctx, expedienteId);
  if (listo) {
    const faltas = comprobaciones(ctx, expediente);
    if (faltas.length) throw Object.assign(new ErrorValidacion(`Faltan ${faltas.length} puntos antes de presentar.`), { faltas });
    ctx.store.guardarPreparacion(expediente.id, { listo: ctx.store.ahora() });
    ctx.store.registrarEvento(expediente.lead_id, 'expediente_listo', { expedienteId: expediente.id });
    ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: 'Expediente listo para presentar' } }, expediente.lead_id);
  } else {
    ctx.store.guardarPreparacion(expediente.id, { listo: null });
    ctx.store.registrarEvento(expediente.lead_id, 'expediente_reabierto', { expedienteId: expediente.id });
  }
  return datosPreparacion(ctx, ctx.store.expediente(expediente.id));
}

// ---------------- Extracción con IA ----------------

export function solicitarExtraccion(ctx, expedienteId, archivoId) {
  if (!iaDisponible(ctx.config)) throw new ErrorValidacion('La extracción automática no está activada (IA_EXTRACCION=activada).');
  const expediente = expedienteParaPreparar(ctx, expedienteId);
  exigirEditable(ctx, expediente);
  const archivo = ctx.store.archivo(archivoId);
  const documento = archivo && ctx.store.documento(archivo.documento_id);
  if (!archivo || archivo.eliminado || documento?.expediente_id !== expediente.id) throw noEncontrado();
  const enCurso = ctx.store.extraccionesDeExpediente(expediente.id).find((x) => x.archivo_id === archivoId && x.estado === 'pendiente');
  if (enCurso) return enCurso;
  const extraccion = ctx.store.crearExtraccion(archivoId, expediente.id);
  ctx.store.programar('extraer_ia', ctx.reloj(), { extraccionId: extraccion.id }, expediente.lead_id);
  return extraccion;
}

/** Tarea programada: analiza el archivo y añade las propuestas como partidas pendientes de revisión. */
export async function ejecutarExtraccion(ctx, extraccionId, intentosPrevios = 0) {
  const extraccion = ctx.store.extraccion(extraccionId);
  if (!extraccion || extraccion.estado !== 'pendiente') return 'omitida';
  const archivo = ctx.store.archivo(extraccion.archivo_id);
  const documento = ctx.store.documento(archivo.documento_id);
  const def = ctx.config.documentos.documentos.find((d) => d.clave === documento.clave);
  try {
    const contenido = await ctx.almacen.leer(archivo);
    const salida = await extraerDatos(ctx.ia, { contenido, tipoMime: archivo.tipo_mime, claveDocumento: documento.clave, tituloDocumento: def?.titulo ?? documento.clave });
    const filas = filasDesdeExtraccion(salida, archivo.id);
    for (const fila of filas.acreedores) ctx.store.crearPartida('acreedores', extraccion.expediente_id, fila);
    for (const fila of filas.bienes) ctx.store.crearPartida('bienes', extraccion.expediente_id, fila);
    ctx.store.terminarExtraccion(extraccion.id, {
      estado: 'completada', resumen: { acreedores: filas.acreedores.length, bienes: filas.bienes.length, observaciones: salida.observaciones, modelo: salida.modelo },
    });
    const expediente = ctx.store.expediente(extraccion.expediente_id);
    ctx.store.registrarEvento(expediente.lead_id, 'extraccion_ia', { archivoId: archivo.id, acreedores: filas.acreedores.length, bienes: filas.bienes.length });
    return 'completada';
  } catch (error) {
    // Los fallos transitorios (red, saturación) se reintentan unas cuantas veces; el resto queda registrado para hacerlo a mano.
    const transitorio = error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.RateLimitError
      || (error instanceof Anthropic.APIError && error.status >= 500);
    if (transitorio && intentosPrevios < 4) throw error;
    ctx.store.terminarExtraccion(extraccion.id, { estado: 'error', error: textoCorto(error.message, 500) });
    return 'error';
  }
}
