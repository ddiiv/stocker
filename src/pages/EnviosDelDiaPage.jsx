import { useCallback, useEffect, useRef, useState } from "react";
import {
  Truck, Printer, RefreshCw, PackageCheck, PackageX, Clock,
  AlertTriangle, Check, MapPin, Loader2,
} from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import AvisoError from "../components/ui/AvisoError";
import {
  fetchJornada, abrirPdfJornada, despacharPaquete, marcarFaltante, reprocesarPedido,
  abrirEtiquetas, despacharVarios, sincronizarConMl,
} from "../services/enviosService";
import { fetchLocalesDeVenta } from "../services/employeeService";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";
import { analizarError } from "../utils/errores";

/*
 * La jornada del depósito.
 *
 * Un pedido online APARTA la mercadería cuando entra: la prenda sigue en el
 * estante, comprometida, y nadie más la puede vender. Esta pantalla es la
 * segunda mitad — donde esa reserva se convierte en salida, cuando el paquete
 * efectivamente sale.
 *
 * ── Por qué el recorrido va primero ───────────────────────────────
 *
 * Quien arma los paquetes no camina el depósito una vez por pedido. Con veinte
 * pedidos que comparten la misma remera negra talle M, recorrer el pasillo
 * veinte veces es la diferencia entre despachar a las 14 y despachar a las 18 —
 * y con Flex, que tiene corte horario, esa diferencia se paga en reputación.
 *
 * Por eso lo primero que se ve es QUÉ BAJAR, agrupado y sumado, y recién
 * después los paquetes para armarlos con lo que ya se juntó.
 *
 * ── Y por qué igual hay un botón de imprimir ──────────────────────
 *
 * Porque el depósito no tiene una pantalla al lado del estante. Esta vista es
 * para mirar el estado y despachar; el papel es la herramienta con la que se
 * camina, y por eso el A4 está a un toque y no escondido en un menú.
 */

const hora = (d) => (d
  ? new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(d))
  : null);

