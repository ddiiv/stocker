import SectionTabs from "../ui/SectionTabs";

const TABS = [
  { to: "/facturacion", label: "Facturas", end: true },
  { to: "/facturacion/cuits", label: "CUITs del negocio" },
];

export default function BillingTabs() {
  return <SectionTabs tabs={TABS} />;
}
