import { useAuth } from "../../context/AuthContext";
import { canEdit } from "../../utils/permissions";
import SectionTabs from "../ui/SectionTabs";

/*
 * Pestañas de Stock, filtradas por permiso.
 *
 * `nivel: "editar"` marca las que sólo sirven a quien puede modificar stock.
 * Mostrárselas a un vendedor que sólo mira es ofrecerle una puerta que el
 * router le va a cerrar: entra, rebota a "sin permiso" y no entiende por qué
 * estaba el enlace.
 *
 * Ver el stock —incluido el de todos los locales, sus movimientos y sus
 * etiquetas— alcanza con permiso de ver: es información del negocio y cualquier
 * empleado la necesita para atender.
 */
const TABS = [
  { to: "/stock", label: "Productos", end: true },
  { to: "/stock/por-local", label: "Por local" },
  { to: "/stock/variantes", label: "Variantes", nivel: "editar" },
  { to: "/stock/sku", label: "Confección de SKU" },
  { to: "/stock/escanear", label: "Escanear stock", nivel: "editar" },
  { to: "/stock/movimientos", label: "Movimientos" },
  // Va acá y no escondida: un negativo sin regularizar hace que el inventario
  // de ese artículo no sirva para decidir reposición.
  { to: "/stock/a-regularizar", label: "A regularizar" },
  /*
   * Los packs son artículos con SKU propio pero sin stock propio: se arman con
   * lo que hay de otros. Van en Stock y no en una sección aparte porque quien
   * los arma está mirando el inventario, y lo que decide es de qué prendas se
   * va a descontar.
   */
  { to: "/stock/packs", label: "Packs" },
  { to: "/stock/etiquetas", label: "Etiquetas" },
];

export default function StockTabs() {
  const { user } = useAuth();
  const puedeEditar = canEdit(user, "stock");
  const visibles = TABS.filter((t) => t.nivel !== "editar" || puedeEditar);

  return <SectionTabs tabs={visibles} />;
}
