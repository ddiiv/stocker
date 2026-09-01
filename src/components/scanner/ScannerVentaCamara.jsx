import { useEffect, useState } from "react";
import { X, Plus, Minus, AlertTriangle, Loader2, ShoppingCart } from "lucide-react";
import CameraScanner from "./CameraScanner";

/*
 * Cobrar escaneando con la cámara del teléfono.
 *
 * El mostrador tiene lector USB; el resto del negocio no. Una feria, un local
 * chico, el día que el lector se rompe, o simplemente atender del otro lado de
 * la mesa: en todos esos casos hay un teléfono y no hay lector. Es el mismo
 * escaneo que ya se usa para stock, puesto a vender.
 *
 * Ocupa toda la pantalla porque se usa parado y con una mano. Arriba lo que ve
 * la cámara; abajo el carrito armándose, que es lo que hay que poder mirar sin
 * salir: si una lectura sumó a la línea equivocada, se ve en el momento y no
 * después de cerrar.
 *
 * Un código leído se ignora dos segundos, igual que en stock. Dos prendas
 * iguales seguidas son normales acá, así que en vez de acortar esa espera
 * —que con la cámara apoyada en la etiqueta cargaría de a una por segundo—
 * cada línea tiene su botón de +1, que es más rápido que volver a apuntar.
 */

export default function ScannerVentaCamara({
  onScan, onCerrar, items, onCantidad, precioDe, formatCurrency,
  total, error, procesando, resaltado,
}) {
  /*
   * El error se muestra un rato y se va solo.
   *
   * Escaneando no hay una mano libre para cerrar un cartel, y el error típico
   * —un código que no está en el catálogo— se resuelve apuntando a otra cosa.
   */
  const [aviso, setAviso] = useState("");
  useEffect(() => {
    if (!error) return;
    setAviso(error);
    const t = setTimeout(() => setAviso(""), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // Escapar cierra, y mientras está abierto no se scrollea la página de atrás.
  useEffect(() => {
    const tecla = (e) => e.key === "Escape" && onCerrar();
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", tecla);
    return () => {
      document.body.style.overflow = previo;
      window.removeEventListener("keydown", tecla);
    };
  }, [onCerrar]);

  const unidades = items.reduce((s, i) => s + i.cantidad, 0);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onCerrar}
          className="rounded-full bg-white/10 p-2 text-white"
          aria-label="Cerrar el escáner"
        >
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-semibold text-white">Escanear para vender</p>
          <p className="truncate text-[11px] text-white/50">
            Cada lectura suma una unidad al carrito
          </p>
        </div>
        {procesando && <Loader2 size={18} className="animate-spin text-white/70" />}
      </div>

      {/* Alto fijo en vh para que el carrito siempre quede a la vista: con alto
          flexible, en pantallas cortas la cámara se come todo y se escanea a
          ciegas. */}
      <div className="relative h-[42vh] shrink-0">
        <CameraScanner onScan={onScan} activo={!procesando} />

        {aviso && (
          <div className="absolute inset-x-3 top-3 flex items-start gap-2 rounded-md bg-brick-500/95 px-3 py-2 text-sm text-white shadow-lg">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{aviso}</span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/10">
        {items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <ShoppingCart size={28} className="mx-auto text-white/25" />
            <p className="mt-3 text-sm text-white/50">
              Apuntá el recuadro al código de barras de la prenda.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-white/10">
            {items.map((i) => (
              <li
                key={i.id}
                className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${
                  resaltado === i.id ? "bg-white/10" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    {i.titulo}
                    {i.esFeria && (
                      <span className="ml-1 rounded bg-brass-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brass-100">
                        Evento
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-white/50">
                    {i.sku}
                    {[i.variante1Valor, i.variante2Valor].filter(Boolean).length > 0 && (
                      <span> · {[i.variante1Valor, i.variante2Valor].filter(Boolean).join(" · ")}</span>
                    )}
                    <span> · {formatCurrency(precioDe(i))} c/u</span>
                  </p>
                  {/*
                    * Que no alcance el stock del local no frena la venta, pero
                    * hay que verlo mientras se arma y no al cobrar: es el
                    * momento en que el cliente todavía está eligiendo.
                    */}
                  {i.enLocal !== null && i.enLocal !== undefined && i.cantidad > Number(i.enLocal) && (
                    <p className="text-[11px] text-brick-300">Sin stock acá: {i.enLocal}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center rounded-md bg-white/10">
                  <button
                    type="button"
                    onClick={() => onCantidad(i.id, -1)}
                    className="px-2.5 py-1.5 text-white/70"
                    aria-label={`Quitar una unidad de ${i.titulo}`}
                  >
                    <Minus size={14} />
                  </button>
                  <span className="w-7 text-center font-display text-sm font-semibold tabular-nums text-white">
                    {i.cantidad}
                  </span>
                  <button
                    type="button"
                    onClick={() => onCantidad(i.id, 1)}
                    className="px-2.5 py-1.5 text-white/70"
                    aria-label={`Sumar una unidad de ${i.titulo}`}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        * El pie cierra el escáner, no cobra.
        *
        * Cobrar pide elegir medio de pago, a veces cliente, a veces factura:
        * meter todo eso acá sería una segunda pantalla de venta manteniéndose
        * en paralelo a la que ya existe. Se vuelve al punto de venta con el
        * carrito armado, que es donde está el cobro de siempre.
        */}
      <div className="flex items-center gap-3 border-t border-white/10 px-3 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wide text-white/40">
            {unidades} {unidades === 1 ? "unidad" : "unidades"}
          </p>
          <p className="font-display text-lg font-semibold tabular-nums text-white">
            {formatCurrency(total)}
          </p>
        </div>
        <button
          type="button"
          onClick={onCerrar}
          disabled={items.length === 0}
          className="rounded-md bg-brass-500 px-5 py-2.5 font-display text-sm font-semibold text-ink-950 disabled:opacity-40"
        >
          Listo, cobrar
        </button>
      </div>
    </div>
  );
}