const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const isoDeHace = (dias) => {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/*
 * Los presets del selector "Alcance".
 *
 * No alcanza con un número de días: "Próximos 30" y "Últimos 30" son los
 * mismos 30 días de ventana pero mirando para lados opuestos, y eso requiere
 * mover el selector de Día además del de Alcance. Guardarlo como un preset
 * con nombre evita que, después de elegir "Últimos 30 días", la pantalla
 * vuelva a mostrar "Próximos 30 días" sólo porque el número de días coincide.
 */
const ALCANCES = {
  hoy:       { texto: "Sólo hoy",          dias: 0,  atras: false },
  hoy2:      { texto: "Hoy y 2 días",      dias: 2,  atras: false },
  prox7:     { texto: "Próximos 7 días",   dias: 7,  atras: false },
  prox30:    { texto: "Próximos 30 días",  dias: 30, atras: false },
  ultimos30: { texto: "Últimos 30 días",   dias: 30, atras: true },
};

/*
 * Cuánto falta para el corte.
 *
 * En minutos y no en "a las 18:00": lo que hace falta saber parado en el
 * depósito es si quedan tres horas o veinte minutos, y esa cuenta la tiene que
 * hacer la pantalla, no la persona.
 */
/*
 * Cuánto falta, dicho como lo diría una persona.
 *
 * "venció hace 247 min" obliga a dividir por 60 en la cabeza para entender si
 * es grave. A partir de la hora se dice en horas.
 */
function enPalabras(minutos) {
  const m = Math.abs(minutos);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const resto = m % 60;
  return resto ? `${h} h ${resto} min` : `${h} h`;
}

/*
 * Hace cuánto se habló con Mercado Libre por última vez.
 *
 * Menos de un minuto es "recién" y no "hace 0 min": un cero se lee como que
 * algo no anda.
 */
function haceCuanto(desde, ahora) {
  const min = Math.floor(Math.max(0, ahora - desde) / 60000);
  return min < 1 ? "recién" : `hace ${enPalabras(min)}`;
}

function Corte({ cuando, minutos, atrasado }) {
  if (!cuando) return null;
  /*
   * Los minutos los calcula el servidor. Recalcularlos acá con el reloj del
   * navegador hace que una máquina con la hora corrida muestre un corte
   * distinto del que usa el sistema para decidir si va atrasado.
   */
  const faltan = minutos ?? Math.round((new Date(cuando).getTime() - Date.now()) / 60000);
  const apura = !atrasado && faltan >= 0 && faltan <= 90;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        atrasado ? "bg-brick-500 text-paper-50"
          : apura ? "bg-brass-50 text-brass-700"
            : "bg-paper-100 text-ink-600"
      }`}
      title={`Corte a las ${hora(cuando)}`}
    >
      <Clock size={11} />
      {atrasado
        ? `atrasado ${enPalabras(faltan)}`
        : faltan < 90
          ? `faltan ${enPalabras(faltan)}`
          : `hasta ${hora(cuando)}`}
    </span>
  );
}

/*
 * En qué anda el paquete, en una palabra.
 *
 * Junta los dos estados que el sistema guarda por separado: el del depósito
 * —si se armó y salió— y el que informa Mercado Libre —si llegó, si se
 * canceló—. Quien mira la pantalla no piensa en dos campos, y traducir
 * `not_delivered` mentalmente cada vez es trabajo que puede hacer el sistema.
 */
const fechaHora = (d) => (d
  ? new Intl.DateTimeFormat("es-AR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(d))
  : null);

const CONFIRMADOS_ML = ["shipped", "delivered"];

/*
 * Dos historiales, uno al lado del otro.
 *
 * "¿Qué se despachó?" tiene dos respuestas distintas y las dos hacen falta:
 * la del depósito —quién armó la caja y cuándo— y la de Mercado Libre —si el
 * transportista de verdad la levantó—. Mirados por separado, cada uno se ve
 * completo y no dice nada raro; puestos uno al lado del otro aparece la
 * pregunta real: ¿coinciden, o uno de los dos está adelantado?
 */
function HistorialReconciliacion({ paquetes }) {
  const porStocker = paquetes.filter((p) => p.estadoEnvio === "despachado");
  const porMl = paquetes.filter((p) => CONFIRMADOS_ML.includes(p.estadoEnvioMl));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-0">
        <div className="border-b border-line px-4 py-3">
          <p className="font-display text-sm font-semibold text-ink-950">Despachado por Stocker</p>
          <p className="mt-0.5 text-xs text-ink-500">
            Lo que el depósito marcó como salido, con quién y cuándo.
          </p>
        </div>
        {porStocker.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-500">Nada despachado en esta jornada.</p>
        ) : (
          <ul className="divide-y divide-line">
            {porStocker.map((p) => (
              <li key={`s-${p.claveEnvio}`} className="px-4 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">
                      {p.envioId ? `Envío ${p.envioId}` : `${p.plataforma} · ${p.ventas?.[0]?.pedidoExterno || ""}`}
                    </p>
                    <p className="text-xs text-ink-500">{p.comprador || "Sin nombre de comprador"}</p>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      {fechaHora(p.despachadoEn)}{p.despachadoPor ? ` · ${p.despachadoPor}` : ""}
                    </p>
                  </div>
                  <Estado situacion={p.situacion} />
                </div>
                {!CONFIRMADOS_ML.includes(p.estadoEnvioMl) && (
                  <p className="mt-1.5 flex items-start gap-1 rounded-md bg-brass-50 px-2 py-1 text-[11px] text-brass-700">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    Mercado Libre todavía no lo confirma como salido.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-0">
        <div className="border-b border-line px-4 py-3">
          <p className="font-display text-sm font-semibold text-ink-950">Confirmado por Mercado Libre</p>
          <p className="mt-0.5 text-xs text-ink-500">
            Lo que ML dice que el transportista levantó o entregó.
          </p>
        </div>
        {porMl.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-500">Mercado Libre no confirmó nada todavía.</p>
        ) : (
          <ul className="divide-y divide-line">
            {porMl.map((p) => (
              <li key={`m-${p.claveEnvio}`} className="px-4 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">
                      {p.envioId ? `Envío ${p.envioId}` : `${p.plataforma} · ${p.ventas?.[0]?.pedidoExterno || ""}`}
                    </p>
                    <p className="text-xs text-ink-500">{p.comprador || "Sin nombre de comprador"}</p>
                  </div>
                  <Estado situacion={p.situacion} />
                </div>
                {/*
                  * `shipped` no alarma: en Flex, ML lo pone apenas se imprime la
                  * etiqueta, ANTES de que el depósito baje la mercadería del
                  * estante — es el orden normal, no un error. Ya se avisa aparte
                  * con "ML ya la dio por despachada" en el armado de paquetes.
                  *
                  * `delivered` sí: si el comprador ya lo recibió y acá el stock
                  * nunca se descontó, esta caja quedó apartada para siempre y el
                  * inventario está mintiendo. Eso sí hay que resolverlo.
                  */}
                {p.estadoEnvio !== "despachado" && p.estadoEnvioMl === "delivered" && (
                  <p className="mt-1.5 flex items-start gap-1 rounded-md bg-brick-50 px-2 py-1 text-[11px] text-brick-500">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    Mercado Libre dice que ya lo ENTREGÓ, pero acá nunca se despachó: el stock sigue apartado.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Estado({ situacion }) {
  const mapa = {
    para_enviar:  { texto: "Para enviar", clase: "bg-paper-100 text-ink-600" },
    en_camino:    { texto: "En camino",   clase: "bg-teal-50 text-teal-600" },
    entregado:    { texto: "Entregado",   clase: "bg-teal-50 text-teal-600" },
    con_faltante: { texto: "Faltante",    clase: "bg-brick-50 text-brick-500" },
    cancelado:    { texto: "Cancelado",   clase: "bg-brick-50 text-brick-500" },
  };
  const e = mapa[situacion] || mapa.para_enviar;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${e.clase}`}>{e.texto}</span>;
}

/*
 * El artículo, dicho entero: modelo y los dos atributos CON su nombre.
 *
 * Sólo los valores —"Negro · M"— alcanzan cuando quien arma conoce el producto
 * de memoria, y no alcanzan cuando no. "38" puede ser un talle o un color de
 * una carta numerada, y con dos ejes parecidos —"S / M" sobre Talle y Largo—
 * no hay forma de saber cuál es cuál. Con la caja abierta en la mesa eso es la
 * diferencia entre agarrar la prenda correcta y volver al estante.
 */
function Articulo({ item }) {
  const ejes = [
    [item.variante1Nombre, item.variante1Valor],
    [item.variante2Nombre, item.variante2Valor],
  ].filter(([, valor]) => valor);

  return (
    <>
      <span className="text-ink-900">{item.titulo || item.sku}</span>
      {item.modelo && <span className="text-ink-600"> · modelo {item.modelo}</span>}
      {ejes.length > 0 ? (
        <span className="text-ink-600">
          {" · "}
          {ejes.map(([nombre, valor]) => (nombre ? `${nombre}: ${valor}` : valor)).join(" · ")}
        </span>
      ) : (
        item.variante && <span className="text-ink-600"> · {item.variante}</span>
      )}
    </>
  );
}

