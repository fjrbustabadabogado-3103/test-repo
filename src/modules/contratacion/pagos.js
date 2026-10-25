import { hmacHex, igualSeguro } from '../../util.js';

/**
 * Proveedores de cobro.
 *  - simulado: para desarrollo y pruebas; genera un enlace local que marca el pago como cobrado.
 *  - stripe: Checkout para la entrada (tarjeta o adeudo SEPA) guardando el método de pago para cobrar
 *    después las cuotas sin que el cliente tenga que intervenir.
 *
 * La facturación NO se hace aquí: el software de facturación debe cumplir el RD 1007/2023 (Veri*factu),
 * así que se recomienda conectar un programa de facturación certificado a los pagos cobrados.
 */
export function crearPagos(config, { fetchImpl = fetch } = {}) {
  if (config.pagos.proveedor === 'stripe') return crearStripe(config, fetchImpl);
  return crearSimulado(config);
}

function crearSimulado(config) {
  return {
    nombre: 'simulado',
    async crearCobro({ pago }) {
      return { referencia: `sim_${pago.id}`, url: `${config.baseUrl}/pago-simulado/${pago.id}` };
    },
    async cobrarCuota({ pago }) {
      return { estado: 'pagado', referencia: `sim_${pago.id}` };
    },
  };
}

function formulario(objeto, prefijo = '', salida = new URLSearchParams()) {
  for (const [clave, valor] of Object.entries(objeto)) {
    if (valor == null) continue;
    const nombre = prefijo ? `${prefijo}[${clave}]` : clave;
    if (typeof valor === 'object') formulario(valor, nombre, salida);
    else salida.append(nombre, String(valor));
  }
  return salida;
}

function crearStripe(config, fetchImpl) {
  const { stripeSecretKey } = config.pagos;
  async function llamar(metodo, ruta, cuerpo, idempotencia) {
    const respuesta = await fetchImpl(`https://api.stripe.com/v1/${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencia ? { 'Idempotency-Key': idempotencia } : {}),
      },
      body: cuerpo ? formulario(cuerpo).toString() : undefined,
    });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
      const error = new Error(`Stripe ${respuesta.status}: ${datos.error?.message ?? 'error'}`);
      error.stripe = datos.error;
      throw error;
    }
    return datos;
  }

  return {
    nombre: 'stripe',
    async crearCobro({ pago, encargo, lead }) {
      const sesion = await llamar('POST', 'checkout/sessions', {
        mode: 'payment',
        customer_creation: 'always',
        customer_email: lead.email ?? undefined,
        client_reference_id: encargo.id,
        payment_method_types: { 0: 'card', 1: 'sepa_debit' },
        line_items: {
          0: {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: pago.importe_cent,
              product_data: { name: `${config.despacho.nombreComercial} · ${pago.tipo === 'entrada' ? 'Entrada' : `Cuota ${pago.numero}`} hoja de encargo ${encargo.id.slice(0, 8).toUpperCase()}` },
            },
          },
        },
        payment_intent_data: {
          ...(pago.tipo === 'entrada' ? { setup_future_usage: 'off_session' } : {}),
          metadata: { pago_id: pago.id, encargo_id: encargo.id },
        },
        metadata: { pago_id: pago.id, encargo_id: encargo.id },
        success_url: `${config.baseUrl}/pago/ok?encargo=${encodeURIComponent(encargo.token)}`,
        cancel_url: `${config.baseUrl}/encargo/${encodeURIComponent(encargo.token)}?pago=cancelado`,
      }, `cobro-${pago.id}-${pago.intentos}`);
      return { referencia: sesion.id, url: sesion.url };
    },

    /** Datos del método de pago guardado tras el pago de la entrada, para las cuotas. */
    async metodoGuardado(paymentIntentId) {
      const intento = await llamar('GET', `payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=payment_method`);
      return {
        cliente: intento.customer,
        metodo: intento.payment_method?.id ?? intento.payment_method,
        tipo: intento.payment_method?.type ?? null,
      };
    },

    async cobrarCuota({ pago, encargo }) {
      if (!encargo.pago_cliente_ref || !encargo.pago_metodo_ref) throw new Error('El encargo no tiene método de pago guardado.');
      const intento = await llamar('POST', 'payment_intents', {
        amount: pago.importe_cent,
        currency: 'eur',
        customer: encargo.pago_cliente_ref,
        payment_method: encargo.pago_metodo_ref,
        payment_method_types: { 0: encargo.pago_metodo_tipo ?? 'card' },
        off_session: 'true',
        confirm: 'true',
        description: `Cuota ${pago.numero} · hoja de encargo ${encargo.id.slice(0, 8).toUpperCase()}`,
        metadata: { pago_id: pago.id, encargo_id: encargo.id },
      }, `cuota-${pago.id}-${pago.intentos}`).catch((error) => {
        if (error.stripe?.payment_intent) return error.stripe.payment_intent;
        throw error;
      });
      // SEPA es asíncrono: queda "processing" y el resultado llega por webhook.
      const estado = intento.status === 'succeeded' ? 'pagado' : intento.status === 'processing' ? 'procesando' : 'fallido';
      return { estado, referencia: intento.id };
    },
  };
}

/** Verifica la cabecera Stripe-Signature (esquema v1, HMAC-SHA256 de "timestamp.cuerpo"). */
export function firmaStripeValida(cuerpoCrudo, cabecera, secreto, ahoraSeg = Math.floor(Date.now() / 1000), toleranciaSeg = 300) {
  if (!cabecera || !secreto || !cuerpoCrudo) return false;
  const partes = Object.groupBy(cabecera.split(',').map((p) => p.split('=')), ([clave]) => clave);
  const t = partes.t?.[0]?.[1];
  const firmas = (partes.v1 ?? []).map(([, valor]) => valor);
  if (!t || firmas.length === 0 || Math.abs(ahoraSeg - Number(t)) > toleranciaSeg) return false;
  const esperada = hmacHex(secreto, `${t}.${cuerpoCrudo}`);
  return firmas.some((f) => igualSeguro(f, esperada));
}
