import { useEffect, useMemo, useState } from "react";
import {
  Check, Camera, X, Loader2, Tag, PackageCheck, AlertTriangle, ArrowUpDown, Truck,
} from "lucide-react";
import CameraScanner from "../scanner/CameraScanner";
import {
  fetchDisponibilidad, registrarFaltante, despacharPedido, etiquetasDeIngreso,
} from "../../services/depositoService";
import { mensajeDeError } from "../../utils/errores";

/*
 * Armado de un pedido en el depósito.
 *
 * El trabajo real es caminar el estante con el teléfono y una caja, así que la
 * pantalla está pensada para eso: una lista de lo que hay que juntar, un tilde
 * por artículo, y la cámara para no tener que buscar cada SKU a mano.
 *
 * RESTRICCIÓN CENTRAL: escanear acá NO agrega stock.
 *
 * Es mercadería que ya está registrada; el escaneo sólo marca "esto ya lo puse
 * en la caja". Por eso usa `CameraScanner`, que devuelve el código leído y
 * nada más, y no el escáner de la sección de stock, que sí mueve inventario.
 * Si el escaneo sumara stock, cada armado de pedido inflaría el depósito.
 *
 * Lo que falta va en su propia lista, porque es otro trabajo: ahí el empleado
 * dice qué encontró físicamente sin registrar, y eso sí genera etiquetas y
 * sube stock —por el circuito de ingreso, con su documento.
 */

const ORDENES = [
  { key: "estado", label: "Con y sin stock" },
  { key: "color",  label: "Color" },
  { key: "talle",  label: "Talle" },
];

