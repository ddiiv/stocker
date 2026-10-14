import { Navigate, useLocation } from "react-router-dom";
import { destinoDeRutaVieja } from "../../utils/plataformas";

/*
 * Lleva una dirección vieja a la nueva conservando la query y el ancla.
 *
 * Un <Navigate to="/plataformas/mercadolibre"> a secas tira `?ml_ok=1` y
 * `?ml_error=…`: quien vuelve de autorizar en Mercado Libre por la dirección
 * vieja (una autorización que arrancó antes del despliegue) caería en la
 * pantalla sin el aviso de "cuenta conectada" o del error, sin saber si
 * funcionó.
 */
export default function RedirigirRutaVieja() {
  const { pathname, search, hash } = useLocation();
  const destino = destinoDeRutaVieja(pathname, search, hash);
  return <Navigate to={destino || "/plataformas"} replace />;
}