export default function EnviosDelDiaPage() {
  const { user } = useAuth();
  const puedeDespachar = canEdit(user, "stock");

  const [fecha, setFecha] = useState(hoyISO());
  const [locationId, setLocationId] = useState("");
  const [soloFlex, setSoloFlex] = useState(false);

  /*
   * Rango y estado, como en el panel de Mercado Libre.
   *
   * Antes eran dos casillas —"sólo Flex" e "incluir despachados"— y no
   * alcanzaban: quien mira esta pantalla no pregunta "¿incluyo los
   * despachados?", pregunta "¿qué me falta enviar?", "¿qué está en camino?",
   * "¿qué se canceló?". Son estados de un circuito, no un interruptor.
   *
   * El rango va aparte porque es otra pregunta: un pedido con corte mañana no
   * es de otro estado, es de otro día, y hay que poder ir preparándolo.
   */
  const [dias, setDias] = useState(0);
  const [alcance, setAlcance] = useState("hoy");
  const [filtro, setFiltro] = useState("para_enviar");

  function elegirAlcance(clave) {
    const preset = ALCANCES[clave] || ALCANCES.hoy;
    setAlcance(clave);
    setFecha(preset.atras ? isoDeHace(preset.dias) : hoyISO());
    setDias(preset.dias);
  }

  const [locales, setLocales] = useState([]);
  const [jornada, setJornada] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [aviso, setAviso] = useState("");
  const [trabajando, setTrabajando] = useState(null);   // id del paquete en curso
  /*
   * Los paquetes tildados, por clave de envío.
   *
   * Es lo que convierte la jornada en una tanda: imprimir veinte etiquetas y
   * despachar veinte cajas pasan a ser dos acciones en vez de cuarenta. Se
   * guarda por `claveEnvio` y no por índice porque la lista se recarga sola
   * después de cada acción y los índices se corren.
   */
  const [elegidos, setElegidos] = useState(() => new Set());
  const [imprimiendo, setImprimiendo] = useState(false);

  const filtros = {
    fecha,
    locationId: locationId ? Number(locationId) : null,
    envioTipo: soloFlex ? "flex" : null,
    diasAdelante: dias,
    filtro,
  };

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      setJornada(await fetchJornada({
        fecha, locationId: locationId ? Number(locationId) : null,
        envioTipo: soloFlex ? "flex" : null, diasAdelante: dias, filtro,
      }));
    } catch (e) {
      /*
       * Analizado, no crudo. `AvisoError` espera {titulo, detalle, tipo} y con
       * un error de axios leía `error.titulo` —que no existe— y pintaba un
       * recuadro rojo VACÍO: la persona veía que algo falló y ni una palabra de
       * qué. Estaba así en los cinco manejadores de esta pantalla.
       */
      setError(analizarError(e, "No se pudo cargar la jornada."));
      setJornada(null);
    } finally {
      setCargando(false);
    }
  }, [fecha, locationId, soloFlex, dias, filtro]);

  useEffect(() => { cargar(); }, [cargar]);
  /*
   * Al cambiar de día o de filtro la selección se borra: lo tildado en la
   * jornada de ayer no tiene por qué seguir tildado en la de hoy, y despachar
   * "los seleccionados" sin ver cuáles son es la peor manera de descontar
   * stock.
   */
  useEffect(() => { setElegidos(new Set()); }, [fecha, locationId, soloFlex, dias, filtro]);
  useEffect(() => { fetchLocalesDeVenta().then(setLocales).catch(() => setLocales([])); }, []);

  /*
   * ── La reconciliación con Mercado Libre ───────────────────────────
   *
   * Los webhooks de ML se pierden o llegan tarde, y confiando sólo en ellos la
   * jornada puede tener en "Para enviar" algo que ML ya despachó, o no mostrar
   * nunca una cancelación. Por eso cada vez que se abre la pantalla se le
   * pregunta a ML.
   *
   * Corre en paralelo a `cargar()` y no antes: la sincronización habla con la
   * API de ML y puede tardar varios segundos, y quien abre la pantalla para
   * despachar necesita ver ya lo guardado, no un "cargando" hasta que ML
   * conteste. Si ML trajo novedades, se recarga.
   *
   * Y un fallo acá NUNCA toca `error` ni `jornada`: lo guardado sigue sirviendo
   * para trabajar, y tapar la jornada porque venció el token de ML dejaría al
   * depósito sin nada que despachar.
   */
  const [sincro, setSincro] = useState({ estado: null, en: null, mensaje: null });
  const [ahora, setAhora] = useState(() => Date.now());
  const yaSincronizo = useRef(false);
  /*
   * La última versión de `cargar`, para llamarla cuando ML contesta. Si
   * mientras tanto se cambió de día o de filtro, hay que recargar lo que se
   * está mirando AHORA, no lo que se miraba al abrir.
   */
  const cargarActual = useRef(cargar);
  useEffect(() => { cargarActual.current = cargar; }, [cargar]);

  const sincronizar = useCallback(async ({ recargarSiempre = false, forzar = false } = {}) => {
    setSincro((s) => ({ ...s, estado: "sincronizando", mensaje: null }));
    try {
      const r = await sincronizarConMl({ forzar });
      if (r?.motivo === "sin_cuenta") {
        setSincro({ estado: "sin_cuenta", en: null, mensaje: null });
        return;
      }
      /*
       * La hora sale del reloj de este navegador al recibir la respuesta, no
       * de `sincronizadoEn`: restar la hora del servidor al reloj local hace
       * que una máquina con la hora corrida diga "hace 12 min" de algo que
       * pasó recién —lo mismo que con el corte de Flex—. Cuando el servidor
       * la omitió por reciente, lo que se pierde es menos de un minuto.
       */
      const recibido = Date.now();
      setAhora(recibido);
      setSincro({ estado: "ok", en: recibido, mensaje: null });
      /*
       * Sin cambios no se recarga: sería volver a pedir lo mismo que ya está
       * en pantalla. El botón manual sí recarga siempre, porque quien lo toca
       * espera ver la lista recién traída.
       */
      const huboCambios = Object.values(r?.cambios || {}).some((n) => Number(n) > 0);
      if (huboCambios || recargarSiempre) await cargarActual.current();
    } catch (e) {
      /*
       * Si falló no se recarga, tampoco desde el botón: lo guardado no cambió,
       * y si lo que se cayó es la red, `cargar()` fallaría y vaciaría la
       * jornada, que es justo lo que esta sincronización no puede hacer.
       *
       * El mensaje del servidor va tal cual cuando lo hay: "venció el token
       * de Mercado Libre" dice qué hacer, y el genérico de `analizarError`
       * para un 5xx no. Sin respuesta —sin red— sí sirve el de `analizarError`.
       */
      const motivo = (e?.response?.data?.message
        || analizarError(e, "error desconocido").titulo).replace(/[.\s]+$/, "");
      setSincro((s) => ({ ...s, estado: "error", mensaje: motivo }));
    }
  }, []);

  /*
   * Una sola vez por apertura, no con cada cambio de filtro: filtrar cambia qué
   * se mira, no lo que sabe ML. La marca va en un ref por el StrictMode de
   * desarrollo, que corre los efectos dos veces y dispararía dos
   * sincronizaciones seguidas contra ML.
   */
  useEffect(() => {
    if (yaSincronizo.current) return;
    yaSincronizo.current = true;
    sincronizar();
  }, [sincronizar]);

  /*
   * El "hace X min" se refresca cada 30 segundos y sólo si hay una hora que
   * mostrar: más seguido es re-renderizar la jornada entera para cambiar una
   * palabra que cambia, como mucho, una vez por minuto.
   */
  useEffect(() => {
    if (!sincro.en) return undefined;
    const t = setInterval(() => setAhora(Date.now()), 30000);
    return () => clearInterval(t);
  }, [sincro.en]);

  async function despachar(p) {
    setTrabajando(p.id); setError(null); setAviso("");
    try {
      const r = await despacharPaquete(p.id);
      setAviso(r.mensaje);
      await cargar();
    } catch (e) {
      setError(analizarError(e, "No se pudo despachar el paquete."));
    } finally {
      setTrabajando(null);
    }
  }

  /*
   * Reprocesa las ventas del paquete que no apartaron mercadería.
   *
   * Se hace por venta y no por paquete porque el pedido es la unidad que tiene
   * las líneas: un envío puede juntar dos ventas y sólo una tener el problema.
   */
  async function reprocesar(p) {
    setTrabajando(p.id); setError(null); setAviso("");
    try {
      const rs = [];
      for (const v of p.ventas || []) rs.push(await reprocesarPedido(v.id));
      setAviso(rs.map((r) => r.mensaje).join(" "));
      await cargar();
    } catch (e) {
      setError(analizarError(e, "No se pudo apartar el stock."));
    } finally {
      setTrabajando(null);
    }
  }

  /*
   * Los paquetes tildados que TODAVÍA hay que despachar.
   *
   * Se filtra por situación y no se confía en lo tildado a secas: entre que
   * alguien tildó y apretó, la lista se pudo recargar y traer uno ya
   * despachado. Mandarlo de nuevo no rompe nada —el servidor es idempotente—
   * pero el resumen diría "20 despachados" cuando salieron 19.
   */
  const paquetes = jornada?.paquetes || [];
  const seleccionados = paquetes.filter((p) => elegidos.has(p.claveEnvio));
  const despachables = seleccionados.filter(
    (p) => (p.situacion === "para_enviar" || p.situacion === "con_faltante")
      && !p.items?.some((i) => i.sinApartar),
  );
  /*
   * Sólo Mercado Libre tiene etiqueta, y sólo si sabemos su número de envío.
   * Los pedidos de otra plataforma —o los que entraron sin envío— no tienen de
   * dónde sacarla, y ofrecer el botón para que después falle es peor que no
   * ofrecerlo.
   */
  const conEtiqueta = seleccionados.filter((p) => p.plataforma === "mercadolibre" && p.envioId);

  function alternar(clave) {
    setElegidos((prev) => {
      const n = new Set(prev);
      if (n.has(clave)) n.delete(clave); else n.add(clave);
      return n;
    });
  }

  function tildarTodos() {
    // Si ya están todos, destildar: el mismo control hace las dos cosas, que es
    // lo que uno espera de un "seleccionar todo".
    setElegidos(elegidos.size === paquetes.length
      ? new Set()
      : new Set(paquetes.map((p) => p.claveEnvio)));
  }

  async function imprimirEtiquetas() {
    if (!conEtiqueta.length) return;
    setTrabajando("etiquetas"); setError(null); setAviso("");
    try {
      await abrirEtiquetas(conEtiqueta.map((p) => p.envioId));
      const quedaron = seleccionados.length - conEtiqueta.length;
      if (quedaron > 0) {
        setAviso(`Se abrieron ${conEtiqueta.length} etiqueta(s). ${quedaron} de los `
          + "seleccionados no tienen etiqueta de Mercado Libre.");
      }
    } catch (e) {
      setError(analizarError(e, "No se pudieron traer las etiquetas."));
    } finally {
      setTrabajando(null);
    }
  }

  async function despacharTanda() {
    if (!despachables.length) return;
    const ok = window.confirm(
      `¿Despachar ${despachables.length} paquete(s)?\n\n`
      + "Esto descuenta el stock de todo lo que llevan adentro. Hasta ahora está apartado.",
    );
    if (!ok) return;

    setTrabajando("tanda"); setError(null); setAviso("");
    try {
      const r = await despacharVarios(despachables.map((p) => p.id));
      setAviso(r.mensaje);
      /*
       * Se destildan sólo los que salieron. Los que fallaron quedan tildados a
       * propósito: es lo que hay que volver a mirar, y destildarlos los
       * escondería en el medio de la lista.
       */
      const salieron = new Set(r.despachados.map((d) => d.pedidoId));
      setElegidos((prev) => new Set(
        [...prev].filter((clave) => {
          const p = paquetes.find((x) => x.claveEnvio === clave);
          return p && !salieron.has(p.id);
        }),
      ));
      if (r.fallaron.length) {
        setError(analizarError(
          { response: { data: { message: r.fallaron.map((f) => f.motivo).join(" · ") } } },
          "Algunos paquetes no se pudieron despachar.",
        ));
      }
      await cargar();
    } catch (e) {
      setError(analizarError(e, "No se pudo despachar la tanda."));
    } finally {
      setTrabajando(null);
    }
  }

  async function faltante(p) {
    /*
     * Se pide la nota antes de marcar. Un faltante sin motivo no sirve para
     * nada después: quien lo revisa necesita saber si la prenda no estaba, si
     * estaba fallada, o si el pedido pedía un talle que nunca se cargó.
     */
    const nota = prompt(
      `¿Qué pasó con el paquete ${p.pedidoExterno}?\n\n`
      + "El stock NO se modifica: la mercadería nunca salió, así que la diferencia "
      + "se resuelve con un recuento.",
    );
    if (nota === null) return;

    setTrabajando(p.id); setError(null); setAviso("");
    try {
      const r = await marcarFaltante(p.id, nota);
      setAviso(r.mensaje);
      await cargar();
    } catch (e) {
      setError(analizarError(e, "No se pudo marcar el faltante."));
    } finally {
      setTrabajando(null);
    }
  }

  async function imprimir() {
    setImprimiendo(true); setError(null);
    try {
      await abrirPdfJornada(filtros);
    } catch (e) {
      setError(analizarError(e, "No se pudo generar el PDF."));
    } finally {
      setImprimiendo(false);
    }
  }

  const resumen = jornada?.resumen;

  return (
    <div>
      <PageHeader
        title="Envíos del día"
        subtitle="Lo que sale hoy: qué bajar del estante y qué paquete armar con eso"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost gap-1.5 text-sm" onClick={cargar} disabled={cargando}>
              <RefreshCw size={15} className={cargando ? "animate-spin" : ""} /> Actualizar
            </button>
            <button className="btn-accent gap-1.5 text-sm" onClick={imprimir} disabled={imprimiendo || !jornada?.paquetes?.length}>
              {imprimiendo
                ? <><Loader2 size={15} className="animate-spin" /> Generando…</>
                : <><Printer size={15} /> Imprimir A4</>}
            </button>
          </div>
        }
      />

      <AvisoError error={error} className="mb-4" />
      {aviso && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">
          <Check size={15} className="mt-0.5 shrink-0" /> {aviso}
        </p>
      )}

      {/* ── Filtros ───────────────────────────────────────────── */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          {/*
            * La etiqueta ENVUELVE al control.
            *
            * Antes era un <label> hermano, sin `for` ni id: se veía la palabra
            * "Día" pero el lector de pantalla anunciaba el campo como "fecha,
            * en blanco", sin decir de qué. Envolviendo, la asociación es
            * implícita y no depende de mantener ids únicos a mano.
            */}
          <label className="block">
            <span className="label">Día</span>
            <input type="date" className="input h-9 w-40 text-sm"
              value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Local</span>
            <select className="input h-9 w-52 text-sm"
              value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Todos</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={soloFlex} onChange={(e) => setSoloFlex(e.target.checked)} />
            Sólo los que tienen corte (Flex)
          </label>
          <label className="block">
            <span className="label">Alcance</span>
            <select className="input h-9 w-44 text-sm"
              value={alcance} onChange={(e) => elegirAlcance(e.target.value)}>
              {Object.entries(ALCANCES).map(([clave, p]) => (
                <option key={clave} value={clave}>{p.texto}</option>
              ))}
            </select>
          </label>
        </div>

        {/*
          * Cómo está la jornada respecto de Mercado Libre, en una línea chica
          * abajo de los filtros: es contexto para saber cuánto confiar en lo
          * que se ve, no una tarea. Sin cuenta de ML conectada no hay nada que
          * decir, y una línea que dijera "no sincroniza" todos los días sería
          * ruido para quien vende sólo por otro canal.
          *
          * El fallo va en brass y no en rojo: la jornada sigue siendo usable
          * con lo guardado, y el rojo en esta pantalla es para lo que frena un
          * despacho.
          */}
        {sincro.estado && sincro.estado !== "sin_cuenta" && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2.5">
            <p
              role="status"
              className={`flex items-start gap-1.5 text-xs ${
                sincro.estado === "error" ? "text-brass-700" : "text-ink-500"
              }`}
            >
              {sincro.estado === "sincronizando" && (
                <><Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" /> Sincronizando con Mercado Libre…</>
              )}
              {sincro.estado === "ok" && (
                <><Check size={12} className="mt-0.5 shrink-0" /> Sincronizado con Mercado Libre {haceCuanto(sincro.en, ahora)}</>
              )}
              {sincro.estado === "error" && (
                <>
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  No se pudo sincronizar con Mercado Libre: {sincro.mensaje}. Se muestra lo último guardado.
                </>
              )}
            </p>
            <button
              type="button"
              className="btn-ghost gap-1 px-2 py-1 text-xs"
              onClick={() => sincronizar({ recargarSiempre: true, forzar: true })}
              disabled={sincro.estado === "sincronizando"}
            >
              <RefreshCw size={12} /> Sincronizar ahora
            </button>
          </div>
        )}
      </Card>

      {/*
        * ── Las pestañas del circuito ─────────────────────────────
        *
        * Cada una lleva su número aunque no sea la que se está mirando: una
        * pestaña "Cancelados" sin cuenta al lado obliga a entrar para descubrir
        * que está vacía, y eso se hace una vez por día hasta que se deja de
        * mirar.
        *
        * "Para enviar" va primera y es la que se abre: es la única con trabajo
        * pendiente, y las otras cuatro se miran cuando alguien pregunta algo.
        */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {[
          { clave: "para_enviar",  texto: "Para enviar" },
          { clave: "en_camino",    texto: "En camino" },
          { clave: "entregado",    texto: "Entregados" },
          { clave: "con_faltante", texto: "Con faltante" },
          { clave: "cancelado",    texto: "Cancelados" },
          { clave: "todos",        texto: "Todos" },
          { clave: "historial",   texto: "Historial Stocker / ML" },
        ].map((t) => {
          const activa = filtro === t.clave;
          const cuantos = jornada?.porEstado?.[t.clave];
          return (
            <button
              key={t.clave}
              type="button"
              onClick={() => setFiltro(t.clave)}
              aria-current={activa ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                activa
                  ? "border-brass-500 text-ink-950"
                  : "border-transparent text-ink-500 hover:text-ink-800"
              }`}
            >
              {t.texto}
              {cuantos !== undefined && cuantos > 0 && (
                <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${
                  activa ? "bg-brass-50 text-brass-700" : "bg-paper-100 text-ink-500"
                }`}>
                  {cuantos}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Resumen ───────────────────────────────────────────── */}
      {resumen && resumen.paquetes > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { n: resumen.pendientes, t: resumen.ventas > resumen.paquetes ? `cajas (${resumen.ventas} ventas)` : "por despachar" },
            { n: resumen.unidades, t: "unidades a bajar" },
            /*
             * Los atrasados desplazan a "referencias" cuando hay alguno: es el
             * número que decide cómo se trabaja la jornada —con tres atrasados
             * se empieza por ésos— y tiene que verse al abrir, no scrolleando.
             */
            resumen.atrasados > 0
              ? { n: resumen.atrasados, t: "pasados de hora", urgente: true }
              : { n: resumen.referencias, t: "referencias" },
            { n: resumen.flex, t: "con corte (Flex)", destacar: resumen.flex > 0 },
          ].map((c) => (
            <Card key={c.t} className="py-3">
              <p className={`font-display text-2xl font-semibold ${
                c.urgente ? "text-brick-500" : c.destacar ? "text-brass-700" : "text-ink-950"
              }`}>{c.n}</p>
              <p className={`text-xs ${c.urgente ? "text-brick-500" : "text-ink-500"}`}>{c.t}</p>
            </Card>
          ))}
        </div>
      )}

      {cargando && !jornada ? (
        <Card><p className="py-10 text-center text-sm text-ink-500">Cargando la jornada…</p></Card>
      ) : !jornada?.paquetes?.length ? (
        <Card>
          <div className="py-14 text-center">
            <Truck size={32} className="mx-auto text-ink-300" />
            <p className="mt-3 text-sm text-ink-600">
              {filtro === "historial"
                ? "Nada despachado ni confirmado por Mercado Libre en esta jornada."
                : "No hay envíos para despachar en esta jornada."}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              Los pedidos aparecen acá apenas entran de Mercado Libre o Jumpseller.
            </p>
          </div>
        </Card>
      ) : filtro === "historial" ? (
        <HistorialReconciliacion paquetes={jornada.paquetes} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-5">
          {/* ── 1. El recorrido ──────────────────────────────── */}
          <div className="lg:col-span-2">
            <Card className="p-0">
              <div className="border-b border-line px-4 py-3">
                <p className="font-display text-sm font-semibold text-ink-950">1 · Qué bajar del estante</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  Todo junto y sumado. Se recorre una vez y después se arman los paquetes.
                </p>
              </div>
              <ul className="divide-y divide-line">
                {jornada.consolidado.map((l) => (
                  <li key={`${l.locationId}-${l.sku}`} className="flex items-start gap-3 px-4 py-2.5">
                    <span className="mt-0.5 w-8 shrink-0 text-right font-display text-base font-semibold text-ink-950">
                      {l.unidades}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink-900">
                        <Articulo item={l} />
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-500">
                        <span className="tag-chip">{l.sku}</span>
                        {l.local && (
                          <span className="inline-flex items-center gap-0.5">
                            <MapPin size={10} /> {l.local}
                          </span>
                        )}
                        {/* En cuántos paquetes se reparte: dice si conviene
                            contar de una y repartir, o buscarlo de a uno. */}
                        {l.enPaquetes > 1 && <span>en {l.enPaquetes} paquetes</span>}
                        {/* Por qué son nueve cuando ningún pedido pidió nueve. */}
                        {l.deLosPacks?.length > 0 && (
                          <span className="text-brass-700">de {l.deLosPacks.join(", ")}</span>
                        )}
                      </p>
                      {l.sinResolver && (
                        <p className="mt-1 flex items-start gap-1 text-[11px] text-brick-500">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          Este SKU no está en Stocker: no se le descuenta stock.
                        </p>
                      )}
                      {l.sinApartar && (
                        <p className="mt-1 flex items-start gap-1 text-[11px] text-brick-500">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          Esta venta entró antes de que el artículo estuviera cargado, así que no
                          apartó stock. Reprocesala en su paquete antes de despachar.
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* ── 2. Los paquetes ──────────────────────────────── */}
          <div className="lg:col-span-3 space-y-3">
            <div>
              <p className="font-display text-sm font-semibold text-ink-950">2 · Armado de paquetes</p>
              <p className="mt-0.5 text-xs text-ink-500">
                Ordenados por hora de corte: primero lo que vence antes, no lo que llegó antes.
              </p>
            </div>

            {/*
              * La barra de tanda.
              *
              * Es el arreglo a lo que más cuesta de la jornada: con quince
              * cajas armadas, imprimir de a una e ir tocando quince botones de
              * despachar es la mitad del tiempo de cerrar el día. Se tilda, se
              * imprime todo junto y se despacha todo junto.
              *
              * Aparece sólo cuando hay algo tildado: una barra vacía arriba de
              * la lista es una fila más que leer todos los días.
              */}
            {puedeDespachar && jornada.paquetes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-paper-50 px-3 py-2">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-700">
                  <input
                    type="checkbox"
                    checked={elegidos.size > 0 && elegidos.size === jornada.paquetes.length}
                    ref={(el) => {
                      // Marca "algunos": ni todos ni ninguno. Sin esto, con tres
                      // de veinte tildados la casilla se ve igual que vacía.
                      if (el) el.indeterminate = elegidos.size > 0
                        && elegidos.size < jornada.paquetes.length;
                    }}
                    onChange={tildarTodos}
                  />
                  {elegidos.size > 0
                    ? `${elegidos.size} de ${jornada.paquetes.length} seleccionados`
                    : "Seleccionar todos"}
                </label>

                {elegidos.size > 0 && (
                  <>
                    <button
                      className="btn-ghost gap-1.5 px-3 py-1.5 text-xs"
                      onClick={imprimirEtiquetas}
                      disabled={trabajando !== null || conEtiqueta.length === 0}
                      title={conEtiqueta.length === 0
                        ? "Ninguno de los seleccionados tiene etiqueta de Mercado Libre"
                        : undefined}
                    >
                      <Printer size={13} />
                      {trabajando === "etiquetas"
                        ? "Abriendo…"
                        : `Etiquetas (${conEtiqueta.length})`}
                    </button>
                    <button
                      className="btn-accent gap-1.5 px-3 py-1.5 text-xs"
                      onClick={despacharTanda}
                      disabled={trabajando !== null || despachables.length === 0}
                    >
                      <PackageCheck size={13} />
                      {trabajando === "tanda"
                        ? "Despachando…"
                        : `Despachar ${despachables.length}`}
                    </button>
                    <button
                      className="btn-ghost px-2 py-1.5 text-xs"
                      onClick={() => setElegidos(new Set())}
                      disabled={trabajando !== null}
                    >
                      Limpiar
                    </button>
                  </>
                )}
              </div>
            )}

            {jornada.paquetes.map((p) => (
              <Card key={p.id} className={p.estadoEnvio === "con_faltante" ? "border-brick-500/40" : ""}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    {puedeDespachar && (
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={elegidos.has(p.claveEnvio)}
                        onChange={() => alternar(p.claveEnvio)}
                        aria-label={`Seleccionar el envío ${p.envioId || p.id}`}
                      />
                    )}
                  <div className="min-w-0">
                    {/*
                      * El título es el ENVÍO y no la venta: es lo que dice la
                      * etiqueta que se pega en la caja, y Mercado Libre junta
                      * varias compras del mismo comprador en un solo envío.
                      */}
                    <p className="font-display text-sm font-semibold text-ink-950">
                      {p.envioId ? `Envío ${p.envioId}` : `${p.plataforma} · ${p.ventas?.[0]?.pedidoExterno || ""}`}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {p.comprador || "Sin nombre de comprador"}
                    </p>
                    {/*
                      * Las ventas que van adentro. Con una sola se nombra al
                      * pasar; con varias hay que verlas, porque es lo que
                      * explica por qué la caja lleva de todo y lo que se
                      * chequea contra las etiquetas antes de cerrarla.
                      */}
                    {p.ventas?.length > 1 ? (
                      <p className="mt-1 text-xs text-brass-700">
                        {p.ventas.length} ventas en esta caja:{" "}
                        {p.ventas.map((v) => v.pedidoExterno).join(" · ")}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[11px] text-ink-400">
                        venta {p.ventas?.[0]?.pedidoExterno}
                      </p>
                    )}
                  </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.envioTipo === "flex" && (
                      <span className="rounded-full bg-brass-50 px-2 py-0.5 text-[11px] font-semibold text-brass-700">
                        FLEX
                      </span>
                    )}
                    {/*
                      * Viene de un día anterior y sigue sin salir. Se dice
                      * porque si no, en la lista se mezcla con los de hoy y
                      * parece que entró recién — sobre todo los que no traen
                      * hora de corte, que no llegan a marcarse "atrasado".
                      */}
                    {/*
                      * ML ya avisó al comprador que salió, pero acá todavía no
                      * se descontó el stock. Sigue habiendo que despacharla:
                      * lo que cambia es la urgencia, porque del otro lado ya
                      * están esperando el paquete.
                      */}
                    {p.mlYaDespacho && (
                      <span
                        className="rounded-full bg-brass-50 px-2 py-0.5 text-[11px] font-medium text-brass-700"
                        title="Mercado Libre ya la marcó despachada, seguramente al imprimir la etiqueta. Acá todavía falta descontar el stock."
                      >
                        ML ya la dio por despachada
                      </span>
                    )}
                    {p.deDiasAnteriores && !p.atrasado && (
                      <span className="rounded-full bg-paper-200 px-2 py-0.5 text-[11px] font-medium text-ink-700">
                        de días anteriores
                      </span>
                    )}
                    <Corte
                      cuando={p.despacharAntesDe}
                      minutos={p.minutosParaElCorte}
                      atrasado={p.atrasado}
                    />
                    <Estado situacion={p.situacion} />
                  </div>
                </div>

                <ul className="mt-3 space-y-1">
                  {p.items.map((i, idx) => (
                    <li key={`${p.id}-${i.sku}-${idx}`} className="text-sm">
                      <div className="flex items-start gap-2">
                        <span className="w-8 shrink-0 text-right font-display font-semibold text-ink-900">
                          {i.cantidad}×
                        </span>
                        <span className="min-w-0 flex-1">
                          <Articulo item={i} />
                          {/*
                            * Se dice que es un pack Y de cuántas unidades. "Pack"
                            * a secas no le dice a quien arma cuántas prendas van
                            * en la caja, que es justo lo que necesita saber.
                            */}
                          {i.esPack && (
                            <span className="ml-1.5 rounded bg-brass-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brass-700">
                              Pack{i.unidadesPorPack ? ` de ${i.unidadesPorPack}` : ""}
                            </span>
                          )}
                          <span className="ml-1.5 text-[11px] text-ink-500">
                            {i.sku}{i.local ? ` · ${i.local}` : ""}
                          </span>
                          {i.sinResolver && (
                            <span className="ml-1.5 text-[11px] text-brick-500">sin cargar en Stocker</span>
                          )}
                          {/*
                            * Distinto de "sin cargar": el artículo está, lo que
                            * falta es que esta venta aparte su mercadería. Se
                            * arregla con un botón, no dando de alta nada.
                            */}
                          {i.sinApartar && (
                            <span className="ml-1.5 text-[11px] text-brick-500">no apartó stock</span>
                          )}
                        </span>
                      </div>

                      {/*
                        * Un pack se pide como uno y se arma con tres. La línea
                        * sola deja al que arma sin saber qué poner en la caja.
                        */}
                      {i.esPack && i.componentes?.length > 0 && (
                        <ul className="ml-10 mt-0.5 space-y-0.5">
                          {i.componentes.map((c) => (
                            <li key={c.sku} className="flex items-start gap-2 text-xs text-ink-600">
                              <span className="w-6 shrink-0 text-right font-medium">{c.cantidad}×</span>
                              <span className="min-w-0 flex-1">
                                <Articulo item={c} />
                                <span className="ml-1.5 text-[11px] text-ink-400">{c.sku}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>

                {p.motivo && (
                  <p className="mt-2 rounded-md bg-brick-50 px-2.5 py-1.5 text-xs text-brick-500">
                    {p.motivo}
                  </p>
                )}

                {/*
                  * Los botones sólo donde tienen sentido: un paquete entregado
                  * o cancelado no se despacha, y ofrecerlo invita a tocarlo.
                  */}
                {/*
                  * El artículo existe pero la venta no apartó nada: entró antes
                  * de que estuviera cargado. Despachar así saca el paquete sin
                  * descontar una prenda, así que el arreglo va ANTES del botón
                  * de despachar y el de despachar queda bloqueado.
                  */}
                {puedeDespachar && p.items?.some((i) => i.sinApartar) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-brick-200 bg-brick-50 px-3 py-2">
                    <span className="text-xs text-brick-700">
                      Esta venta entró antes de que el artículo estuviera cargado, así que no
                      apartó stock. Si la despachás así, el paquete sale y el inventario no baja.
                    </span>
                    <button
                      className="btn-ghost gap-1.5 px-3 py-1.5 text-xs"
                      disabled={trabajando === p.id}
                      onClick={() => reprocesar(p)}
                    >
                      <RefreshCw size={13} /> Apartar el stock ahora
                    </button>
                  </div>
                )}

                {puedeDespachar && (p.situacion === "para_enviar" || p.situacion === "con_faltante") && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <button
                      className="btn-accent gap-1.5 px-3 py-1.5 text-xs"
                      disabled={trabajando === p.id || p.items?.some((i) => i.sinApartar)}
                      onClick={() => despachar(p)}
                    >
                      {trabajando === p.id
                        ? <><Loader2 size={13} className="animate-spin" /> Despachando…</>
                        : <><PackageCheck size={14} /> Despachar</>}
                    </button>
                    <button
                      className="btn-ghost gap-1.5 px-3 py-1.5 text-xs text-brick-500"
                      disabled={trabajando === p.id}
                      onClick={() => faltante(p)}
                    >
                      <PackageX size={14} /> No lo encuentro
                    </button>
                    {/*
                      * Se dice acá y no sólo después de tocar: quien despacha
                      * tiene que saber que ESE botón es el que mueve el stock.
                      * Hasta entonces la mercadería está apartada y sigue en el
                      * estante.
                      */}
                    <span className="text-[11px] text-ink-500">
                      Despachar descuenta el stock. Hasta ahora está apartado.
                    </span>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
