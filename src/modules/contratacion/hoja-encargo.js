import { escaparHtml as e, euros, fechaCorta, sha256 } from '../../util.js';

const DIAS_MINIMOS_PRIMERA_CUOTA = 28;

/**
 * Calendario de pagos: entrada al firmar y el resto en cuotas mensuales iguales (el redondeo va a la última).
 * @returns {{tipo: 'entrada'|'cuota', numero: number, importe_cent: number, vencimiento: string}[]}
 */
export function calcularPlanPagos({ honorariosCent, entradaCent, numCuotas, desde, diaCobro = 5 }) {
  if (!Number.isInteger(honorariosCent) || honorariosCent <= 0) throw new Error('Honorarios no válidos.');
  if (!Number.isInteger(entradaCent) || entradaCent <= 0 || entradaCent > honorariosCent) throw new Error('La entrada debe ser mayor que 0 y no superar los honorarios.');
  if (!Number.isInteger(numCuotas) || numCuotas < 0 || numCuotas > 36) throw new Error('El número de cuotas debe estar entre 0 y 36.');
  const resto = honorariosCent - entradaCent;
  if (resto > 0 && numCuotas === 0) throw new Error('Si la entrada no cubre los honorarios, indique el número de cuotas.');

  const inicio = new Date(desde);
  const plan = [{ tipo: 'entrada', numero: 0, importe_cent: entradaCent, vencimiento: inicio.toISOString().slice(0, 10) }];
  if (resto === 0) return plan;
  const base = Math.floor(resto / numCuotas);
  const fechaCuota = (desplazamiento) => {
    const anio = inicio.getUTCFullYear();
    const mes = inicio.getUTCMonth() + desplazamiento;
    const ultimoDia = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
    return new Date(Date.UTC(anio, mes, Math.min(diaCobro, ultimoDia)));
  };
  // La primera cuota nunca cae antes de 28 días desde la emisión (queda fuera del plazo de desistimiento).
  const salto = fechaCuota(1) - inicio < DIAS_MINIMOS_PRIMERA_CUOTA * 86_400_000 ? 1 : 0;
  for (let n = 1; n <= numCuotas; n += 1) {
    const vencimiento = fechaCuota(n + salto).toISOString().slice(0, 10);
    const importe = n === numCuotas ? resto - base * (numCuotas - 1) : base;
    plan.push({ tipo: 'cuota', numero: n, importe_cent: importe, vencimiento });
  }
  return plan;
}

function identificacionDespacho(d) {
  const sp = d.sociedadProfesional;
  const filas = [
    ['Profesional responsable', d.titular.nombre],
    ['NIF', d.titular.nif],
    ['Colegio', d.titular.colegio],
    ['N.º de colegiado/a', d.titular.numeroColegiado],
  ];
  if (sp) {
    filas.push(['Sociedad profesional', `${sp.denominacion} (${sp.forma})`], ['CIF', sp.cif], ['Datos registrales', sp.datosRegistro]);
  }
  filas.push(['Domicilio profesional', d.domicilioProfesional], ['Teléfono', d.telefono], ['Correo electrónico', d.email]);
  return filas.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('');
}

/**
 * Hoja de encargo (art. 48.4 EGAE) con la información precontractual de un contrato a distancia con
 * consumidor (art. 97 TRLGDCU). Es una PLANTILLA BASE: el abogado debe revisarla antes de usarla.
 */
