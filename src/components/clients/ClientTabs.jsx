import SectionTabs from "../ui/SectionTabs";

const TABS = [
  { to: "/clientes", label: "Clientes", end: true },
  { to: "/clientes/cuentas", label: "Cuentas corrientes" },
];

export default function ClientTabs() {
  return <SectionTabs tabs={TABS} />;
}
