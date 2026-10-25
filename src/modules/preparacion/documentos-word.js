import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, PageOrientation,
} from 'docx';
import { euros, fechaCorta } from '../../util.js';
import { datosPreparacion, indicadores } from './preparacion.js';

const ESTADO_CIVIL = {
  soltero: 'soltero/a', casado: 'casado/a', pareja_inscrita: 'pareja de hecho inscrita', separado_divorciado: 'separado/a o divorciado/a', viudo: 'viudo/a',
};
const REGIMEN = {
  gananciales: 'sociedad de gananciales', separacion: 'separación de bienes', participacion: 'participación', otro: 'otro', no_sabe: 'pendiente de determinar',
};
const TIPO_BIEN = { cuenta: 'Cuenta bancaria', inmueble: 'Inmueble', vehiculo: 'Vehículo', salario: 'Salario o pensión', otro: 'Otro' };
const GARANTIA = {
  ninguna: 'Ninguna', hipotecaria: 'Hipotecaria', prendaria: 'Prendaria', personal: 'Personal (avales o fianzas)', reserva_dominio: 'Reserva de dominio', otra: 'Otra',
};

export const TIPOS_DOCUMENTO = {
  memoria: 'Memoria',
  inventario: 'Inventario de bienes y derechos',
  acreedores: 'Relación de acreedores',
  solicitud: 'Solicitud de concurso',
};

const parrafo = (texto, opciones = {}) => new Paragraph({ spacing: { after: 160 }, ...opciones, children: [new TextRun({ text: texto ?? '', ...opciones.run })] });
const titulo = (texto) => new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: texto, bold: true })] });
const apartado = (texto) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: texto, bold: true })] });
const aviso = () => parrafo('BORRADOR generado automáticamente a partir del expediente. Debe revisarlo y completarlo el letrado antes de su presentación.', { run: { italics: true, color: 'A3352B' } });
const lineas = (texto) => String(texto ?? '').split(/\n+/).filter(Boolean).map((l) => parrafo(l));

function tabla(cabeceras, filas) {
  const celda = (texto, negrita = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(texto ?? '—'), bold: negrita, size: 18 })] })] });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: cabeceras.map((c) => celda(c, true)) }),
      ...filas.map((fila) => new TableRow({ children: fila.map((v) => celda(v)) })),
    ],
  });
}

function contexto(ctx, expediente) {
  const lead = ctx.store.lead(expediente.lead_id);
  const encargo = ctx.store.encargo(expediente.encargo_id);
  return {
    lead,
    dni: encargo?.evidencia_firma?.dni ?? '[DNI]',
    nombre: encargo?.evidencia_firma?.nombre ?? lead.nombre,
    datos: expediente.datos ?? {},
    prep: datosPreparacion(ctx, expediente),
    acreedores: ctx.store.partidas('acreedores', expediente.id),
    bienes: ctx.store.partidas('bienes', expediente.id),
    ind: indicadores(ctx, expediente),
    despacho: ctx.config.despacho,
  };
}

function memoria(c) {
  const familia = [`Estado civil: ${ESTADO_CIVIL[c.datos.estado_civil] ?? '[completar]'}.`];
  if (['casado', 'pareja_inscrita'].includes(c.datos.estado_civil)) {
    familia.push(`${c.datos.estado_civil === 'casado' ? 'Cónyuge' : 'Pareja inscrita'}: ${c.datos.conyuge_nombre ?? '[completar]'}. Fecha del ${c.datos.estado_civil === 'casado' ? 'matrimonio' : 'registro'}: ${c.datos.fecha_matrimonio ? fechaCorta(c.datos.fecha_matrimonio) : '[completar]'}.`);
    if (c.datos.estado_civil === 'casado') familia.push(`Régimen económico matrimonial: ${REGIMEN[c.datos.regimen_economico] ?? '[completar]'}${c.datos.regimen_economico === 'separacion' ? '; indicar, en su caso, la fecha de las capitulaciones matrimoniales' : ''}.`);
  }
  familia.push(`Personas a su cargo: ${c.datos.personas_a_cargo ?? 0}.`);
  return [
    aviso(),
    titulo('MEMORIA EXPRESIVA DE LA HISTORIA ECONÓMICA Y JURÍDICA DEL DEUDOR'),
    parrafo('(Artículo 7.1º del Texto Refundido de la Ley Concursal)', { alignment: AlignmentType.CENTER }),
    apartado('1. Identificación del deudor'),
    parrafo(`${c.nombre}, con DNI/NIE ${c.dni}, con domicilio en ${c.datos.domicilio ?? '[completar]'}.`),
    apartado('2. Situación personal y familiar'),
    ...familia.map((t) => parrafo(t)),
    apartado('3. Historia económica y jurídica'),
    ...(c.prep.historia ? lineas(c.prep.historia) : [parrafo('[Completar]')]),
    apartado('4. Actividad durante los tres últimos años'),
    ...(c.prep.actividad ? lineas(c.prep.actividad) : [parrafo('[Completar]')]),
    apartado('5. Establecimientos, oficinas y explotaciones'),
    ...(c.prep.establecimientos ? lineas(c.prep.establecimientos) : [parrafo('[Completar]')]),
    apartado('6. Causas del estado de insolvencia'),
    ...(c.prep.causas ? lineas(c.prep.causas) : [parrafo('[Completar]')]),
    apartado('7. Resumen patrimonial'),
    parrafo(`Pasivo según la relación de acreedores: ${euros(c.ind.pasivoCent)} (${c.ind.acreedores} acreedores). Activo según el inventario: ${euros(c.ind.activoCent)}.`),
  ];
}

