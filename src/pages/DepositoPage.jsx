import { useEffect, useState } from "react";
import {
  PackagePlus, Tag, Loader2, Check, X, Undo2, ClipboardList, Warehouse, ClipboardCheck, PackageCheck,
} from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import SelectorArticulos from "../components/deposito/SelectorArticulos";
import CargaPorSeries from "../components/deposito/CargaPorSeries";
import ArmadoPedido from "../components/deposito/ArmadoPedido";
import HistorialReposiciones from "../components/deposito/HistorialReposiciones";
import {
  fetchLugares, fetchIngresos, crearIngreso, etiquetasDeIngreso,
  aceptarIngreso, rechazarIngreso, anularIngreso, fetchPedidos,
} from "../services/depositoService";
import { formatDateTime } from "../utils/formatters";
import { useAuth } from "../context/AuthContext";
import { canEdit, esAdministradorTotal } from "../utils/permissions";

/*
 * Ingreso de mercadería nueva al depósito.
 *
 * Los dos planes que se usan en el piso, y la diferencia entre ellos es cuándo
 * sube el stock:
 *
 *   CON ETIQUETAS  se cuenta una vez, se generan las etiquetas y el stock sube
 *                  en el acto. La etiqueta impresa es la prueba de la cuenta;
 *                  volver a contar para "confirmar" es el doble trabajo que
 *                  este circuito viene a sacar. Si salió mal, se anula.
 *   SIN ETIQUETAS  se cuenta a mano y queda pendiente de que oficina lo acepte.
 */

const CHIP = {
  aplicado:  "badge-ok",
  pendiente: "badge-low",
  rechazado: "badge-out",
  anulado:   "badge-out",
};

