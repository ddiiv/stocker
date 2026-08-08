import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/stock", label: "Productos", end: true },
  { to: "/stock/variantes", label: "Variantes" },
  { to: "/stock/escanear", label: "Escanear stock" },
];

export default function StockTabs() {
  return (
    <div className="mb-5 flex rounded-md border border-line bg-paper-50 p-1 w-fit">
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