export function renderizarHojaEncargo({ despacho, lead, encargo, plan, fechaConsulta, fechaEmision }) {
  const h = despacho.honorarios;
  const iva = h.preciosIncluyenIva ? `IVA (${h.ivaPorcentaje} %) incluido` : `más el IVA aplicable (${h.ivaPorcentaje} %)`;
  const filasPlan = plan.map((p) => `<tr><td>${p.tipo === 'entrada' ? 'Entrada (a la firma)' : `Cuota ${p.numero}`}</td><td>${e(fechaCorta(p.vencimiento))}</td><td class="num">${e(euros(p.importe_cent))}</td></tr>`).join('');

  return `<article class="hoja-encargo">
<h1>Hoja de encargo profesional</h1>
<p class="ref">Referencia ${e(encargo.id.slice(0, 8).toUpperCase())} · Emitida el ${e(fechaCorta(fechaEmision))}</p>

<h2>1. Partes</h2>
<p><strong>Despacho:</strong> ${e(despacho.nombreComercial)}</p>
<table class="datos">${identificacionDespacho(despacho)}</table>
<p><strong>Cliente:</strong> ${e(lead.nombre)} · Tel. ${e(lead.telefono ?? '—')} · ${e(lead.email ?? '—')}. Sus datos de identificación (DNI/NIE) se recogen en el momento de la firma.</p>

<h2>2. Objeto del encargo</h2>
<p>Asistencia letrada para la obtención de la exoneración del pasivo insatisfecho del cliente como persona natural, conforme al Texto Refundido de la Ley Concursal (RDL 1/2020). Incluye:</p>
<ul>${h.incluye.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
<p>No incluye:</p>
<ul>${h.noIncluye.map((x) => `<li>${e(x)}</li>`).join('')}</ul>

<h2>3. Viabilidad y resultado</h2>
<p>En la consulta de diagnóstico${fechaConsulta ? ` del ${e(fechaCorta(fechaConsulta))}` : ''} el despacho ha informado al cliente sobre la viabilidad del asunto y sobre las deudas que, por ley, no pueden exonerarse (art. 489 TRLC). La concesión de la exoneración corresponde al juzgado: el despacho se compromete a prestar el servicio con la máxima diligencia, pero no garantiza el resultado.</p>

<h2>4. Honorarios y forma de pago</h2>
<p>Honorarios totales: <strong>${e(euros(encargo.honorarios_cent))}</strong>, ${e(iva)}.</p>
<div class="tabla-scroll"><table class="plan"><thead><tr><th>Concepto</th><th>Vencimiento</th><th class="num">Importe</th></tr></thead><tbody>${filasPlan}</tbody></table></div>
<p>Medios de pago: ${e(h.metodosPago)} Las cuotas se cargan automáticamente en la fecha indicada.</p>
<p>${e(h.textoImpago)}</p>

<h2>5. Procurador y gastos</h2>
<p>La ley exige que el deudor actúe representado por procurador (art. 510 TRLC). Sus honorarios y derechos no están incluidos en el apartado anterior. Provisión de fondos estimada para el procurador: <strong>${e(euros(encargo.provision_procurador_cent))}</strong>, que se solicitará antes de presentar la solicitud.</p>

<h2>6. Costas</h2>
<p>${e(h.textoCostas)}</p>

<h2>7. Obligaciones del cliente</h2>
<p>El cliente se compromete a aportar documentación completa y veraz y a informar de cualquier cambio en su situación. Proporcionar información falsa o incumplir los deberes de colaboración e información con el juzgado y la administración concursal impide obtener la exoneración (art. 487.1.5º y 6º TRLC).</p>

<h2>8. Información sobre el asunto</h2>
<p>El despacho informará al cliente del estado del procedimiento y de las resoluciones relevantes, y le facilitará copia de los escritos y resoluciones si la solicita (art. 48.5 EGAE). Todo lo que el cliente comunique está amparado por el secreto profesional.</p>

<h2>9. Derecho de desistimiento</h2>
<p>Al tratarse de un contrato celebrado a distancia, el cliente puede desistir sin indicar el motivo y sin penalización en un plazo de <strong>14 días naturales desde la firma</strong> (art. 104 TRLGDCU), comunicándolo por cualquier medio que deje constancia, por ejemplo a ${e(despacho.email)} o desde el enlace de su hoja de encargo.</p>
<p>Si el cliente solicita expresamente que el despacho empiece a trabajar durante ese plazo y después desiste, deberá abonar la parte proporcional del servicio ya prestado (art. 108.4 TRLGDCU). Una vez que el servicio esté completamente ejecutado se pierde el derecho de desistimiento (art. 103.a TRLGDCU). Si no lo solicita, el trabajo comenzará cuando haya transcurrido el plazo de desistimiento.</p>
<details class="formulario-desistimiento"><summary>Modelo de formulario de desistimiento</summary>
<p>(Solo debe cumplimentar y enviar el presente formulario si desea desistir del contrato.)<br>
– A la atención de ${e(despacho.nombreComercial)}, ${e(despacho.domicilioProfesional)}, ${e(despacho.email)}:<br>
– Por la presente le comunico que desisto de mi contrato de prestación del siguiente servicio: asistencia letrada para la exoneración del pasivo insatisfecho.<br>
– Contratado el: ____<br>
– Nombre del consumidor: ____<br>
– Domicilio del consumidor: ____<br>
– Firma del consumidor (solo si el presente formulario se presenta en papel)<br>
– Fecha: ____</p>
</details>

<h2>10. Protección de datos</h2>
<p>Responsable: ${e(despacho.nombreComercial)} (${e(despacho.titular.nombre)}). Finalidad: prestar el servicio jurídico contratado, gestionar el cobro y cumplir las obligaciones legales. Base jurídica: ejecución del contrato y cumplimiento de obligaciones legales (art. 6.1.b y c RGPD). Los datos se conservarán mientras dure el encargo y, después, durante los plazos de prescripción de las responsabilidades legales. Encargados del tratamiento: proveedores de mensajería, firma y pago con contrato conforme al art. 28 RGPD. Puede ejercer sus derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad en ${e(despacho.protegerDatos.contactoPrivacidad)} y reclamar ante la Agencia Española de Protección de Datos.</p>
</article>`;
}

export function huellaDocumento(html) {
  return sha256(html);
}
