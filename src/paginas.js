import { escaparHtml as e, euros, fechaCorta, fechaLarga, sumarDias } from './util.js';

export function layout(config, titulo, cuerpo, { scripts = [] } = {}) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(titulo)} · ${e(config.despacho.nombreComercial)}</title>
<link rel="stylesheet" href="/static/estilos.css">
</head>
<body>
<header class="cabecera"><a class="marca" href="/">${e(config.despacho.nombreComercial)}</a></header>
<main class="contenedor">${cuerpo}</main>
<footer class="pie"><a href="/privacidad">Privacidad</a> · ${e(config.despacho.titular.colegio)}</footer>
${scripts.map((s) => `<script src="/static/${e(s)}" defer></script>`).join('')}
</body>
</html>`;
}

export function paginaMensaje(config, titulo, texto, enlace = null) {
  return layout(config, titulo, `<section class="tarjeta"><h1>${e(titulo)}</h1><p>${e(texto)}</p>${enlace ? `<p><a class="boton" href="${e(enlace)}">Ver mi hoja de encargo</a></p>` : ''}</section>`);
}

export function paginaPrivacidad(config) {
  const d = config.despacho;
  return layout(config, 'Política de privacidad', `<section class="tarjeta texto">
<h1>Política de privacidad</h1>
<p><strong>Responsable:</strong> ${e(d.titular.nombre)}, NIF ${e(d.titular.nif)}, ${e(d.domicilioProfesional)}. Contacto: ${e(d.protegerDatos.contactoPrivacidad)}.</p>
<p><strong>Finalidad:</strong> atender su consulta sobre la Ley de Segunda Oportunidad, valorar su caso, concertar la consulta de diagnóstico y, si contrata, prestarle el servicio jurídico.</p>
<p><strong>Base jurídica:</strong> la aplicación de medidas precontractuales a petición suya y, en su caso, la ejecución del contrato (art. 6.1.b RGPD). El envío de recordatorios y comunicaciones comerciales se basa en su consentimiento, que puede retirar en cualquier momento respondiendo BAJA (art. 21 LSSI).</p>
<p><strong>Datos tratados:</strong> los de contacto y la información aproximada sobre su situación económica que nos facilita en el cuestionario. Le pedimos solo lo necesario para valorar su caso.</p>
<p><strong>Conservación:</strong> si no llega a contratar, sus datos se anonimizan a los ${e(d.protegerDatos.plazoConservacionLeadsMeses)} meses de la última actividad. Si contrata, se conservan durante el encargo y los plazos legales de prescripción.</p>
<p><strong>Destinatarios:</strong> no se ceden datos a terceros salvo obligación legal. Utilizamos proveedores de mensajería, alojamiento, firma y pago que actúan como encargados del tratamiento con contrato conforme al art. 28 RGPD.</p>
<p><strong>Derechos:</strong> puede ejercer sus derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a ${e(d.protegerDatos.contactoPrivacidad)}, y presentar una reclamación ante la Agencia Española de Protección de Datos (www.aepd.es).</p>
</section>`);
}

/** Página del cliente para revisar, firmar, pagar y, en su caso, desistir. */
export function paginaEncargo(ctx, encargo, pagos, query = {}) {
  const { config } = ctx;
  const zona = config.agenda.zona;
  const lead = ctx.store.lead(encargo.lead_id);
  const datos = `<script type="application/json" id="datos-encargo">${JSON.stringify({
    token: encargo.token, estado: encargo.estado, documentoSha256: encargo.documento_sha256,
  }).replace(/</g, '\\u003c')}</script>`;

  if (encargo.estado === 'caducado') {
    return paginaMensaje(config, 'Propuesta caducada', 'Esta hoja de encargo ha caducado. Responda a nuestro mensaje y le enviaremos una actualizada.');
  }
  if (encargo.estado === 'desistido') {
    return paginaMensaje(config, 'Desistimiento registrado', `Registramos su desistimiento el ${fechaLarga(encargo.desistido, zona)}. Nos pondremos en contacto con usted para el reembolso que corresponda.`);
  }

  if (encargo.estado === 'enviado') {
    const avisoCancelado = query.pago === 'cancelado' ? '<p class="aviso">El pago no se completó. Puede intentarlo de nuevo.</p>' : '';
    return layout(config, 'Hoja de encargo', `${avisoCancelado}
