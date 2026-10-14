import SectionTabs from "../ui/SectionTabs";
import { useAuth } from "../../context/AuthContext";
import { pestanasDePlataformas } from "../../utils/plataformas";

/*
 * Las pestañas de Plataformas, filtradas por permiso (ver utils/plataformas.js).
 *
 * Van ARRIBA de la pantalla de cada pestaña y no debajo de su título, como en
 * Stock o en Facturación: Mercado Libre, Jumpseller y la bandeja mayorista
 * traen su propio encabezado y se reusan tal cual, sin tocarlas.
 */
export default function PlataformasTabs() {
  const { user } = useAuth();
  return <SectionTabs tabs={pestanasDePlataformas(user)} />;
}