function inventario(c) {
  const filas = c.bienes.map((b) => [
    TIPO_BIEN[b.tipo] ?? b.tipo, b.descripcion, b.ubicacion, b.datos_registrales,
    b.valor_adquisicion_cent == null ? '—' : euros(b.valor_adquisicion_cent), b.valor_mercado_cent == null ? '—' : euros(b.valor_mercado_cent),
    [b.cargas, b.cargas_cent != null ? euros(b.cargas_cent) : null].filter(Boolean).join(' · ') || 'Sin cargas',
  ]);
  return [
    aviso(),
    titulo('INVENTARIO DE BIENES Y DERECHOS'),
    parrafo(`(Artículo 7.2º del Texto Refundido de la Ley Concursal) · Deudor: ${c.nombre}, DNI/NIE ${c.dni}`, { alignment: AlignmentType.CENTER }),
    c.bienes.length
      ? tabla(['Naturaleza', 'Características', 'Lugar', 'Datos registrales', 'Valor de adquisición', 'Valor de mercado estimado', 'Derechos, gravámenes y cargas'], filas)
      : parrafo('El deudor manifiesta no ser titular de bienes ni derechos distintos de los que se indican en la memoria. [Revisar]'),
    parrafo(''),
    parrafo(`Valor de mercado total estimado: ${euros(c.ind.activoCent)}.`, { run: { bold: true } }),
    parrafo('Correcciones valorativas: [indicar las que procedan].'),
  ];
}

function relacionAcreedores(c) {
  const filas = c.acreedores.map((a, i) => [
    i + 1, [a.nombre, a.nif ? `NIF ${a.nif}` : null].filter(Boolean).join(' · '), [a.domicilio, a.email].filter(Boolean).join(' · '),
    a.concepto, a.importe_cent == null ? '—' : euros(a.importe_cent), a.vencimiento ? fechaCorta(a.vencimiento) : '—',
    [GARANTIA[a.garantia] ?? a.garantia, a.garantia_detalle].filter(Boolean).join(': '), a.procedimiento_judicial ?? 'No consta',
  ]);
  return [
    aviso(),
    titulo('RELACIÓN DE ACREEDORES'),
    parrafo(`(Artículo 7.3º del Texto Refundido de la Ley Concursal) · Deudor: ${c.nombre}, DNI/NIE ${c.dni}`, { alignment: AlignmentType.CENTER }),
    tabla(['N.º', 'Acreedor', 'Domicilio y dirección electrónica', 'Concepto', 'Cuantía', 'Vencimiento', 'Garantías', 'Reclamación judicial y estado'], filas),
    parrafo(''),
    parrafo(`Total pasivo: ${euros(c.ind.pasivoCent)}.`, { run: { bold: true } }),
  ];
}

