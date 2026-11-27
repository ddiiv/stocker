// Lo que comparten "Mis publicaciones", la calculadora y el cambio de precios.

export const $ = (n) => (n == null ? "—" : `$${Number(n).toLocaleString("es-AR", { maximumFractionDigits: 2 })}`);

export const mensajeDe = (e, base) => {
  if (e.response?.data?.message) return e.response.data.message;
  // Sin respuesta del backend (o corte del proxy) no se sabe si el cambio entró.
  return `${base} No llegó respuesta: actualizá la lista y revisá qué quedó hecho antes de repetir.`;
};

export function Alerta({ children, tono = "error" }) {
  if (!children) return null;
  const clases = { error: "bg-brick-50 text-brick-500", aviso: "bg-brass-50 text-brass-700", ok: "bg-teal-50 text-teal-600" };
  return <p role={tono === "error" ? "alert" : "status"} className={`break-words rounded-md px-3 py-2 text-sm ${clases[tono]}`}>{children}</p>;
}

/** El resultado ítem por ítem, con el error de Mercado Libre tal cual vino. */
export function ResultadoPorItem({ filas }) {
  return (
    <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
      {filas.map((f) => (
        <li key={f.itemId} className={`break-words ${f.mal ? "text-brick-500" : "text-ink-600"}`}>
          <span className="font-mono text-[11px]">{f.itemId}</span> — {f.texto}
        </li>
      ))}
    </ul>
  );
}

// En el orden en que se hace la cuenta.
const RENGLONES = [
  ["precio", "Precio publicado"],
  ["precioConDescuento", "Lo que paga el comprador"],
  ["cargoVender", "Cargo por vender"],
  ["costoCuotas", "Costo de cuotas"],
  ["costoFijo", "Costo fijo"],
  ["envio", "Envío a tu cargo"],
  ["impuestos", "Impuestos (parámetro)"],
];

export function Desglose({ d }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      {RENGLONES.map(([k, nombre]) => (
        <div key={k} className="contents">
          <dt className="text-ink-600">
            {nombre}
            {k === "precioConDescuento" && d.extraPct > 0 ? ` (con ${d.extraPct}% de descuento)` : ""}
            {k === "envio" && !d.llevaEnvio ? " (no lleva envío gratis)" : ""}
          </dt>
          <dd className="text-right text-ink-900">{$(d[k])}</dd>
        </div>
      ))}
      <dt className="border-t border-line pt-1 font-semibold text-ink-950">Te queda</dt>
      <dd className="border-t border-line pt-1 text-right font-semibold text-ink-950">{$(d.leQueda)}</dd>
      <dt className="text-ink-600">Ganancia sobre el costo</dt>
      <dd className={`text-right font-semibold ${d.bajoPiso ? "text-brick-500" : "text-teal-600"}`}>{d.ganancia == null ? "Sin costo cargado" : $(d.ganancia)}</dd>
    </dl>
  );
}
