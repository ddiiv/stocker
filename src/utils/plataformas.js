import { canView, canEdit, esAdministradorTotal } from "./permissions.js";

/*
 * La sección Plataformas: qué pestañas tiene, quién ve cuál y cómo se dice el
 * estado de cada conexión.
 *
 * Es UN solo ítem del menú (decisión del dueño) con pestañas que reusan las
 * pantallas de siempre. Cada pestaña conserva el permiso que tenía su pantalla:
 *
 *   · Mercado Libre, Jumpseller y Tienda propia → integraciones.
 *   · Mayoristas → ventas, como la bandeja de antes. Pasarla a integraciones
 *     le habría sacado la bandeja a los vendedores que la usan todos los días.
 *   · Resumen → cualquiera de los dos: es la puerta de la sección.
 *
 * Ocultar una pestaña es comodidad, no seguridad: el backend decide en cada
 * ruta (GET /api/plataformas pide integraciones o ventas).
 */
export const PESTANAS_PLATAFORMAS = [
  { to: "/plataformas",              label: "Resumen",       end: true, permisos: ["integraciones", "ventas"] },
  { to: "/plataformas/mercadolibre", label: "Mercado Libre",            permisos: ["integraciones"] },
  { to: "/plataformas/jumpseller",   label: "Jumpseller",               permisos: ["integraciones"] },
  { to: "/plataformas/tienda",       label: "Tienda propia",            permisos: ["integraciones"] },
  { to: "/plataformas/mayoristas",   label: "Mayoristas",               permisos: ["ventas"] },
];

/* Los permisos con los que se entra a la sección (cualquiera de los dos). */
export const PERMISOS_PLATAFORMAS = ["integraciones", "ventas"];

export function puedeVerPlataformas(user) {
  return PERMISOS_PLATAFORMAS.some((p) => canView(user, p));
}

export function pestanasDePlataformas(user) {
  if (!user) return [];
  return PESTANAS_PLATAFORMAS.filter((t) => t.permisos.some((p) => canView(user, p)));
}

/*
 * Pedir una cotización es contratar trabajo en nombre del negocio: el dueño o
 * un cargo con integraciones en edición (decisión del dueño). Igual que el
 * backend (POST /api/plataformas/cotizaciones).
 */
export function puedePedirCotizacion(user) {
  return esAdministradorTotal(user) || canEdit(user, "integraciones");
}

/*
 * Las direcciones de antes, para que sigan andando.
 *
 * Hay favoritos guardados y, sobre todo, autorizaciones de Mercado Libre en
 * vuelo: el backend viejo devolvía a /integraciones/mercadolibre?ml_ok=1. La
 * query viaja entera; un <Navigate> a secas la perdía y el aviso de "cuenta
 * conectada" no aparecía nunca.
 */
export const RUTAS_VIEJAS = {
  "/integraciones/mercadolibre": "/plataformas/mercadolibre",
  "/integraciones/jumpseller": "/plataformas/jumpseller",
  "/pedidos-mayoristas": "/plataformas/mayoristas",
};

export function destinoDeRutaVieja(pathname, search = "", hash = "") {
  const nueva = RUTAS_VIEJAS[pathname];
  if (!nueva) return null;
  return `${nueva}${search || ""}${hash || ""}`;
}

/*
 * Cómo se dice el estado de una conexión.
 *
 * `p` es una fila de GET /api/plataformas → plataformas[]. "Disponible desde
 * el Pro" sale del plan que el servidor encontró en la base (`desde`), no está
 * escrito acá: si el equipo la suma a otro plan, la pantalla lo sigue.
 */
export function textoDeEstado(p) {
  if (!p) return { texto: "—", tono: "neutro" };
  const desde = p.desde?.nombre ? `Disponible desde el ${p.desde.nombre}` : "No incluida en tu plan";
  switch (p.estado) {
    case "conectada":
      return { texto: p.heredada ? "Conectada (la conservás de antes)" : "Conectada", tono: "ok" };
    case "sin_conectar":
      return { texto: "No conectada", tono: "neutro" };
    case "requiere_plan":
      return { texto: desde, tono: "plan" };
    case "fuera_de_plan":
      return { texto: `Conectada, pero tu plan no la incluye. ${desde}`, tono: "alerta" };
    default:
      return { texto: "—", tono: "neutro" };
  }
}

/* La fila de una plataforma, por su clave. */
export function plataforma(estado, clave) {
  return (estado?.plataformas || []).find((p) => p.clave === clave) || null;
}

/*
 * ¿Se muestra la bandeja de pedidos mayoristas?
 *
 * Por la CREDENCIAL, no por el conteo: un portal recién conectado todavía no
 * mandó ningún pedido y tiene que ver su bandeja vacía con el estado de la
 * conexión, no la invitación a cotizar uno. Y si el portal ya no está pero
 * quedaron pedidos, la bandeja sigue: son datos del negocio y no se esconden.
 */
export function muestraBandejaMayorista(estado) {
  const p = plataforma(estado, "mayorista");
  if (p?.conectada) return true;
  return Number(estado?.mayoristas?.total || 0) > 0;
}

export const TIPOS_COTIZACION = {
  portal_mayorista: "Portal de pedidos mayoristas a medida",
  tienda_propia: "Conectar una tienda online propia",
};

export const ESTADOS_COTIZACION = {
  nueva: "Recibida",
  contactada: "Te contactamos",
  cotizada: "Presupuesto enviado",
  aceptada: "Aceptada",
  descartada: "Cerrada",
};

/* El último pedido de cotización de un tipo, o null. */
export function ultimaCotizacion(estado, tipo) {
  return (estado?.cotizaciones || []).find((c) => c.tipo === tipo) || null;
}

/* Lo mismo que valida el backend, para avisar antes de mandar. */
export const DETALLE_MINIMO = 20;
export function validarCotizacion({ detalle = "", contactoEmail = "" } = {}) {
  if (String(detalle).trim().length < DETALLE_MINIMO) {
    return "Contanos un poco más: qué venden por mayor, a cuántos clientes y cómo toman hoy los pedidos.";
  }
  const email = String(contactoEmail || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Ese email no parece válido.";
  return null;
}

/*
 * ¿La conexión está callada?
 *
 * Una tienda o un portal conectados se comunican solos y seguido. Si pasan
 * tres días sin que Stocker sepa nada de ellos, algo se cortó del otro lado
 * (el token se cambió, la página está caída) y los pedidos no están entrando.
 * Es el mismo umbral que el equipo mira en el backoffice.
 */
export const DIAS_SIN_USO = 3;

export function avisoDeUso(p, ahora = Date.now()) {
  if (!p?.conectada) return null;
  const ultimo = p.detalle?.ultimoUso;
  if (!ultimo) return "Todavía no se comunicó con Stocker. Si ya la están usando, revisá que tenga la credencial nueva.";
  const dias = (new Date(ahora).getTime() - new Date(ultimo).getTime()) / (24 * 60 * 60 * 1000);
  if (dias >= DIAS_SIN_USO) {
    return `Hace ${Math.floor(dias)} días que no se comunica con Stocker: los pedidos no están entrando. Escribinos y lo revisamos.`;
  }
  return null;
}
