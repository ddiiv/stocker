import { Outlet } from "react-router-dom";
import PlataformasTabs from "../../components/plataformas/PlataformasTabs";

/*
 * El armazón de Plataformas: las pestañas y, abajo, la pantalla de la pestaña.
 *
 * Cada pestaña tiene su propia puerta de permiso en App.jsx: estar en la
 * sección no alcanza para entrar a Mercado Libre si el cargo sólo tiene
 * ventas.
 */
export default function PlataformasLayout() {
  return (
    <div>
      <PlataformasTabs />
      <Outlet />
    </div>
  );
}
