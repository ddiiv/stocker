import SectionTabs from "../ui/SectionTabs";

const TABS = [
  { to: "/dashboard", label: "Resumen", end: true },
  { to: "/dashboard/ventas", label: "Ventas en el tiempo" },
  { to: "/dashboard/productos", label: "Productos" },
  // El análisis del negocio: mes a mes, rankings y ABC, todo agregado en la base.
  { to: "/dashboard/analisis", label: "Análisis" },
];

export default function MetricsTabs() {
  return <SectionTabs tabs={TABS} />;
}
