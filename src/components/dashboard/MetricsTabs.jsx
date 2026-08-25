import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/dashboard", label: "Resumen", end: true },
  { to: "/dashboard/ventas", label: "Ventas en el tiempo" },
  { to: "/dashboard/productos", label: "Productos" },
  // El análisis del negocio: mes a mes, rankings y ABC, todo agregado en la base.
  { to: "/dashboard/analisis", label: "Análisis" },
];

export default function MetricsTabs() {
  return (
    <div className="mb-5 flex w-fit rounded-md border border-line bg-paper-50 p-1">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
            }`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
