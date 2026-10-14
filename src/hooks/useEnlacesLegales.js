import { useEffect, useState } from "react";
import { cargarEnlacesLegales } from "../utils/legales.js";

/*
 * Las direcciones de los textos legales para una pantalla: {} mientras carga
 * o si el backend no las tiene, así `enlaces.terminos` es undefined y la
 * pantalla muestra el texto sin enlace. Ver utils/legales.js.
 */
export default function useEnlacesLegales() {
  const [enlaces, setEnlaces] = useState({});
  useEffect(() => {
    let vigente = true;
    cargarEnlacesLegales().then((e) => { if (vigente && e) setEnlaces(e); });
    return () => { vigente = false; };
  }, []);
  return enlaces;
}
