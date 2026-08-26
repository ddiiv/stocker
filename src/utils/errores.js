/*
 * Traduce un error de la API a algo que se pueda leer y accionar.
 *
 * El problema que resuelve: al fallar una venta la pantalla mostraba siempre lo
 * mismo, y "no se pudo registrar la venta" no distingue entre quedarse sin
 * stock, no tener el turno de caja abierto, haber perdido la sesión o que el
 * servidor esté caído. Cada una se arregla de una forma distinta, y quien está
 * en el mostrador con un cliente enfrente necesita saber cuál es.
 *
 * Devuelve `{ titulo, detalle, tipo, accion }`:
 *   tipo    sirve para elegir el color y decidir si se ofrece un atajo.
 *   accion  qué hacer, cuando hay algo concreto que hacer.
 */

export function analizarError(err, fallback = "No se pudo completar la operación.") {
  // Sin `response` no llegó a haber respuesta: o no hay red, o el servidor no
  // contesta. Es distinto de un rechazo del servidor y se dice distinto.
  if (!err?.response) {
    const abortado = err?.code === "ECONNABORTED";
    return {
      tipo: "red",
      titulo: abortado ? "El servidor tardó demasiado en responder." : "No se pudo conectar con el servidor.",
      detalle: "Revisá tu conexión. Si el problema sigue, avisá al soporte antes de volver a intentar: la operación puede haber quedado registrada.",
      accion: null,
    };
  }

  const { status, data } = err.response;
  const msg = data?.message || "";
  // El backend manda los detalles de validación en `errors`; si están, son más
  // precisos que el mensaje general.
  const detalles = Array.isArray(data?.errors) ? data.errors.filter(Boolean) : [];

  if (status === 401) {
    return {
      tipo: "sesion",
      titulo: "Se cerró tu sesión.",
      detalle: "Por seguridad la sesión vence tras un rato sin actividad. Volvé a entrar y cargá la operación de nuevo.",
      accion: { texto: "Ir a iniciar sesión", href: "/login" },
    };
  }

  if (status === 403) {
    return {
      tipo: "permiso",
      titulo: msg || "Tu cargo no tiene permiso para esto.",
      detalle: "Pedile al dueño del negocio que ajuste tus permisos desde Empleados.",
      accion: null,
    };
  }

  if (status === 404) {
    return { tipo: "datos", titulo: msg || "No se encontró lo que se pidió.", detalle: null, accion: null };
  }

  /*
   * 409 es el conflicto de negocio: la operación es válida pero el estado
   * actual no la permite. Son los casos que más se ven en la caja, así que
   * cada uno lleva su propio atajo.
   */
  if (status === 409) {
    if (/turno de caja/i.test(msg)) {
      return {
        tipo: "turno",
        titulo: "Necesitás abrir tu turno de caja antes de vender.",
        detalle: "El turno es contra lo que se arquea el efectivo al final del día.",
        accion: { texto: "Abrir mi turno de caja", href: "/caja" },
      };
    }
    if (data?.codigo === "SIN_STOCK" || /stock|quedan/i.test(msg)) {
      return {
        tipo: "stock",
        titulo: msg || "No hay stock suficiente.",
        detalle: "Si la mercadería está en el local pero sin cargar, ingresala desde Stock antes de vender.",
        accion: { texto: "Ver stock por local", href: "/stock/por-local" },
      };
    }
    /*
     * Numeración ocupada. Lo importante del aviso es la última línea: que la
     * venta NO quedó guardada. Sin eso el cajero no sabe si reintentar le va a
     * cobrar dos veces al cliente, y ante la duda lo más probable es que
     * termine anotando la venta a mano.
     */
    if (data?.codigo === "NUMERO_OCUPADO") {
      return {
        tipo: "numero",
        titulo: "Otra caja está emitiendo en este mismo momento.",
        detalle: "La venta no se guardó. Volvé a registrarla: el número se asigna solo.",
        accion: null,
      };
    }
    if (data?.codigo === "VENTA_FACTURADA") {
      return { tipo: "facturada", titulo: msg, detalle: null, accion: { texto: "Ver facturación", href: "/facturacion" } };
    }
    if (/local asignado|depósito/i.test(msg)) {
      return { tipo: "config", titulo: msg, detalle: "Es un tema de configuración: lo resuelve el dueño desde Empleados.", accion: null };
    }
    return { tipo: "conflicto", titulo: msg || fallback, detalle: null, accion: null };
  }

  if (status === 429) {
    return {
      tipo: "limite",
      titulo: msg || "Demasiados intentos seguidos.",
      detalle: "Esperá un momento y volvé a probar.",
      accion: null,
    };
  }

  if (status === 400) {
    return {
      tipo: "validacion",
      titulo: detalles.length ? "Hay datos que no son válidos:" : (msg || "Faltan datos o son inválidos."),
      detalle: detalles.length ? detalles.join(" · ") : null,
      accion: null,
    };
  }

  if (status >= 500) {
    return {
      tipo: "servidor",
      titulo: "El servidor tuvo un problema.",
      detalle: "No es algo que puedas corregir desde acá. Si se repite, avisá al soporte con la hora exacta.",
      accion: null,
    };
  }

  return { tipo: "otro", titulo: msg || fallback, detalle: detalles.join(" · ") || null, accion: null };
}

/** La versión corta, para donde sólo entra una línea. */
export function mensajeDeError(err, fallback) {
  const { titulo, detalle } = analizarError(err, fallback);
  return detalle ? `${titulo} ${detalle}` : titulo;
}
