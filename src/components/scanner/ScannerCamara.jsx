import { useEffect, useState } from "react";
import { X, Plus, Minus, Hash, AlertTriangle, Loader2 } from "lucide-react";
import CameraScanner from "./CameraScanner";
import ResumenEscaneo from "./ResumenEscaneo";

/*
 * Pantalla de escaneo con la cámara, a pantalla completa.
 *
 * Ocupa todo porque se usa parada en un pasillo, con una mano en el teléfono y
 * la otra en la mercadería. La versión chica que había antes —un recuadro
 * adentro de una tarjeta, con el historial en otra columna— funciona en un
 * monitor y no en un celular: al abrir la cámara, el historial queda dos
 * pantallas más abajo y nunca se ve mientras se escanea.
 *
 * Acá conviven las tres cosas que hacen falta al mismo tiempo: lo que ve la
 * cámara, qué hace cada lectura, y cuánto se lleva de cada producto.
 *
 * El modo y la cantidad se pueden cambiar sin salir. Es lo normal en una
 * recorrida: se recibe un remito, después se dan de baja dos rotos, y salir y
 * volver a entrar apaga y prende la cámara cada vez.
 */

const MODOS = [
  { value: "agregar", label: "Agregar", icon: Plus },
  { value: "quitar",  label: "Quitar",  icon: Minus },
  { value: "fijar",   label: "Fijar",   icon: Hash },
];

export default function ScannerCamara({
  onScan, onCerrar, historial, procesando, error,
  modo, setModo, cantidad, setCantidad,
}) {
  // El error del backend ("sólo hay 3 de X") se muestra un rato y se va solo:
  // escaneando no hay una mano libre para cerrar un cartel.
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

  const cant = Number(cantidad) || (modo === "fijar" ? 0 : 1);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950">
      {/* Barra superior */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={onCerrar}
          className="rounded-full bg-white/10 p-2 text-white" aria-label="Cerrar el escáner">
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-semibold text-white">Escanear stock</p>
          <p className="truncate text-[11px] text-white/50">
            {modo === "fijar" ? `Cada lectura deja el stock en ${cant}` : `Cada lectura ${modo === "agregar" ? "suma" : "resta"} ${cant}`}
          </p>
        </div>
        {procesando && <Loader2 size={18} className="animate-spin text-white/70" />}
      </div>

      {/* Cámara. Alto fijo en vh para que el resumen siempre quede a la vista:
          con alto flexible, en pantallas cortas la cámara se come todo. */}
      <div className="relative h-[46vh] shrink-0">
        <CameraScanner onScan={onScan} activo={!procesando} />

        {aviso && (
          <div className="absolute inset-x-3 top-3 flex items-start gap-2 rounded-md bg-brick-500/95 px-3 py-2 text-sm text-white shadow-lg">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{aviso}</span>
          </div>
        )}
      </div>

      {/* Controles */}
      <div className="flex items-center gap-2 border-y border-white/10 px-3 py-2.5">
        <div className="flex flex-1 rounded-md bg-white/10 p-1">
          {MODOS.map((m) => {
            const Icon = m.icon;
            const elegido = modo === m.value;
            return (
              <button key={m.value} type="button" onClick={() => setModo(m.value)} aria-pressed={elegido}
                className={`flex flex-1 items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-colors ${
                  elegido ? "bg-white text-ink-950" : "text-white/70"
                }`}>
                <Icon size={13} /> {m.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center rounded-md bg-white/10">
          <button type="button" aria-label="Menos cantidad"
            onClick={() => setCantidad(Math.max(modo === "fijar" ? 0 : 1, cant - 1))}
            className="px-3 py-2 text-white/70"><Minus size={14} /></button>
          <input
            type="number" inputMode="numeric" value={cantidad} aria-label="Cantidad por lectura"
            onChange={(e) => setCantidad(e.target.value)}
            className="w-12 bg-transparent text-center font-display text-base font-semibold tabular-nums text-white outline-none"
          />
          <button type="button" aria-label="Más cantidad"
            onClick={() => setCantidad(cant + 1)}
            className="px-3 py-2 text-white/70"><Plus size={14} /></button>
        </div>
      </div>

      {/* Resumen en vivo */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ResumenEscaneo
          historial={historial}
          oscuro
          vacio="Apuntá el recuadro a un código de barras."
        />
      </div>
    </div>
  );
}
