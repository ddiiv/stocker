import { useCallback, useEffect, useState } from "react";
import {
  Truck, Printer, RefreshCw, PackageCheck, PackageX, Clock,
  AlertTriangle, Check, MapPin, Loader2,
} from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import AvisoError from "../components/ui/AvisoError";
import {
  fetchJornada, abrirPdfJornada, despacharPaquete, marcarFaltante,
} from "../services/enviosService";
import { fetchLocalesDeVenta } from "../services/employeeService";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";

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

/*
 * Cuánto falta para el corte.
 *
 * En minutos y no en "a las 18:00": lo que hace falta saber parado en el
 * depósito es si quedan tres horas o veinte minutos, y esa cuenta la tiene que
 * hacer la pantalla, no la persona.
 */
function Corte({ cuando }) {
  if (!cuando) return null;
  const faltan = Math.round((new Date(cuando).getTime() - Date.now()) / 60000);
  const vencido = faltan < 0;
  const apura = faltan >= 0 && faltan <= 90;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        vencido ? "bg-brick-50 text-brick-500"
          : apura ? "bg-brass-50 text-brass-700"
            : "bg-paper-100 text-ink-600"
      }`}
      title={`Corte a las ${hora(cuando)}`}
    >
      <Clock size={11} />
      {vencido
        ? `venció hace ${Math.abs(faltan)} min`
        : faltan < 90
          ? `faltan ${faltan} min`
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
  const [filtro, setFiltro] = useState("para_enviar");

  const [locales, setLocales] = useState([]);
  const [jornada, setJornada] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [aviso, setAviso] = useState("");
  const [trabajando, setTrabajando] = useState(null);   // id del paquete en curso
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
      setError(e);
      setJornada(null);
    } finally {
      setCargando(false);
    }
  }, [fecha, locationId, soloFlex, dias, filtro]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { fetchLocalesDeVenta().then(setLocales).catch(() => setLocales([])); }, []);

  async function despachar(p) {
    setTrabajando(p.id); setError(null); setAviso("");
    try {
      const r = await despacharPaquete(p.id);
      setAviso(r.mensaje);
      await cargar();
    } catch (e) {
      setError(e);
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
      setError(e);
    } finally {
      setTrabajando(null);
    }
  }

  async function imprimir() {
    setImprimiendo(true); setError(null);
    try {
      await abrirPdfJornada(filtros);
    } catch (e) {
      setError(e);
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
          <div>
            <label className="label">Día</label>
            <input type="date" className="input h-9 w-40 text-sm"
              value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </div>
          <div>
            <label className="label">Local</label>
            <select className="input h-9 w-52 text-sm"
              value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Todos</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={soloFlex} onChange={(e) => setSoloFlex(e.target.checked)} />
            Sólo los que tienen corte (Flex)
          </label>
          <div>
            <label className="label">Alcance</label>
            <select className="input h-9 w-44 text-sm"
              value={dias} onChange={(e) => setDias(Number(e.target.value))}>
              <option value={0}>Sólo hoy</option>
              <option value={2}>Hoy y 2 días</option>
              <option value={7}>Próximos 7 días</option>
              <option value={30}>Próximos 30 días</option>
            </select>
          </div>
        </div>
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
            { n: resumen.referencias, t: "referencias" },
            { n: resumen.flex, t: "con corte (Flex)", destacar: resumen.flex > 0 },
          ].map((c) => (
            <Card key={c.t} className="py-3">
              <p className={`font-display text-2xl font-semibold ${c.destacar ? "text-brass-700" : "text-ink-950"}`}>{c.n}</p>
              <p className="text-xs text-ink-500">{c.t}</p>
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
            <p className="mt-3 text-sm text-ink-600">No hay envíos para despachar en esta jornada.</p>
            <p className="mt-1 text-xs text-ink-500">
              Los pedidos aparecen acá apenas entran de Mercado Libre o Jumpseller.
            </p>
          </div>
        </Card>
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

            {jornada.paquetes.map((p) => (
              <Card key={p.id} className={p.estadoEnvio === "con_faltante" ? "border-brick-500/40" : ""}>
                <div className="flex flex-wrap items-start justify-between gap-2">
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
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.envioTipo === "flex" && (
                      <span className="rounded-full bg-brass-50 px-2 py-0.5 text-[11px] font-semibold text-brass-700">
                        FLEX
                      </span>
                    )}
                    <Corte cuando={p.despacharAntesDe} />
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
                {puedeDespachar && (p.situacion === "para_enviar" || p.situacion === "con_faltante") && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <button
                      className="btn-accent gap-1.5 px-3 py-1.5 text-xs"
                      disabled={trabajando === p.id}
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
