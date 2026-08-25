import { useEffect, useState } from "react";
import {
  Truck, Check, X, Loader2, PackageCheck, Send, Store, Ban, PackageSearch, AlertTriangle,
} from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import SelectorArticulos from "../components/deposito/SelectorArticulos";
import {
  fetchLugares, fetchPedidos, crearPedido, aprobarPedido, rechazarPedido,
  cancelarPedido, despacharPedido, recibirPedido, fetchEnTransito,
  fetchDisponibilidad, aprobarPedidoParcial, fetchSaldos, resolverSaldo,
} from "../services/depositoService";
import { mensajeDeError } from "../utils/errores";
import { formatDateTime } from "../utils/formatters";
import { useAuth } from "../context/AuthContext";
import { canEdit, esAdministradorTotal } from "../utils/permissions";

/*
 * Pedidos de reposición: del local al depósito y la mercadería de vuelta.
 *
 * Una sola pantalla con tres bandejas, porque el mismo pedido va pasando de
 * mano en mano y cada uno necesita ver dónde está parado:
 *
 *   Por aprobar   oficina firma o rechaza con un motivo.
 *   Por preparar  reposición carga lo que hay y despacha.
 *   En camino     el local confirma lo que efectivamente llegó.
 *
 * La mercadería despachada sale del depósito y entra al local recién al
 * confirmar: en el medio está EN CAMINO, que es donde está de verdad.
 */

const CHIP = {
  pendiente:        "badge-low",
  aprobado:         "badge-low",
  enviado:          "badge-low",
  recibido:         "badge-ok",
  recibido_parcial: "badge-low",
  rechazado:        "badge-out",
  cancelado:        "badge-out",
};

const NOMBRE_ESTADO = {
  pendiente: "por aprobar",
  aprobado: "por preparar",
  enviado: "en camino",
  recibido: "recibido",
  recibido_parcial: "recibido parcial",
  rechazado: "rechazado",
  cancelado: "cancelado",
};