export default function ArmadoPedido({ pedidoId, onCerrar, onDespachado }) {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  // itemId → unidades ya puestas en la caja
  const [contado, setContado] = useState({});
  const [escaneando, setEscaneando] = useState(false);
  const [ultimaLectura, setUltimaLectura] = useState(null);

  // Faltantes: qué encontró el empleado en el estante, sin registrar.
  const [encontrado, setEncontrado] = useState({});
  const [orden, setOrden] = useState("estado");

  async function cargar() {
    setCargando(true); setError("");
    try {
      const d = await fetchDisponibilidad(pedidoId);
      setDatos(d);
      // Arranca con lo que se puede mandar ya marcado en cero: el tilde lo pone
      // la persona al meter la prenda en la caja, no el sistema por adelantado.
      setContado({});
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo cargar el pedido."));
    }
    setCargando(false);
  }
  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pedidoId]);

  const conStock = useMemo(() => (datos?.lineas || []).filter((l) => l.cubre > 0), [datos]);
  const sinStock = useMemo(() => (datos?.lineas || []).filter((l) => l.falta > 0), [datos]);

  /* El orden lo elige quien camina el estante: por talle si está ordenado por
     talle, por color si está por color. */
  const ordenar = (lista) => [...lista].sort((a, b) => {
    if (orden === "color") return String(a.color || "").localeCompare(String(b.color || ""), "es");
    if (orden === "talle") return String(a.talle || "").localeCompare(String(b.talle || ""), "es", { numeric: true });
    return (b.cubre - a.cubre) || String(a.sku).localeCompare(String(b.sku));
  });

  const puesto = (l) => contado[l.itemId] ?? 0;
  const listo = (l) => puesto(l) >= l.cubre;
  const todoListo = conStock.length > 0 && conStock.every(listo);
  const totalPuesto = conStock.reduce((s, l) => s + Math.min(puesto(l), l.cubre), 0);
  const totalAPoner = conStock.reduce((s, l) => s + l.cubre, 0);

  const marcar = (l, n) =>
    setContado((c) => ({ ...c, [l.itemId]: Math.max(0, Math.min(n, l.cubre)) }));

  /*
   * Una lectura de la cámara suma una unidad a esa línea. Nada más.
   *
   * Si el código no está en el pedido se avisa en vez de ignorarlo: escanear
   * algo que no va en esta caja es justamente el error que hay que atajar.
   */
  /*
   * Primero el SKU, después el código de barras.
   *
   * Las etiquetas propias llevan el SKU impreso, así que ése es el camino
   * normal. Pero la mercadería puede llegar con la etiqueta del proveedor, que
   * trae un EAN distinto: buscar sólo por SKU dejaría al empleado tecleando a
   * mano justamente cuando la caja viene sin reetiquetar.
   */
  const buscarPorCodigo = (lista, codigo) => {
    const c = codigo.toLowerCase();
    return lista.find((l) => l.sku?.toLowerCase() === c)
        || lista.find((l) => l.codigoBarras && String(l.codigoBarras).toLowerCase() === c);
  };

  function alEscanear(codigo) {
    const limpio = String(codigo || "").trim();
    const linea = buscarPorCodigo(conStock, limpio);
    if (!linea) {
      const enFaltantes = buscarPorCodigo(sinStock, limpio);
      setUltimaLectura({
        ok: false,
        texto: enFaltantes
          ? `${limpio} está en el pedido pero sin stock cargado. Cargalo abajo antes de ponerlo en la caja.`
          : `${limpio} no pertenece a este pedido.`,
      });
      return;
    }
    if (puesto(linea) >= linea.cubre) {
      setUltimaLectura({ ok: false, texto: `${linea.sku} ya está completo (${linea.cubre}).` });
      return;
    }
    // Se avisa cuando entró por EAN: si el SKU no coincide con lo que dice la
    // etiqueta pegada, conviene que quien arma lo sepa.
    const porEan = linea.sku?.toLowerCase() !== limpio.toLowerCase();
    marcar(linea, puesto(linea) + 1);
    setUltimaLectura({
      ok: true,
      texto: `${linea.sku} · ${puesto(linea) + 1} de ${linea.cubre}${porEan ? " (leído por código de barras)" : ""}`,
    });
  }

  async function despachar() {
    setTrabajando(true); setError(""); setAviso("");
    try {
      const envios = conStock.map((l) => ({ itemId: l.itemId, cantidad: Math.min(puesto(l), l.cubre) }));
      const r = await despacharPedido(pedidoId, envios);
      setAviso(r.mensaje);
      await onDespachado?.();
      onCerrar?.();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo despachar el pedido."));
    }
    setTrabajando(false);
  }

  async function cargarEncontrado() {
    const items = Object.entries(encontrado)
      .map(([variantId, cantidad]) => ({ productVariantId: Number(variantId), cantidad: Number(cantidad) || 0 }))
      .filter((i) => i.cantidad > 0);
    if (!items.length) { setError("Marcá cuántas unidades encontraste de cada artículo."); return; }

    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await registrarFaltante(pedidoId, items);
      setEncontrado({});
      await cargar();

      /*
       * Las etiquetas bajan solas, en el acto.
       *
       * El SKU no se inventa: es el de la variante, que ya existe desde que se
       * creó el producto padre. Lo único que falta es el papel para pegarle a
       * cada prenda, una etiqueta por unidad, igual que en Stock → Etiquetas.
       *
       * Se descarga sin pedirlo porque es el paso siguiente del mismo trabajo:
       * se contó, se cargó, ahora hay que etiquetar. Dejarlo como un botón
       * aparte es dejar mercadería registrada y sin marcar.
       */
      const total = items.reduce((n, i) => n + i.cantidad, 0);
      try {
        const blob = await etiquetasDeIngreso(r.ingresoId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `etiquetas-${r.numero}.pdf`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        setAviso(`Cargado como ${r.numero}. Se descargaron ${total} etiqueta${total === 1 ? "" : "s"}: pegalas antes de poner la mercadería en la caja.`);
      } catch (eEtiq) {
        // El stock ya subió: que falle el PDF no puede parecer que falló todo.
        setAviso(`Cargado como ${r.numero}, pero no se pudieron generar las etiquetas: ${eEtiq.message}`);
      }
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo cargar la mercadería."));
    }
    setTrabajando(false);
  }

  if (cargando) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (!datos) return <p className="text-sm text-brick-500">{error || "No se pudo cargar."}</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso && <p className="rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{aviso}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-display text-base font-semibold text-ink-950">
            Armar {datos.pedido.numero}
          </p>
          <p className="text-xs text-ink-500">
            {datos.pedido.deposito?.nombre} → {datos.pedido.local?.nombre} ·{" "}
            {datos.resumen.unidadesDisponibles} de {datos.resumen.unidadesPedidas} unidades disponibles
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setEscaneando((v) => !v)}>
            {escaneando ? <><X size={15} /> Cerrar cámara</> : <><Camera size={15} /> Escanear</>}
          </button>
          <button className="btn-ghost" onClick={onCerrar}>Volver</button>
        </div>
      </div>

      {escaneando && (
        <div className="rounded-md border border-line bg-paper-100 p-3">
          <p className="mb-2 text-xs text-ink-600">
            <strong>Escanear acá no agrega stock.</strong> Esta mercadería ya está registrada:
            cada lectura sólo marca que la pusiste en la caja.
          </p>
          <CameraScanner onScan={alEscanear} activo />
          {ultimaLectura && (
            <p className={`mt-2 text-sm ${ultimaLectura.ok ? "text-teal-600" : "text-brick-500"}`}>
              {ultimaLectura.ok ? <Check size={14} className="mr-1 inline" /> : <AlertTriangle size={14} className="mr-1 inline" />}
              {ultimaLectura.texto}
            </p>
          )}
        </div>
      )}

      {/* ── Lo que hay que juntar ── */}
      <div className="card p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <p className="font-display text-sm font-semibold text-ink-950">
            <PackageCheck size={15} className="mr-1 inline text-teal-600" />
            En la caja: {totalPuesto} de {totalAPoner}
          </p>
          <div className="flex items-center gap-1 text-xs text-ink-500">
            <ArrowUpDown size={13} />
            {ORDENES.map((o) => (
              <button key={o.key}
                className={`rounded px-2 py-0.5 ${orden === o.key ? "bg-ink-950 text-paper-50" : "hover:bg-paper-200"}`}
                onClick={() => setOrden(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {conStock.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-500">
            No hay nada de este pedido cargado en el depósito. Registrá abajo lo que encuentres en el estante.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-2 font-medium">Artículo</th>
                  <th className="px-2 py-2 text-right font-medium">Pide</th>
                  <th className="px-2 py-2 text-right font-medium">Mandás</th>
                  <th className="px-2 py-2 text-center font-medium">En la caja</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {ordenar(conStock).map((l) => (
                  <tr key={l.itemId} className={`border-b border-line last:border-0 ${listo(l) ? "bg-teal-50/40" : ""}`}>
                    <td className="px-4 py-2">
                      <p className="text-ink-900">{l.titulo || l.descripcion}</p>
                      <p className="text-xs text-ink-500">
                        {[l.color, l.talle].filter(Boolean).join(" · ")}
                        {(l.color || l.talle) ? " · " : ""}
                        <span className="font-mono">{l.sku}</span>
                      </p>
                    </td>
                    <td className="px-2 py-2 text-right text-ink-700">{l.pedida}</td>
                    <td className="px-2 py-2 text-right font-medium text-ink-900">
                      {l.cubre}
                      {l.falta > 0 && <span className="ml-1 text-xs text-brass-800">(faltan {l.falta})</span>}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <input type="number" min="0" max={l.cubre}
                          className="input w-16 py-1 text-center"
                          value={puesto(l)}
                          onChange={(e) => marcar(l, Number(e.target.value))} />
                        {/* Marcar todo de una: con seis del mismo talle, tildar
                            de a uno es perder tiempo. */}
                        <button className="btn-ghost px-1.5 py-1" title="Marcar completo"
                          onClick={() => marcar(l, l.cubre)}>
                          <Check size={13} />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {listo(l) && <Check size={15} className="inline text-teal-600" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p className="text-xs text-ink-500">
            {todoListo
              ? "Todo junto. Al despachar, el stock sale del depósito y queda en camino."
              : `Faltan ${totalAPoner - totalPuesto} unidades por poner en la caja.`}
          </p>
          <button className="btn-accent" disabled={trabajando || totalPuesto === 0} onClick={despachar}>
            {trabajando ? <><Loader2 size={15} className="animate-spin" /> Despachando…</>
              : <><Truck size={15} /> Despachar {totalPuesto} unidades</>}
          </button>
        </div>
      </div>

      {/* ── Lo que falta: stock que puede estar sin registrar ── */}
      {sinStock.length > 0 && (
        <div className="card p-0">
          <div className="border-b border-line px-4 py-3">
            <p className="font-display text-sm font-semibold text-ink-950">
              <AlertTriangle size={15} className="mr-1 inline text-brass-800" />
              Sin stock cargado ({sinStock.length})
            </p>
            <p className="mt-1 text-xs text-ink-500">
              El sistema no tiene estas unidades. Si están en el estante sin registrar, poné cuántas
              encontraste: se cargan al depósito y baja el PDF con una etiqueta por unidad, con el
              SKU que ya tiene cada variante. Lo que no encuentres, dejalo en cero — el pedido sale
              igual con lo que haya.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-2 font-medium">Artículo</th>
                  <th className="px-2 py-2 text-right font-medium">Falta</th>
                  <th className="px-2 py-2 text-right font-medium">En otros lugares</th>
                  <th className="px-2 py-2 text-center font-medium">Encontré</th>
                </tr>
              </thead>
              <tbody>
                {ordenar(sinStock).map((l) => (
                  <tr key={l.itemId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <p className="text-ink-900">{l.titulo || l.descripcion}</p>
                      <p className="text-xs text-ink-500">
                        {[l.color, l.talle].filter(Boolean).join(" · ")}
                        {(l.color || l.talle) ? " · " : ""}
                        <span className="font-mono">{l.sku}</span>
                      </p>
                    </td>
                    <td className="px-2 py-2 text-right font-medium text-brass-800">{l.falta}</td>
                    <td className="px-2 py-2 text-right text-xs text-ink-500">
                      {l.enOtrosLugares > 0 ? `${l.enOtrosLugares} en otros locales` : "—"}
                    </td>
                    <td className="px-2 py-2">
                      <input type="number" min="0"
                        className="input mx-auto w-20 py-1 text-center"
                        value={encontrado[l.productVariantId] ?? ""}
                        placeholder="0"
                        onChange={(e) => setEncontrado((x) => ({ ...x, [l.productVariantId]: e.target.value }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end border-t border-line px-4 py-3">
            <button className="btn-accent" disabled={trabajando} onClick={cargarEncontrado}>
              {trabajando ? <><Loader2 size={15} className="animate-spin" /> Cargando…</>
                : <><Tag size={15} /> Cargar y generar etiquetas</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
