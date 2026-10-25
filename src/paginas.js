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

/** Portal del cliente para aportar la documentación del expediente (módulo 4). */
export function paginaExpediente(ctx, expediente) {
  const { config } = ctx;
  const lead = ctx.store.lead(expediente.lead_id);
  const datos = `<script type="application/json" id="datos-expediente">${JSON.stringify({ token: expediente.token }).replace(/</g, '\\u003c')}</script>`;
  return layout(config, 'Documentación de su expediente', `
<section class="tarjeta">
<h1>Documentación de su expediente</h1>
<p class="subtitulo">Hola ${e((lead.nombre ?? '').split(' ')[0])}. Con estos documentos preparamos su solicitud. Puede subir fotos hechas con el móvil o archivos PDF, en varias veces: lo que suba queda guardado y cifrado.</p>
<div class="progreso" aria-hidden="true"><div class="progreso-barra" id="barra"></div></div>
<p class="estado" id="estado-general" role="status">Cargando…</p>
</section>
<section class="tarjeta oculto" id="bloque-seguimiento">
<h2>Estado de su procedimiento</h2>
<p class="subtitulo" id="estado-procedimiento"></p>
<ul class="linea-tiempo" id="actuaciones-cliente"></ul>
</section>
<section class="tarjeta" id="bloque-datos">
<h2>1. Sus datos</h2>
<p class="nota">Los necesitamos para la memoria que acompaña a la solicitud y para saber qué documentos le corresponden.</p>
<form id="form-datos" novalidate>
<label class="campo">Domicilio completo (calle, número, piso, código postal y municipio)<input name="domicilio" required maxlength="300" autocomplete="street-address"></label>
<div class="rejilla">
<label class="campo">Estado civil<select name="estado_civil" required>
<option value="">Elija…</option><option value="soltero">Soltero/a</option><option value="casado">Casado/a</option><option value="pareja_inscrita">Pareja de hecho inscrita</option><option value="separado_divorciado">Separado/a o divorciado/a</option><option value="viudo">Viudo/a</option>
</select></label>
<label class="campo">Situación laboral<select name="situacion_laboral" required>
<option value="">Elija…</option><option value="asalariado">Trabajo por cuenta ajena</option><option value="autonomo">Autónomo/a</option><option value="desempleado">En desempleo</option><option value="pensionista">Pensionista</option><option value="otro">Otra</option>
</select></label>
<label class="campo">Personas a su cargo<input name="personas_a_cargo" type="number" min="0" max="20" value="0"></label>
</div>
<div class="rejilla" id="bloque-conyuge">
<label class="campo">Nombre del cónyuge o pareja<input name="conyuge_nombre" maxlength="120"></label>
<label class="campo">Fecha de matrimonio o inscripción<input name="fecha_matrimonio" type="date"></label>
<label class="campo">Régimen económico<select name="regimen_economico">
<option value="">Elija…</option><option value="gananciales">Gananciales</option><option value="separacion">Separación de bienes</option><option value="participacion">Participación</option><option value="otro">Otro</option><option value="no_sabe">No lo sé</option>
</select></label>
</div>
<fieldset><legend>¿Tiene algún inmueble a su nombre (vivienda, local, terreno), aunque sea en parte?</legend><div class="opciones"><label><input type="radio" name="tiene_inmuebles" value="si"> Sí</label><label><input type="radio" name="tiene_inmuebles" value="no" checked> No</label></div></fieldset>
<fieldset><legend>¿Tiene vehículos a su nombre?</legend><div class="opciones"><label><input type="radio" name="tiene_vehiculos" value="si"> Sí</label><label><input type="radio" name="tiene_vehiculos" value="no" checked> No</label></div></fieldset>
<fieldset><legend>¿Algún acreedor le ha demandado o le está embargando?</legend><div class="opciones"><label><input type="radio" name="procedimientos_judiciales" value="si"> Sí</label><label><input type="radio" name="procedimientos_judiciales" value="no" checked> No</label></div></fieldset>
<label class="campo">¿Cómo llegó a esta situación? (opcional: despido, enfermedad, separación, cierre del negocio…)<textarea name="causas" rows="3" maxlength="2000"></textarea></label>
<p class="estado" id="estado-datos" role="status"></p>
<button class="boton" type="submit">Guardar mis datos</button>
</form>
</section>
<section class="tarjeta">
<h2>2. Sus documentos</h2>
<div id="documentos" class="documentos"></div>
</section>${datos}`, { scripts: ['expediente.js'] });
}

/** Valoración del cliente al terminar: puntuación, comentario, testimonio con autorización separada, reseña y recomendación. */
export function paginaValoracion(ctx, cierre) {
  const datos = `<script type="application/json" id="datos-valoracion">${JSON.stringify({ token: cierre.token }).replace(/</g, '\\u003c')}</script>`;
  return layout(ctx.config, 'Su opinión', `
<section class="tarjeta" id="bloque-formulario">
<h1>¿Cómo le hemos atendido?</h1>
<p class="subtitulo">Su opinión nos ayuda a mejorar. Todas las respuestas son voluntarias.</p>
<form id="form-valoracion" novalidate>
<fieldset><legend>Del 0 al 10, ¿con qué probabilidad nos recomendaría a un familiar o amigo?</legend>
<div class="opciones" id="puntuaciones"></div></fieldset>
<label class="campo">¿Qué podríamos mejorar o qué le ha gustado más? (opcional)<textarea name="comentario" rows="3" maxlength="1000"></textarea></label>
<div class="aviso">
<h2>Testimonio (opcional)</h2>
<p>Si quiere, puede escribir unas líneas sobre su experiencia para que otras personas en su situación las lean. Solo lo publicaremos si lo autoriza expresamente.</p>
<label class="campo">Su testimonio<textarea name="testimonio" rows="4" maxlength="1500"></textarea></label>
<label class="campo">Firmar como<select name="firma"><option value="iniciales">Mis iniciales</option><option value="nombre">Mi nombre completo</option><option value="anonimo">Sin nombre («Cliente del despacho»)</option></select></label>
<label class="casilla"><input type="checkbox" name="autoriza"> <span id="texto-consentimiento"></span></label>
</div>
<p class="estado" id="estado-valoracion" role="status"></p>
<button class="boton" type="submit">Enviar</button>
</form>
</section>
<section class="tarjeta oculto" id="bloque-gracias">
<h1>Gracias</h1>
<div id="bloque-resena" class="oculto">
<p>Si quiere contar su experiencia públicamente, puede dejar su opinión en Google. Nos ayuda a que otras personas nos encuentren.</p>
<p><a class="boton" id="enlace-resena" href="#" rel="noopener">Dejar mi opinión en Google</a></p>
</div>
<h2>¿Conoce a alguien en su misma situación?</h2>
<p>Puede compartir este enlace. No le diremos a nadie que usted nos lo ha recomendado.</p>
<p><code id="enlace-referido"></code></p>
<p><a class="boton secundario" id="compartir-whatsapp" href="#" rel="noopener" target="_blank">Compartir por WhatsApp</a></p>
<div id="bloque-testimonio" class="oculto">
<h2>Su testimonio</h2>
<p id="texto-testimonio"></p>
<p class="nota" id="estado-testimonio"></p>
<button class="boton peligro pequeno oculto" id="revocar" type="button">Retirar mi autorización</button>
</div>
</section>${datos}`, { scripts: ['valoracion.js'] });
}