export default function ReposicionPage() {
  const { user } = useAuth();
  const esDuenio     = esAdministradorTotal(user);
  const puedeOperar  = canEdit(user, "reposicion");
  const puedeAprobar = canEdit(user, "aprobaciones") || esDuenio;

  const [lugares, setLugares] = useState({ depositos: [], locales: [] });
  const [pedidos, setPedidos] = useState([]);
  const [transito, setTransito] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [tab, setTab] = useState("pendiente");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  // Alta de pedido
  const [abrirAlta, setAbrirAlta] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [depositoId, setDepositoId] = useState("");
  const [items, setItems] = useState([]);
  const [notas, setNotas] = useState("");
  const [guardando, setGuardando] = useState(false);

  // Cantidades que se están editando en un despacho o una recepción.
  const [borrador, setBorrador] = useState({});

  /*
   * Disponibilidad del pedido que oficina está por firmar.
   *
   * Aprobar sin ver si la mercadería está lleva a que el pedido viaje al
   * depósito, ahí se descubra que falta, y vuelva. Se pide al abrir el
   * detalle, no de entrada para todos: son tantas consultas como pedidos.
   */
  const [disp, setDisp] = useState({});      // pedidoId → disponibilidad
  const [viendo, setViendo] = useState(null);

  /*
   * Saldos sin resolver: lo que se pidió y nunca salió del depósito.
   *
   * Va arriba de todo y no en una pestaña más: un saldo olvidado es mercadería
   * que el local sigue necesitando y que nadie está preparando, y no se
   * descubre solo — el pedido ya figura cerrado.
   */
  const [saldos, setSaldos] = useState([]);

  async function cargarSaldos() {
    try { setSaldos(await fetchSaldos()); } catch { setSaldos([]); }
  }

  async function decidirSaldo(p, aceptar) {
    const motivo = aceptar
      ? null
      : prompt(`Dar de baja el saldo de ${p.numero} (${p.unidadesPendientes} unidades).\n\n¿Por qué no se va a mandar? El local necesita saberlo.`);
    if (!aceptar && !motivo?.trim()) return;
    setError(""); setAviso("");
    try {
      const r = await resolverSaldo(p.id, aceptar, motivo);
      setAviso(r.mensaje);
      await cargarSaldos();
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo resolver el saldo."));
    }
  }

  async function verDisponibilidad(p) {
    if (viendo === p.id) { setViendo(null); return; }
    setViendo(p.id);
    if (disp[p.id]) return;
    try {
      const d = await fetchDisponibilidad(p.id);
      setDisp((x) => ({ ...x, [p.id]: d }));
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo consultar el stock del depósito."));
    }
  }

  /*
   * Aprobar mira el stock real. Si falta, el backend frena con STOCK_PARCIAL y
   * acá se pregunta: mandar lo que hay, o rechazar.
   */
  async function aprobarConChequeo(p) {
    setError(""); setAviso("");
    try {
      const r = await aprobarPedido(p.id);
      setAviso(r.mensaje);
      setBorrador({}); await cargar();
    } catch (e) {
      const d = e.response?.data;
      if (d?.codigo === "STOCK_PARCIAL") {
        const ok = confirm(
          `${d.message}\n\n¿Aprobarlo igual? El depósito va a mandar lo que haya y el faltante queda anotado.`,
        );
        if (!ok) return;
        try {
          const r2 = await aprobarPedidoParcial(p.id);
          setAviso(`${r2.mensaje} Se aprobó como parcial.`);
          setBorrador({}); await cargar();
        } catch (e2) { setError(mensajeDeError(e2, "No se pudo aprobar.")); }
        return;
      }
      if (d?.codigo === "SIN_STOCK_TOTAL") {
        setError(d.message);
        return;
      }
      setError(mensajeDeError(e, "No se pudo aprobar."));
    }
  }

  async function cargar() {
    setCargando(true);
    try {
      const r = await fetchPedidos({ estado: tab === "historial" ? undefined : tab, limit: 50 });
      setPedidos(r.data || []);
    } catch { setPedidos([]); }
    setCargando(false);
  }

  useEffect(() => {
    fetchLugares().then((r) => {
      setLugares(r);
      if ((r.locales || []).length === 1) setLocationId(String(r.locales[0].id));
      if ((r.depositos || []).length === 1) setDepositoId(String(r.depositos[0].id));
    }).catch(() => {});
    fetchEnTransito().then(setTransito).catch(() => {});
    cargarSaldos();
  }, []);

  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);

  const necesitaLocal    = esDuenio && (lugares.locales || []).length > 1;
  const necesitaDeposito = (lugares.depositos || []).length > 1;

  async function guardarPedido() {
    if (!items.length) { setError("Agregá al menos un artículo."); return; }
    if (necesitaLocal && !locationId) { setError("Elegí para qué local es el pedido."); return; }
    if (necesitaDeposito && !depositoId) { setError("Elegí de qué depósito sale."); return; }
    setGuardando(true); setError(""); setAviso("");
    try {
      const p = await crearPedido({
        locationId: locationId ? Number(locationId) : undefined,
        depositoId: depositoId ? Number(depositoId) : undefined,
        notas: notas.trim() || null,
        items: items.filter((i) => i.cantidad > 0).map((i) => ({
          productVariantId: i.productVariantId, cantidad: i.cantidad,
        })),
      });
      setItems([]); setNotas(""); setAbrirAlta(false);
      setAviso(`${p.numero} enviado. Queda esperando la aprobación de oficina.`);
      setTab("pendiente");
      await cargar();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo crear el pedido.");
    }
    setGuardando(false);
  }

  async function accion(fn, pedido, ...args) {
    setError(""); setAviso("");
    try {
      const r = await fn(pedido.id, ...args);
      setAviso(r.mensaje);
      setBorrador({});
      await cargar();
      fetchEnTransito().then(setTransito).catch(() => {});
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo completar la acción.");
    }
  }

  function pedirMotivo(pedido, verbo) {
    const motivo = prompt(`¿Por qué ${verbo} ${pedido.numero}? El local necesita saber el motivo.`);
    return motivo?.trim() ? motivo : null;
  }

  /* Cantidad propuesta de una línea: lo que se está editando, o el valor por
     defecto —lo pedido al despachar, lo enviado al recibir—. */
  const valorDe = (item, campo) =>
    borrador[`${campo}-${item.id}`] ?? (campo === "envio" ? item.cantidadPedida : item.cantidadEnviada);

  const setValor = (item, campo, v) =>
    setBorrador((b) => ({ ...b, [`${campo}-${item.id}`]: Math.max(0, Number(v) || 0) }));

  const TABS = [
    { key: "pendiente", label: "Por aprobar" },
    { key: "aprobado",  label: "Por preparar" },
    { key: "enviado",   label: "En camino" },
    { key: "historial", label: "Historial" },
  ];

  return (
    <div>
      <PageHeader
        title="Reposición"
        subtitle="Lo que cada local pide y lo que el depósito le manda"
        actions={puedeOperar && (
          <button className="btn-accent" onClick={() => setAbrirAlta((v) => !v)}>
            <Store size={15} /> {abrirAlta ? "Cerrar" : "Pedir reposición"}
          </button>
        )}
      />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso && <p className="mb-4 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{aviso}</p>}

      {abrirAlta && puedeOperar && (
        <Card className="mb-5">
          <h3 className="mb-4 font-display text-base font-semibold text-ink-950">Pedido nuevo</h3>
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {necesitaLocal && (
              <div>
                <label className="label">Para el local</label>
                <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Elegí…</option>
                  {(lugares.locales || []).map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                </select>
              </div>
            )}
            {necesitaDeposito && (
              <div>
                <label className="label">Sale del depósito</label>
                <select className="input" value={depositoId} onChange={(e) => setDepositoId(e.target.value)}>
                  <option value="">Elegí…</option>
                  {(lugares.depositos || []).map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* El stock que se muestra es el del depósito: es lo que hay para
              mandar, y pedir lo que no hay sólo alarga el circuito. */}
          <SelectorArticulos
            items={items}
            onChange={setItems}
            etiquetaCantidad="Pido"
            locationId={depositoId ? Number(depositoId) : null}
          />

          <div className="mt-4">
            <label className="label">Nota (opcional)</label>
            <input className="input" placeholder="Ej: se agotó el blanco, urgente para el finde"
              value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>
          <div className="mt-4 flex justify-end">
            <button className="btn-accent" disabled={guardando || !items.length} onClick={guardarPedido}>
              {guardando ? <><Loader2 size={15} className="animate-spin" /> Enviando…</> : <><Send size={15} /> Enviar pedido</>}
            </button>
          </div>
        </Card>
      )}

      {/* Primero los saldos: es lo único que nadie está mirando por su cuenta. */}
      {saldos.length > 0 && (
        <Card className="mb-5 border-brass-300 bg-brass-50/40 p-0">
          <div className="border-b border-brass-300 px-4 py-3">
            <h3 className="font-display text-sm font-semibold text-brass-800">
              <AlertTriangle size={15} className="mr-1 inline" />
              Saldos sin resolver ({saldos.length})
            </h3>
            <p className="mt-0.5 text-xs text-brass-800">
              Se pidió y nunca salió del depósito. El pedido ya cerró, así que esto no lo va a
              reclamar nadie: hay que decidir si se manda o se da de baja.
            </p>
          </div>
          <div className="divide-y divide-brass-300/60">
            {saldos.map((p) => (
              <div key={p.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-ink-900">
                    <span className="font-mono">{p.numero}</span>
                    <span className="ml-2 text-xs text-ink-600">→ {p.local?.nombre}</span>
                    <span className="ml-2 text-xs font-medium text-brass-800">
                      {p.unidadesPendientes} unidades sin salir
                    </span>
                  </p>
                  <ul className="mt-1 text-xs text-ink-600">
                    {p.faltantes.map((f) => (
                      <li key={f.sku}>
                        {f.descripcion || f.sku} — se pidieron {f.pedida}, salieron {f.enviada},{" "}
                        <strong>faltan {f.saldo}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
                {puedeAprobar && (
                  <div className="flex shrink-0 gap-1">
                    <button className="btn-accent px-2 py-1 text-xs" onClick={() => decidirSaldo(p, true)}>
                      <Check size={13} /> Mandar el saldo
                    </button>
                    <button className="btn-ghost px-2 py-1 text-xs text-brick-500" onClick={() => decidirSaldo(p, false)}>
                      <X size={13} /> Dar de baja
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {transito.length > 0 && (
        <Card className="mb-5">
          <h3 className="mb-2 font-display text-sm font-semibold text-ink-950">
            <Truck size={15} className="mr-1 inline" /> En camino
          </h3>
          <p className="mb-2 text-xs text-ink-500">
            Salió del depósito y todavía no se confirmó en el local. No está contado en ningún stock.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {transito.map((t, i) => (
              <span key={`${t.pedidoId}-${t.productVariantId}-${i}`} className="badge badge-low">
                {t.descripcion || t.sku} × {t.cantidad}
              </span>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.key}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${tab === t.key ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"}`}
            onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {cargando ? (
        <div className="card h-40 animate-pulse bg-paper-200/60" />
      ) : pedidos.length === 0 ? (
        <Card><p className="py-10 text-center text-sm text-ink-500">No hay pedidos en esta bandeja.</p></Card>
      ) : (
        <div className="space-y-3">
          {pedidos.map((p) => (
            <Card key={p.id} className="p-0">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-ink-900">
                    <span className="font-mono">{p.numero}</span>
                    <span className={`badge ${CHIP[p.estado] || ""} ml-2`}>{NOMBRE_ESTADO[p.estado] || p.estado}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {p.deposito?.nombre} → <strong className="text-ink-700">{p.local?.nombre}</strong>
                    {" · "}{formatDateTime(p.createdAt)}
                    {p.solicitadoPor ? ` · pidió ${p.solicitadoPor.nombre}` : ""}
                  </p>
                  {p.notas && <p className="mt-1 text-xs text-ink-600">{p.notas}</p>}
                  {p.motivoRechazo && <p className="mt-1 text-xs text-brick-500">Rechazado: {p.motivoRechazo}</p>}
                  {p.notaRecepcion && <p className="mt-1 text-xs text-brass-800">Recepción: {p.notaRecepcion}</p>}
                </div>

                <div className="flex shrink-0 flex-wrap gap-1">
                  {p.estado === "pendiente" && (
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => verDisponibilidad(p)}>
                      <PackageSearch size={13} /> {viendo === p.id ? "Ocultar stock" : "Ver stock"}
                    </button>
                  )}
                  {puedeAprobar && p.estado === "pendiente" && (
                    <>
                      <button className="btn-accent px-2 py-1 text-xs" onClick={() => aprobarConChequeo(p)}>
                        <Check size={13} /> Aprobar
                      </button>
                      <button className="btn-ghost px-2 py-1 text-xs text-brick-500"
                        onClick={() => { const m = pedirMotivo(p, "rechazás"); if (m) accion(rechazarPedido, p, m); }}>
                        <X size={13} /> Rechazar
                      </button>
                    </>
                  )}
                  {puedeOperar && p.estado === "pendiente" && (
                    <button className="btn-ghost px-2 py-1 text-xs text-ink-500"
                      onClick={() => { const m = pedirMotivo(p, "cancelás"); if (m) accion(cancelarPedido, p, m); }}>
                      <Ban size={13} /> Cancelar
                    </button>
                  )}
                  {puedeOperar && p.estado === "aprobado" && (
                    <button className="btn-accent px-2 py-1 text-xs"
                      onClick={() => accion(despacharPedido, p,
                        (p.items || []).map((i) => ({ itemId: i.id, cantidad: valorDe(i, "envio") })))}>
                      <Truck size={13} /> Despachar
                    </button>
                  )}
                  {puedeOperar && p.estado === "enviado" && (
                    <button className="btn-accent px-2 py-1 text-xs"
                      onClick={() => {
                        const recepciones = (p.items || []).map((i) => ({
                          itemId: i.id,
                          cantidad: valorDe(i, "recibo"),
                          notaFaltante: borrador[`nota-${i.id}`] || null,
                        }));
                        const faltan = recepciones.some((r, idx) => r.cantidad < (p.items[idx]?.cantidadEnviada || 0));
                        const nota = faltan
                          ? prompt("Falta mercadería. ¿Qué pasó? Queda anotado para oficina.") || null
                          : null;
                        accion(recibirPedido, p, recepciones, nota);
                      }}>
                      <PackageCheck size={13} /> Confirmar recepción
                    </button>
                  )}
                </div>
              </div>

              {/* Qué hay en el depósito, para decidir con el dato a la vista. */}
              {viendo === p.id && (
                <div className="border-b border-line bg-paper-100 px-4 py-3">
                  {!disp[p.id] ? (
                    <p className="text-xs text-ink-500">Consultando el depósito…</p>
                  ) : (
                    <>
                      <p className="mb-2 text-xs">
                        {disp[p.id].resumen.estado === "completo" ? (
                          <span className="text-teal-600">
                            <Check size={13} className="mr-1 inline" />
                            Está todo en el depósito: {disp[p.id].resumen.unidadesDisponibles} unidades.
                          </span>
                        ) : disp[p.id].resumen.estado === "sin_stock" ? (
                          <span className="text-brick-500">
                            No hay nada de este pedido cargado en el depósito.
                          </span>
                        ) : (
                          <span className="text-brass-800">
                            Hay {disp[p.id].resumen.completas} de {disp[p.id].resumen.lineas} artículos completos.
                            Faltan {disp[p.id].resumen.unidadesFaltantes} unidades en {disp[p.id].resumen.conFalta}.
                          </span>
                        )}
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[420px] text-xs">
                          <tbody>
                            {disp[p.id].lineas.map((l) => (
                              <tr key={l.itemId} className="border-t border-line/60">
                                <td className="py-1 text-ink-700">
                                  {l.titulo || l.descripcion}
                                  <span className="ml-1 font-mono text-ink-400">{l.sku}</span>
                                </td>
                                <td className="py-1 text-right text-ink-500">pide {l.pedida}</td>
                                <td className="py-1 text-right text-ink-700">hay {l.enDeposito}</td>
                                <td className={`py-1 text-right ${l.falta > 0 ? "text-brick-500" : "text-teal-600"}`}>
                                  {l.falta > 0 ? `faltan ${l.falta}` : "completo"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="overflow-x-auto px-4 py-2">
                <table className="w-full min-w-[460px] text-xs">
                  <thead>
                    <tr className="text-left uppercase tracking-wide text-ink-600">
                      <th className="py-1 font-medium">Artículo</th>
                      <th className="py-1 text-right font-medium">Pedido</th>
                      {p.estado !== "pendiente" && <th className="py-1 text-right font-medium">Enviado</th>}
                      {["enviado", "recibido", "recibido_parcial"].includes(p.estado) && (
                        <th className="py-1 text-right font-medium">Recibido</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(p.items || []).map((i) => {
                      const falta = i.cantidadRecibida < i.cantidadEnviada;
                      return (
                        <tr key={i.id} className="border-t border-line/60">
                          <td className="py-1.5 text-ink-700">
                            {i.descripcion || i.sku}
                            <span className="ml-1 font-mono text-ink-400">{i.sku}</span>
                            {i.notaFaltante && <p className="text-brick-500">{i.notaFaltante}</p>}
                          </td>
                          <td className="py-1.5 text-right text-ink-900">{i.cantidadPedida}</td>

                          {p.estado === "aprobado" && puedeOperar ? (
                            <td className="py-1.5 text-right">
                              {/* Lo que se manda arranca en lo pedido y se baja
                                  si no hay: es lo que pasa en el 90% de los casos. */}
                              <input type="number" min="0" max={i.cantidadPedida}
                                className="input w-20 py-0.5 text-right text-xs"
                                value={valorDe(i, "envio")}
                                onChange={(e) => setValor(i, "envio", e.target.value)} />
                            </td>
                          ) : p.estado !== "pendiente" ? (
                            <td className="py-1.5 text-right text-ink-900">{i.cantidadEnviada}</td>
                          ) : null}

                          {p.estado === "enviado" && puedeOperar ? (
                            <td className="py-1.5 text-right">
                              <input type="number" min="0" max={i.cantidadEnviada}
                                className="input w-20 py-0.5 text-right text-xs"
                                value={valorDe(i, "recibo")}
                                onChange={(e) => setValor(i, "recibo", e.target.value)} />
                            </td>
                          ) : ["recibido", "recibido_parcial"].includes(p.estado) ? (
                            <td className={`py-1.5 text-right ${falta ? "text-brick-500" : "text-ink-900"}`}>
                              {i.cantidadRecibida}
                              {falta && (
                                <span className="ml-1">
                                  (falta{i.cantidadEnviada - i.cantidadRecibida === 1 ? "" : "n"}{" "}
                                  {i.cantidadEnviada - i.cantidadRecibida})
                                </span>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}

      {!cargando && pedidos.length === 0 && tab === "enviado" && (
        <p className="mt-3 text-center text-xs text-ink-500">
          <PackageSearch size={13} className="mr-1 inline" />
          Cuando el depósito despache un pedido, aparece acá para confirmar lo que llegó.
        </p>
      )}
    </div>
  );
}
