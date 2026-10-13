import SectionTabs from "../ui/SectionTabs";
import { useAuth } from "../../context/AuthContext";
import { pestanasDeCuenta } from "../../utils/cuenta";

/*
 * Las pestañas de Configuración de la cuenta.
 *
 * Filtradas por quién mira: un empleado ve sólo "Sesiones", que es lo único de
 * la cuenta que le toca (ver utils/cuenta.js). Una sola pestaña igual se
 * dibuja: es la que dice en qué sección está parado.
 */
export default function CuentaTabs() {
  const { user } = useAuth();
  return <SectionTabs tabs={pestanasDeCuenta(user)} />;
}
