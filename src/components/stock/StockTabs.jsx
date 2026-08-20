import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/stock", label: "Productos", end: true },
  { to: "/stock/variantes", label: "Variantes" },
  { to: "/stock/sku", label: "Confección de SKU" },
  { to: "/stock/escanear", label: "Escanear stock" },
  { to: "/stock/movimientos", label: "Movimientos" },
  { to: "/stock/etiquetas", label: "Etiquetas" },
];

/*
 * Las pestañas scrollean de costado cuando no entran.
 *
 * Son cinco y en un celular de 375 px suman más de 430: sin scroll, la última
 * queda fuera de la pantalla y no hay forma de llegar a ella — ni tocándola ni
 * arrastrando, porque el desbordamiento estaba en `visible`. En el celular eso
 * dejaba "Movimientos" y "Escanear stock" inaccesibles, que son justamente las
 * dos que se usan desde el teléfono.
 *
 * `w-fit` se conserva para que en pantallas grandes no ocupe todo el ancho, y
 * `max-w-full` es lo que le permite achicarse y scrollear en las chicas.
 */
export default function StockTabs() {
  return (
    <div className="mb-5 flex w-fit max-w-full overflow-x-auto rounded-md border border-line bg-paper-50 p-1
                    [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
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