export default function DepositoPage() {
  const { user } = useAuth();
  const puedeCargar  = canEdit(user, "deposito");
  const puedeAprobar = canEdit(user, "aprobaciones") || esAdministradorTotal(user);

  const [depositos, setDepositos] = useState([]);
  const [locationId, setLocationId] = useState("");
  const [origen, setOrigen] = useState("etiquetas");
  /*
   * Una sola lista de lo que se va a ingresar.
   *
   * Antes había dos —`items` sueltos y `curvas` sin expandir— y el total del
   * remito no estaba en ninguna pantalla: había que sumarlo de cabeza entre
   * las dos. Ahora la serie se expande a líneas al agregarla y todo cae acá.
   */
  const [items, setItems] = useState([]);
  const [notas, setNotas] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  /*
   * Los pedidos aprobados aparecen acá.
   *
   * Es lo que cierra el circuito: oficina aprueba y el trabajo llega al
   * depósito solo. Sin esto, el pedido quedaba esperando a que alguien del
   * local llamara por teléfono a avisar que lo habían aprobado.
   */
  const [pedidos, setPedidos] = useState([]);
  const [armando, setArmando] = useState(null);

  const [ingresos, setIngresos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState("");

  async function cargar() {
    setCargando(true);
    try {
      const r = await fetchIngresos({ estado: filtroEstado, limit: 50 });
      setIngresos(r.data || []);
    } catch { setIngresos([]); }
    setCargando(false);
  }

  useEffect(() => {
    fetchLugares()
      .then((r) => {
        setDepositos(r.depositos || []);
        // Con un solo depósito no hay decisión que tomar.
        if ((r.depositos || []).length === 1) setLocationId(String(r.depositos[0].id));
      })
      .catch(() => {});
  }, []);

  /*
   * Los pendientes se piden aparte del listado de abajo.
   *
   * Ese listado tiene un filtro que la persona mueve; si el aviso dependiera
   * de él, elegir "Aplicados" haría desaparecer los conteos sin firmar.
   */
  const [pendientes, setPendientes] = useState([]);

  async function cargarPendientes() {
    try {
      const r = await fetchIngresos({ estado: "pendiente", limit: 20 });
      setPendientes(r.data || []);
    } catch { setPendientes([]); }
  }

  async function cargarPedidos() {
    try {
      const r = await fetchPedidos({ estado: "aprobado", limit: 50 });
      setPedidos(r.data || []);
    } catch { setPedidos([]); }
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filtroEstado]);
  useEffect(() => { cargarPedidos(); cargarPendientes(); }, []);

  const necesitaElegirDeposito = depositos.length > 1;

  /*
   * Suma las líneas de una serie a lo que ya hay.
   *
   * Si una serie y una línea suelta caen sobre la misma variante se suman, que
   * es lo que hace el servidor desde siempre: dos renglones del mismo SKU en
   * un remito son la misma prenda contada dos veces.
   */
  function agregarLineas(nuevas) {
    setItems((prev) => {
      const porId = new Map(prev.map((i) => [i.productVariantId, { ...i }]));
      for (const l of nuevas) {
        const ya = porId.get(l.productVariantId);
        if (ya) ya.cantidad += l.cantidad;
        else porId.set(l.productVariantId, l);
      }
      return [...porId.values()];
    });
  }

  async function guardar() {
    if (!items.length) { setError("Agregá al menos un artículo."); return; }
    if (necesitaElegirDeposito && !locationId) { setError("Elegí en qué depósito estás cargando."); return; }
    setGuardando(true); setError(""); setAviso("");
    try {
      const ingreso = await crearIngreso({
        locationId: locationId ? Number(locationId) : undefined,
        origen, notas: notas.trim() || null,
        items: items.filter((i) => i.cantidad > 0).map((i) => ({
          productVariantId: i.productVariantId, cantidad: i.cantidad,
        })),
      });
      setItems([]); setNotas("");
      setAviso(origen === "etiquetas"
        ? `${ingreso.numero} cargado: el stock ya está en el depósito. Generá las etiquetas y pegalas en cada prenda.`
        : `${ingreso.numero} enviado a oficina. El stock sube cuando lo acepten.`);
      await cargar();
      await cargarPendientes();
      // Con etiquetas, el PDF es el paso siguiente del mismo trabajo.
      if (origen === "etiquetas") await descargarEtiquetas(ingreso.id, ingreso.numero);
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo registrar el ingreso.");
    }
    setGuardando(false);
  }

  async function descargarEtiquetas(id, numero) {
    try {
      const blob = await etiquetasDeIngreso(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `etiquetas-${numero}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || "No se pudieron generar las etiquetas.");
    }
  }

  async function resolver(accion, ingreso) {
    let motivo = null;
    if (accion !== "aceptar") {
      motivo = prompt(accion === "anular"
        ? `¿Por qué anulás ${ingreso.numero}? Queda en el historial y explica el movimiento de stock.`
        : `¿Por qué rechazás ${ingreso.numero}? Quien contó necesita saber qué corregir.`);
      if (!motivo?.trim()) return;
    }
    setError(""); setAviso("");
    try {
      const fn = accion === "aceptar" ? aceptarIngreso : accion === "anular" ? anularIngreso : rechazarIngreso;
      const r = await fn(ingreso.id, motivo);
      setAviso(r.mensaje);
      await cargar();
      await cargarPendientes();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo completar la acción.");
    }
  }

  return (
    <div>
      <PageHeader
        title="Depósito"
        subtitle="Ingreso de mercadería nueva: se cuenta una vez y de ahí salen el stock y las etiquetas"
      />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso && <p className="mb-4 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{aviso}</p>}

      {depositos.length === 0 && (
        <div className="mb-5">
          <EmptyState
            icon={Warehouse}
            title="No tenés ningún depósito"
            description="La mercadería nueva entra por un depósito y de ahí se transfiere a los locales. Marcá uno de tus locales como depósito desde Empleados → Locales."
          />
        </div>
      )}

      {/* ── Pedidos aprobados esperando que el depósito los arme ── */}
      {armando ? (
        <Card className="mb-5">
          <ArmadoPedido
            pedidoId={armando}
            onCerrar={() => setArmando(null)}
            onDespachado={async () => { await cargarPedidos(); await cargar(); }}
          />
        </Card>
      ) : pedidos.length > 0 && (
        <Card className="mb-5 p-0">
          <div className="border-b border-line px-4 py-3">
            <h3 className="font-display text-base font-semibold text-ink-950">
              <ClipboardCheck size={16} className="mr-1 inline text-teal-600" />
              Pedidos para preparar ({pedidos.length})
            </h3>
            <p className="mt-0.5 text-xs text-ink-500">
              Aprobados por oficina. Al entrar vas a ver qué hay para mandar y qué falta.
            </p>
          </div>
          <div className="divide-y divide-line">
            {pedidos.map((p) => {
              const unidades = (p.items || []).reduce((s, i) => s + i.cantidadPedida, 0);
              return (
                <button
                  key={p.id}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-paper-100"
                  onClick={() => setArmando(p.id)}
                >
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900">
                      <span className="font-mono">{p.numero}</span>
                      <span className="ml-2 text-xs text-ink-500">→ {p.local?.nombre}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {(p.items || []).length} artículo{(p.items || []).length === 1 ? "" : "s"} · {unidades} unidades
                      {p.notas ? ` · ${p.notas}` : ""}
                    </p>
                  </div>
                  <span className="btn-accent shrink-0 px-2 py-1 text-xs">
                    <PackageCheck size={13} /> Armar
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {/*
        * Los conteos esperando firma, arriba y visibles.
        *
        * Un ingreso "sin etiquetas" no sube stock hasta que oficina lo acepta.
        * Enterrado en el listado de abajo, nadie lo firma: el depósito cree
        * que ya cargó la mercadería y el sistema sigue sin tenerla. Acá se ve
        * apenas se entra, y dice quién tiene que hacer qué.
        */}
      {pendientes.length > 0 && !armando && (
        <Card className={`mb-5 p-0 ${puedeAprobar ? "border-brass-300 bg-brass-50/40" : ""}`}>
          <div className={`border-b px-4 py-3 ${puedeAprobar ? "border-brass-300" : "border-line"}`}>
            <h3 className={`font-display text-sm font-semibold ${puedeAprobar ? "text-brass-800" : "text-ink-950"}`}>
              <ClipboardList size={15} className="mr-1 inline" />
              {puedeAprobar
                ? `Conteos esperando tu firma (${pendientes.length})`
                : `Conteos enviados a oficina (${pendientes.length})`}
            </h3>
            <p className={`mt-0.5 text-xs ${puedeAprobar ? "text-brass-800" : "text-ink-500"}`}>
              {puedeAprobar
                ? "Se contaron a mano, sin etiquetas. El stock NO subió todavía: sube cuando los aceptes."
                : "Los contaste sin etiquetas. El stock sube cuando oficina los acepte; hasta entonces el depósito figura sin esa mercadería."}
            </p>
          </div>
          <div className="divide-y divide-line">
            {pendientes.map((ing) => {
              const unidades = (ing.items || []).reduce((s, i) => s + i.cantidad, 0);
              return (
                <div key={ing.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900">
                      <span className="font-mono">{ing.numero}</span>
                      <span className="ml-2 text-xs text-ink-500">
                        {(ing.items || []).length} artículo{(ing.items || []).length === 1 ? "" : "s"} · {unidades} unidades
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {ing.deposito?.nombre} · {formatDateTime(ing.createdAt)}
                      {ing.empleado ? ` · contó ${ing.empleado.nombre} ${ing.empleado.apellido || ""}` : ""}
                      {ing.notas ? ` · ${ing.notas}` : ""}
                    </p>
                    <ul className="mt-1 text-xs text-ink-600">
                      {(ing.items || []).slice(0, 4).map((it) => (
                        <li key={it.id}>{it.descripcion || it.sku} — {it.cantidad}</li>
                      ))}
                      {(ing.items || []).length > 4 && (
                        <li className="text-ink-400">y {(ing.items || []).length - 4} más…</li>
                      )}
                    </ul>
                  </div>
                  {puedeAprobar && (
                    <div className="flex shrink-0 gap-1">
                      <button className="btn-accent px-2 py-1 text-xs" onClick={() => resolver("aceptar", ing)}>
                        <Check size={13} /> Aceptar y subir stock
                      </button>
                      <button className="btn-ghost px-2 py-1 text-xs text-brick-500" onClick={() => resolver("rechazar", ing)}>
                        <X size={13} /> Rechazar
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {puedeCargar && depositos.length > 0 && !armando && (
        <Card className="mb-5">
          <h3 className="mb-4 font-display text-base font-semibold text-ink-950">
            <PackagePlus size={16} className="mr-1 inline" /> Ingreso nuevo
          </h3>

          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {necesitaElegirDeposito && (
              <div>
                <label className="label">Depósito</label>
                <select className={`input ${!locationId ? "border-brick-500" : ""}`}
                  value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Elegí…</option>
                  {depositos.map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="label">Cómo se contó</label>
              <div className="flex gap-2">
                <button type="button"
                  className={origen === "etiquetas" ? "btn-accent flex-1 justify-center" : "btn-ghost flex-1 justify-center"}
                  onClick={() => setOrigen("etiquetas")}>
                  <Tag size={14} /> Con etiquetas
                </button>
                <button type="button"
                  className={origen === "conteo" ? "btn-accent flex-1 justify-center" : "btn-ghost flex-1 justify-center"}
                  onClick={() => setOrigen("conteo")}>
                  <ClipboardList size={14} /> Sin etiquetas
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-500">
                {origen === "etiquetas"
                  ? "El stock sube ahora y se descarga el PDF de etiquetas. Si el conteo sale mal, se anula."
                  : "El conteo se manda a oficina y el stock NO sube todavía. Sube cuando lo acepten, con un clic desde esta misma pantalla — sin pasarle la lista por otro lado."}
              </p>
            </div>
          </div>

          {/*
            * Dos formas de cargar el mismo remito, una sola lista.
            *
            * Por series es como llega la mercadería del proveedor: conjuntos
            * completos de un modelo. Suelto es para lo que llega descabalado.
            * Lo que se arma por serie se expande a líneas y cae en la misma
            * tabla de abajo, así que el total de lo que se va a ingresar se
            * lee en un solo lado. Si una serie y una línea suelta caen sobre
            * la misma variante, se suman.
            */}
          <CargaPorSeries onAgregar={agregarLineas} />

          <div className="mt-4">
            <SelectorArticulos
              items={items}
              onChange={setItems}
              etiquetaCantidad="Unidades"
              locationId={locationId ? Number(locationId) : null}
            />
          </div>

          <div className="mt-4">
            <label className="label">Nota (opcional)</label>
            <input className="input" placeholder="Ej: camión del lunes, remito 4471"
              value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>

          {/*
            * El total del remito, a la vista.
            *
            * Con series de veinte unidades cada una, "cuántas prendas entran"
            * deja de ser evidente mirando los renglones. Es el número contra el
            * que alguien va a contar los bultos del camión.
            */}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
            {items.length > 0 && (
              <p className="mr-auto text-sm text-ink-600">
                <strong className="text-ink-950">{items.length}</strong> artículo{items.length === 1 ? "" : "s"}
                {" · "}
                <strong className="text-ink-950">
                  {items.reduce((n, i) => n + (Number(i.cantidad) || 0), 0)}
                </strong>{" "}
                unidades en total
              </p>
            )}
            <button className="btn-accent" disabled={guardando || !items.length} onClick={guardar}>
              {guardando ? <><Loader2 size={15} className="animate-spin" /> Guardando…</>
                : origen === "etiquetas" ? <><Tag size={15} /> Cargar y generar etiquetas</>
                : <><ClipboardList size={15} /> Enviar el conteo a oficina</>}
            </button>
          </div>
        </Card>
      )}

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="font-display text-base font-semibold text-ink-950">Ingresos</h3>
          <select className="input w-auto py-1 text-sm" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
            <option value="">Todos</option>
            <option value="pendiente">Pendientes</option>
            <option value="aplicado">Aplicados</option>
            <option value="rechazado">Rechazados</option>
            <option value="anulado">Anulados</option>
          </select>
        </div>

        {cargando ? (
          <div className="h-40 animate-pulse bg-paper-200/60" />
        ) : ingresos.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-500">No hay ingresos con ese filtro.</p>
        ) : (
          <div className="divide-y divide-line">
            {ingresos.map((ing) => (
              <div key={ing.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900">
                      <span className="font-mono">{ing.numero}</span>
                      <span className={`badge ${CHIP[ing.estado] || ""} ml-2`}>{ing.estado}</span>
                      <span className="ml-2 text-xs text-ink-500">
                        {ing.origen === "etiquetas" ? "con etiquetas" : "conteo a mano"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {ing.deposito?.nombre} · {formatDateTime(ing.createdAt)}
                      {ing.empleado ? ` · ${ing.empleado.nombre} ${ing.empleado.apellido || ""}` : ""}
                      {ing.notas ? ` · ${ing.notas}` : ""}
                    </p>
                    {ing.motivo && (
                      <p className="mt-1 text-xs text-brick-500">
                        {ing.estado === "anulado" ? "Anulado" : "Rechazado"}: {ing.motivo}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-1">
                    {ing.estado === "aplicado" && (
                      <button className="btn-ghost px-2 py-1 text-xs"
                        onClick={() => descargarEtiquetas(ing.id, ing.numero)}>
                        <Tag size={13} /> Etiquetas
                      </button>
                    )}
                    {puedeAprobar && ing.estado === "pendiente" && (
                      <>
                        <button className="btn-accent px-2 py-1 text-xs" onClick={() => resolver("aceptar", ing)}>
                          <Check size={13} /> Aceptar
                        </button>
                        <button className="btn-ghost px-2 py-1 text-xs text-brick-500" onClick={() => resolver("rechazar", ing)}>
                          <X size={13} /> Rechazar
                        </button>
                      </>
                    )}
                    {puedeAprobar && ing.estado === "aplicado" && (
                      <button className="btn-ghost px-2 py-1 text-xs text-brick-500" onClick={() => resolver("anular", ing)}>
                        <Undo2 size={13} /> Anular
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[360px] text-xs">
                    <tbody>
                      {(ing.items || []).map((it) => (
                        <tr key={it.id} className="border-t border-line/60">
                          <td className="py-1 text-ink-700">{it.descripcion || it.sku}</td>
                          <td className="py-1 text-right font-mono text-ink-500">{it.sku}</td>
                          <td className="w-16 py-1 text-right font-medium text-ink-900">{it.cantidad}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* El papel que alguien abre cuando el local dice "esto nunca llegó". */}
      <div className="mt-5">
        <HistorialReposiciones />
      </div>
    </div>
  );
}