<section class="tarjeta">
<p class="subtitulo">Hola ${e((lead.nombre ?? '').split(' ')[0])}, revise su hoja de encargo. Es válida hasta el ${e(fechaCorta(encargo.caduca))}.</p>
<div class="documento">${encargo.documento_html}</div>
</section>
<section class="tarjeta" id="firma">
<h2>Firma y contratación</h2>
<form id="form-firma" novalidate>
<label class="campo">Nombre y apellidos<input name="nombre" autocomplete="name" required maxlength="120" value="${e(lead.nombre ?? '')}"></label>
<label class="campo">DNI o NIE<input name="dni" required maxlength="12" autocomplete="off"></label>
<label class="casilla"><input type="checkbox" name="aceptaHoja" required> He leído y acepto la hoja de encargo y la información precontractual.</label>
<label class="casilla"><input type="checkbox" name="inicioInmediato"> <span><strong>Opcional:</strong> solicito expresamente que el despacho empiece a trabajar ya, durante el plazo de desistimiento de 14 días. Sé que, si desisto, pagaré la parte proporcional del trabajo ya realizado y que, una vez completado el servicio, perderé el derecho de desistimiento (arts. 98.8, 103.a y 108.4 TRLGDCU). Si no la marca, empezaremos al terminar ese plazo.</span></label>
<label class="casilla"><input type="checkbox" name="aceptaPago" required> Entiendo que la contratación implica una obligación de pago de ${e(euros(encargo.honorarios_cent))} en los plazos indicados.</label>
<div class="fila-codigo">
<button type="button" class="boton secundario" id="pedir-codigo">Enviarme el código de firma</button>
<label class="campo">Código recibido<input name="codigo" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code"></label>
</div>
<p class="estado" id="estado-firma" role="status"></p>
<button type="submit" class="boton">Firmar: pedido con obligación de pago</button>
</form>
<p class="nota">Huella del documento (SHA-256): <code>${e(encargo.documento_sha256)}</code></p>
</section>${datos}`, { scripts: ['encargo.js'] });
  }

  const limiteDesistimiento = encargo.firmado ? sumarDias(encargo.firmado, 14) : null;
  const puedeDesistir = limiteDesistimiento && ctx.reloj() <= limiteDesistimiento;
  const pagable = (p) => p.estado !== 'pagado' && p.estado !== 'procesando' && (p.tipo === 'entrada' || p.estado === 'fallido');
  const filas = pagos.map((p) => `<tr><td>${p.tipo === 'entrada' ? 'Entrada' : `Cuota ${p.numero}`}</td><td>${e(fechaCorta(p.vencimiento))}</td><td class="num">${e(euros(p.importe_cent))}</td>
<td>${pagable(p) ? `<button class="boton pequeno" data-pagar="${e(p.id)}">Pagar ahora</button>` : e({ pagado: 'Pagado', procesando: 'En proceso', fallido: 'Fallido', enlace_enviado: 'Pendiente', pendiente: 'Programado' }[p.estado] ?? p.estado)}</td></tr>`).join('');

  return layout(config, 'Mi hoja de encargo', `
<section class="tarjeta">
<h1>${encargo.estado === 'firmado' ? 'Falta completar el pago de la entrada' : 'Su encargo está activo'}</h1>
<p>Firmada el ${e(fechaLarga(encargo.firmado, zona))} por ${e(encargo.evidencia_firma?.nombre)}.
${encargo.inicio_inmediato ? 'Solicitó que empezáramos a trabajar de inmediato.' : `Empezaremos a trabajar el ${e(fechaLarga(encargo.fecha_inicio_servicio, zona))}, al terminar el plazo de desistimiento.`}</p>
<div class="tabla-scroll"><table class="plan"><thead><tr><th>Concepto</th><th>Vencimiento</th><th class="num">Importe</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table></div>
<p class="estado" id="estado-pago" role="status"></p>
</section>
<details class="tarjeta"><summary>Ver la hoja de encargo firmada</summary><div class="documento">${encargo.documento_html}</div></details>
${puedeDesistir ? `<section class="tarjeta">
<h2>Derecho de desistimiento</h2>
<p>Puede desistir hasta el ${e(fechaLarga(limiteDesistimiento.toISOString(), zona))} sin indicar el motivo.</p>
<label class="casilla"><input type="checkbox" id="confirmo-desistir"> Confirmo que deseo desistir de este contrato.</label>
<button class="boton peligro" id="desistir">Desistir del contrato</button>
</section>` : ''}${datos}`, { scripts: ['encargo.js'] });
}
