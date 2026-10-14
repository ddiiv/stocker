import { textoDeEstado } from "../../utils/plataformas";

/*
 * El estado de una conexión, como chip. Color y texto van juntos: el color
 * sirve para barrer la lista de un vistazo, el texto es lo que la hace legible
 * para quien no distingue los tonos.
 */
const TONOS = {
  ok: "badge-ok",
  neutro: "bg-paper-200 text-ink-700",
  plan: "badge-low",
  alerta: "badge-out",
};

export default function EstadoPlataforma({ plataforma }) {
  const { texto, tono } = textoDeEstado(plataforma);
  return <span className={`badge ${TONOS[tono] || TONOS.neutro}`}>{texto}</span>;
}