function solicitud(c) {
  const t = c.despacho.titular;
  const vias = {
    sin_masa: 'De la documentación aportada resulta que concurren los supuestos del concurso sin masa (art. 37 bis TRLC), por lo que se interesa que se declare en esos términos, con el llamamiento a los acreedores previsto en el art. 37 ter TRLC. Transcurrido el plazo sin solicitud de nombramiento de administrador concursal, esta parte solicitará la exoneración del pasivo insatisfecho (arts. 486 y 501 TRLC).',
    plan_pagos: 'Esta parte tiene intención de solicitar la exoneración del pasivo insatisfecho con sujeción a un plan de pagos, sin previa liquidación de la masa activa (art. 486.1º TRLC).',
    liquidacion: 'Esta parte tiene intención de solicitar la exoneración del pasivo insatisfecho tras la liquidación de la masa activa (art. 486.2º TRLC).',
  };
  const documentos = [
    'Poder especial para solicitar el concurso (art. 6.2 TRLC).',
    'Memoria expresiva de la historia económica y jurídica del deudor (art. 7.1º TRLC).',
    'Inventario de bienes y derechos (art. 7.2º TRLC).',
    'Relación de acreedores (art. 7.3º TRLC).',
    'Declaraciones del IRPF de los tres últimos años (art. 501.3 TRLC).',
    'Documentación acreditativa del estado de insolvencia: certificados de la AEAT y de la Seguridad Social, informe CIRBE y reclamaciones de los acreedores.',
    'Certificado de empadronamiento (art. 45 TRLC).',
  ];
  return [
    aviso(),
    parrafo('Comprobar si la solicitud debe presentarse en el modelo oficial al que se refiere el art. 6.2 TRLC y, en su caso, trasladar a él este contenido.', { run: { italics: true, color: 'A3352B' } }),
    parrafo(`A LA ${(c.prep.tribunal || 'SECCIÓN DE LO MERCANTIL DEL TRIBUNAL DE INSTANCIA DE [CAPITAL DE PROVINCIA]').toUpperCase()}`, { run: { bold: true } }),
    parrafo(`${c.prep.procurador || '[Procurador/a]'}, Procurador/a de los Tribunales, en nombre y representación de ${c.nombre}, mayor de edad, con DNI/NIE ${c.dni} y domicilio en ${c.datos.domicilio ?? '[domicilio]'}, según acredito mediante ${c.prep.poder || 'poder especial [notarial / apud acta]'}, bajo la dirección letrada de ${t.nombre}, colegiado/a n.º ${t.numeroColegiado} del ${t.colegio}, ante el juzgado comparezco y, como mejor proceda en Derecho, DIGO:`),
    parrafo(`Que, por medio del presente escrito, solicito la declaración de concurso voluntario de mi representado/a, persona natural, con base en los siguientes`),
    apartado('HECHOS'),
    parrafo(`PRIMERO. Estado de insolvencia. Mi representado/a se encuentra en estado de insolvencia actual, pues no puede cumplir regularmente sus obligaciones exigibles (art. 2.3 TRLC). Su pasivo asciende a ${euros(c.ind.pasivoCent)}, frente a ${c.ind.acreedores} acreedores, según la relación que se acompaña, y su activo se estima en ${euros(c.ind.activoCent)}.`),
    parrafo(`SEGUNDO. Competencia. Mi representado/a tiene su domicilio y el centro de sus intereses principales en ${c.datos.domicilio ?? '[domicilio]'} (art. 45 TRLC), dentro del ámbito de la sección a la que me dirijo (art. 87.7 LOPJ).`),
    parrafo(`TERCERO. Vía. ${vias[c.prep.ruta] ?? '[Indicar la vía: concurso sin masa, plan de pagos o liquidación]'}`),
    parrafo('CUARTO. Documentación. Se acompañan los documentos exigidos por los arts. 6 y 7 TRLC, que se relacionan al final de este escrito.'),
    apartado('FUNDAMENTOS DE DERECHO'),
    parrafo('I. Presupuesto subjetivo y objetivo: arts. 1 y 2 TRLC. II. Legitimación y solicitud del deudor: arts. 3 y 6 TRLC. III. Documentos: art. 7 TRLC. IV. Competencia objetiva y territorial: arts. 44 y 45 TRLC y art. 87.7 LOPJ. V. Representación y defensa: art. 510 TRLC. VI. Exoneración del pasivo insatisfecho: arts. 486 y siguientes TRLC. [Revisar y completar]'),
    parrafo('Por lo expuesto,'),
    parrafo('SUPLICO AL JUZGADO que tenga por presentado este escrito con los documentos que lo acompañan, me tenga por personado/a en la representación que ostento y, previos los trámites legales, declare en concurso voluntario de acreedores a mi representado/a.', { run: { bold: true } }),
    parrafo(`En ${'[lugar]'}, a ${fechaCorta(new Date().toISOString())}.`),
    parrafo('Ldo./Lda.                                                    Proc.'),
    apartado('DOCUMENTOS QUE SE ACOMPAÑAN'),
    ...documentos.map((d, i) => parrafo(`${i + 1}. ${d}`)),
  ];
}

const GENERADORES = { memoria, inventario, acreedores: relacionAcreedores, solicitud };

/** Genera el borrador .docx del tipo indicado. */
export async function generarDocumento(ctx, expediente, tipo) {
  const generador = GENERADORES[tipo];
  if (!generador) throw Object.assign(new Error('Tipo de documento no válido.'), { statusCode: 404 });
  const c = contexto(ctx, expediente);
  const horizontal = tipo === 'inventario' || tipo === 'acreedores';
  const documento = new Document({
    creator: c.despacho.nombreComercial,
    title: `${TIPOS_DOCUMENTO[tipo]} · ${c.nombre}`,
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{
      properties: horizontal ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } } : {},
      children: generador(c),
    }],
  });
  const nombre = `${TIPOS_DOCUMENTO[tipo]} - ${c.nombre}`.replace(/[^\p{L}\p{N} .-]/gu, '').slice(0, 100);
  return { contenido: await Packer.toBuffer(documento), nombre: `${nombre}.docx` };
}
