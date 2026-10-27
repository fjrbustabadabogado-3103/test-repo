/**
 * Semáforo de cualificación para expedientes de exoneración del pasivo insatisfecho.
 *
 * Es una ayuda de triaje comercial, no un dictamen: los casos amarillos los revisa un abogado
 * y la viabilidad se confirma en la consulta (art. 48.3 EGAE).
 *
 * Bases legales (TRLC, RDL 1/2020, redacción Ley 16/2022):
 *  - art. 486: solo el deudor persona natural de buena fe.
 *  - art. 487: excepciones (condenas, sanciones muy graves, derivación de responsabilidad... en los 10 años anteriores),
 *              salvo que se haya satisfecho la responsabilidad: por eso se marca para revisión y no se descarta.
 *  - art. 488: plazos para una nueva exoneración (2 años tras plan de pagos, 5 tras liquidación).
 *  - art. 489: deudas no exonerables (alimentos, garantía real, crédito público por encima del límite...).
 */

export const NIVEL = { ROJO: 'rojo', AMARILLO: 'amarillo', INFO: 'info' };

/** Importe exonerable de un crédito público (AEAT o Seguridad Social) según el art. 489.1.5º TRLC. */
export function exonerablePublico(deuda, limite) {
  const importe = Math.max(0, deuda ?? 0);
  const { tramoIntegroEuros, porcentajeTramoSiguiente, maximoEuros } = limite;
  if (importe <= tramoIntegroEuros) return importe;
  const tramo2 = ((importe - tramoIntegroEuros) * porcentajeTramoSiguiente) / 100;
  return Math.min(maximoEuros, tramoIntegroEuros + tramo2);
}

/**
 * @param {object} r respuestas normalizadas del formulario
 * @param {object} reglas config/cualificacion.json
 */
export function evaluar(r, reglas) {
  const motivos = [];
  const anadir = (nivel, codigo, texto, base = null) => motivos.push({ nivel, codigo, texto, base });

  const deudaTotal = r.deuda_total ?? null;
  const hacienda = r.deuda_hacienda ?? 0;
  const seguridadSocial = r.deuda_seguridad_social ?? 0;

  if (r.tipo_deudor === 'sociedad') {
    anadir(NIVEL.ROJO, 'persona_juridica',
      'La deuda es de una sociedad: la exoneración del pasivo insatisfecho es solo para personas naturales. Derivar a concurso de persona jurídica si interesa.',
      'art. 486 TRLC');
  }

  if (deudaTotal == null) {
    anadir(NIVEL.AMARILLO, 'deuda_desconocida', 'No ha indicado el importe de la deuda.');
  } else if (deudaTotal < reglas.deudaMinimaEuros) {
    anadir(NIVEL.ROJO, 'deuda_baja',
      `Deuda declarada (${deudaTotal} €) por debajo del umbral comercial del despacho (${reglas.deudaMinimaEuros} €). Valorar negociación extrajudicial.`,
      'criterio comercial configurable');
  }

  if (r.num_acreedores != null && r.num_acreedores < reglas.acreedoresMinimos) {
    anadir(NIVEL.AMARILLO, 'pocos_acreedores',
      `Declara ${r.num_acreedores} acreedor(es). Revisar la conveniencia del concurso frente a otras vías.`,
      'criterio configurable del despacho');
  }

  if (r.antecedentes === true) {
    anadir(NIVEL.AMARILLO, 'antecedentes',
      'Declara condena o sanción grave en los últimos 10 años. Comprobar si encaja en las excepciones y si la responsabilidad está satisfecha.',
      'art. 487.1 TRLC');
  }

  if (r.exoneracion_previa === true) {
    anadir(NIVEL.AMARILLO, 'exoneracion_previa',
      'Ya obtuvo una exoneración anteriormente. Comprobar los plazos (2 años tras plan de pagos, 5 tras liquidación); el crédito público no se exonera en las sucesivas.',
      'arts. 488 y 489.3 TRLC');
  }

  if (r.deuda_alimentos === true) {
    anadir(NIVEL.INFO, 'alimentos', 'Tiene deudas por alimentos: no son exonerables.', 'art. 489.1.3º TRLC');
  }

  if (r.vivienda_hipotecada === true) {
    anadir(NIVEL.INFO, 'vivienda',
      'Vivienda hipotecada: la deuda con garantía real no se exonera dentro del límite del privilegio. Valorar el plan de pagos sin liquidación para intentar conservarla.',
      'arts. 486.1º y 489.1.8º TRLC');
  }

  const exonerableHacienda = exonerablePublico(hacienda, reglas.limiteExoneracionPublica);
  const exonerableSS = exonerablePublico(seguridadSocial, reglas.limiteExoneracionPublica);
  const publicoNoExonerable = hacienda - exonerableHacienda + (seguridadSocial - exonerableSS);
  if (publicoNoExonerable > 0) {
    anadir(NIVEL.INFO, 'credito_publico',
      `Aprox. ${Math.round(publicoNoExonerable)} € de deuda con Hacienda o Seguridad Social quedarían fuera de la exoneración.`,
      'art. 489.1.5º TRLC');
  }

  let porcentajeExonerable = null;
  if (deudaTotal != null && deudaTotal > 0) {
    const exonerableEstimado = Math.max(0, deudaTotal - publicoNoExonerable);
    porcentajeExonerable = Math.round((exonerableEstimado / deudaTotal) * 100);
    if (porcentajeExonerable < reglas.porcentajeMinimoExonerable) {
      anadir(NIVEL.AMARILLO, 'poco_exonerable',
        `Solo un ${porcentajeExonerable} % de la deuda declarada parece exonerable. Revisar si compensa el procedimiento.`,
        'art. 489 TRLC');
    }
  }

  if (r.ingresos_mensuales != null) {
    anadir(NIVEL.INFO, 'ingresos',
      r.ingresos_mensuales > 0
        ? `Ingresos declarados: ${r.ingresos_mensuales} €/mes. Considerar la viabilidad de un plan de pagos.`
        : 'Sin ingresos declarados: previsible concurso sin masa con liquidación.',
      'arts. 37 bis, 486 y 496 TRLC');
  }

  let puntuacion = 100;
  for (const m of motivos) {
    if (m.nivel === NIVEL.ROJO) puntuacion -= 60;
    if (m.nivel === NIVEL.AMARILLO) puntuacion -= 20;
  }
  if (deudaTotal != null) puntuacion += Math.min(15, Math.floor(deudaTotal / 10000) * 3);
  puntuacion = Math.max(0, Math.min(100, puntuacion));

  const semaforo = motivos.some((m) => m.nivel === NIVEL.ROJO)
    ? 'rojo'
    : motivos.some((m) => m.nivel === NIVEL.AMARILLO) ? 'amarillo' : 'verde';

  return {
    semaforo,
    puntuacion,
    motivos,
    estimacion: {
      exonerableHacienda,
      exonerableSeguridadSocial: exonerableSS,
      publicoNoExonerable,
      porcentajeExonerable,
    },
  };
}
