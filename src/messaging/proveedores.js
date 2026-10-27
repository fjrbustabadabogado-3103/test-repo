/**
 * Proveedores de envío. Sin credenciales se usa el modo "consola": el mensaje se guarda en la bandeja
 * de salida (tabla `salida`) y se escribe en el log, de modo que todo el flujo funciona en local.
 */

export function crearWhatsapp(config, { fetchImpl = fetch, log = console } = {}) {
  const { token, phoneNumberId, idioma } = config.whatsapp;
  if (!token || !phoneNumberId) {
    return {
      nombre: 'consola',
      async enviarPlantilla({ destino, plantilla, texto }) {
        log.info?.(`[whatsapp:consola] → ${destino} (${plantilla}): ${texto}`);
        return { estado: 'simulado' };
      },
    };
  }
  const url = `https://graph.facebook.com/${config.meta.graphVersion}/${phoneNumberId}/messages`;
  return {
    nombre: 'whatsapp_cloud',
    /** Los mensajes iniciados por la empresa fuera de la ventana de 24 h deben ser plantillas aprobadas por Meta. */
    async enviarPlantilla({ destino, plantilla, parametros }) {
      const cuerpo = {
        messaging_product: 'whatsapp',
        to: destino,
        type: 'template',
        template: {
          name: plantilla,
          language: { code: idioma },
          components: parametros.length
            ? [{ type: 'body', parameters: parametros.map((p) => ({ type: 'text', text: String(p).slice(0, 1000) })) }]
            : [],
        },
      };
      const respuesta = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const datos = await respuesta.json().catch(() => ({}));
      if (!respuesta.ok) throw new Error(`WhatsApp ${respuesta.status}: ${JSON.stringify(datos.error ?? datos)}`);
      return { estado: 'enviado', id: datos.messages?.[0]?.id };
    },
  };
}

export function crearEmail(config, { fetchImpl = fetch, log = console } = {}) {
  const { resendApiKey, from } = config.email;
  if (!resendApiKey) {
    return {
      nombre: 'consola',
      async enviar({ destino, asunto, texto }) {
        log.info?.(`[email:consola] → ${destino} | ${asunto}: ${texto.slice(0, 300)}`);
        return { estado: 'simulado' };
      },
    };
  }
  return {
    nombre: 'resend',
    async enviar({ destino, asunto, texto, html }) {
      const respuesta = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [destino], subject: asunto, text: texto, ...(html ? { html } : {}) }),
      });
      const datos = await respuesta.json().catch(() => ({}));
      if (!respuesta.ok) throw new Error(`Email ${respuesta.status}: ${JSON.stringify(datos)}`);
      return { estado: 'enviado', id: datos.id };
    },
  };
}
