import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import { getMlDescripcion, setMlDescripcion, renombrarMl } from "../../services/mercadolibreService";
import { enTandas } from "../../utils/tandas";
import { Alerta, ResultadoPorItem, mensajeDe } from "./comun";

const TOPE_DESCRIPCION = 50000;
// El largo real lo dice la categoría y lo controla el servidor; este es el habitual.
const LARGO_HABITUAL = 60;

export function DescripcionModal({ itemId, delGrupo, onClose, onCambio }) {
  const [texto, setTexto] = useState("");
  const [aTodo, setATodo] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [fallaLectura, setFallaLectura] = useState("");
  const [intento, setIntento] = useState(0);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const [resultados, setResultados] = useState([]);

  useEffect(() => {
    let vigente = true;
    setCargando(true); setFallaLectura("");
    getMlDescripcion(itemId)
      .then((r) => { if (vigente) setTexto(r.texto); })
      .catch((e) => { if (vigente) setFallaLectura(e.response?.data?.message || "No se pudo leer la descripción."); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [itemId, intento]);

  async function guardar() {
    const ids = aTodo ? delGrupo : [itemId];
    if (!window.confirm(`Se REEMPLAZA la descripción en Mercado Libre de ${ids.length} publicación(es). Lo que tenían escrito se pierde. ¿Seguimos?`)) return;
    setGuardando(true); setError(""); setResultados([]);
    const hechos = [];
    try {
      await enTandas(ids, 10, (parte) => setMlDescripcion(parte, texto), (r) => {
        hechos.push(...r.resultados);
        setResultados([...hechos]);
      });
    } catch (e) {
      setError(`${mensajeDe(e, "No se pudo guardar.")} Sin confirmar: ${e.sinMandar.join(", ")}.`);
    }
    setGuardando(false);
    onCambio();
  }

  const mal = resultados.filter((r) => !r.ok).length;
  return (
    <Modal open onClose={guardando ? () => {} : onClose} title={`Descripción de ${itemId}`} width="max-w-2xl">
      <div className="space-y-3">
        {cargando && <p className="text-sm text-ink-600">Leyendo la descripción…</p>}
        {fallaLectura && (
          <>
            <Alerta>{fallaLectura}</Alerta>
            <button type="button" className="btn-ghost" onClick={() => setIntento((n) => n + 1)}>Reintentar</button>
          </>
        )}
        {!cargando && !fallaLectura && (
          <>
            <label className="block text-xs text-ink-600">Descripción (sólo texto, sin formato)
              <textarea className="input mt-1" rows={12} maxLength={TOPE_DESCRIPCION} value={texto} onChange={(e) => setTexto(e.target.value)} disabled={guardando} />
            </label>
            {!texto.trim() && <p className="text-xs text-ink-500">No puede quedar vacía.</p>}
            {delGrupo.length > 1 && (
              <label className="flex items-start gap-2 text-sm text-ink-800">
                <input type="checkbox" className="mt-1" checked={aTodo} onChange={(e) => setATodo(e.target.checked)} disabled={guardando} />
                Poner este mismo texto a todo el grupo ({delGrupo.length} publicaciones)
              </label>
            )}
          </>
        )}
        <Alerta>{error}</Alerta>
        {resultados.length > 0 && (
          <>
            <Alerta tono={mal ? "aviso" : "ok"}>{resultados.length - mal} cambiada(s){mal ? `, ${mal} con error` : ""}.</Alerta>
            <ResultadoPorItem filas={resultados.map((r) => ({ itemId: r.itemId, mal: !r.ok, texto: r.ok ? "cambiada" : r.error }))} />
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={guardando}>Cerrar</button>
          <button type="button" className="btn-accent" onClick={guardar} disabled={guardando || cargando || Boolean(fallaLectura) || !texto.trim()}>
            {guardando ? "Guardando…" : "Guardar en Mercado Libre"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const ESTADO_NOMBRE = { cambiada: "cambiada", "sin-cambios": "ya tenía ese nombre", "no-intentada": "no se intentó" };

export function NombreModal({ grupo, delGrupo, onClose, onCambio }) {
  const [nombre, setNombre] = useState(grupo.nombre);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const [r, setR] = useState(null);

  async function guardar(e) {
    e.preventDefault();
    if (!window.confirm(`Se le cambia el nombre en Mercado Libre a ${delGrupo.length} publicación(es) por "${nombre.trim()}". Se hace de a una y se corta en el primer error. ¿Seguimos?`)) return;
    setGuardando(true); setError("");
    try { setR(await renombrarMl(delGrupo, nombre.trim())); }
    catch (err) { setError(mensajeDe(err, "No se pudo cambiar el nombre.")); }
    setGuardando(false);
    onCambio();
  }

  return (
    <Modal open onClose={guardando ? () => {} : onClose} title="Cambiar el nombre" width="max-w-xl">
      <form onSubmit={guardar} className="space-y-3">
        <Alerta tono="aviso">
          Mercado Libre puede no dejar cambiarlo, sobre todo si la publicación ya tuvo ventas. Si rechaza a mitad de camino,
          el grupo queda partido en dos: te avisamos cuántas cambiaron.
        </Alerta>
        <label className="block text-xs text-ink-600">Nombre nuevo para las {delGrupo.length} publicación(es)
          <input className="input mt-1" value={nombre} onChange={(e) => setNombre(e.target.value)} disabled={guardando || Boolean(r)} />
        </label>
        <p className={`text-xs ${nombre.trim().length > LARGO_HABITUAL ? "text-brick-500" : "text-ink-500"}`}>
          {nombre.trim().length} caracteres. Lo habitual es hasta {LARGO_HABITUAL}; si la categoría admite otro largo, se controla al guardar.
        </p>
        <Alerta>{error}</Alerta>
        {r && (
          <>
            <Alerta tono={r.cortado ? "error" : "ok"}>{r.mensaje}</Alerta>
            <ResultadoPorItem filas={r.resultados.map((x) => ({ itemId: x.itemId, mal: x.estado === "error" || x.estado === "no-intentada", texto: x.error || ESTADO_NOMBRE[x.estado] || x.estado }))} />
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={guardando}>Cerrar</button>
          {!r && (
            <button className="btn-accent" disabled={guardando || !nombre.trim() || nombre.trim() === grupo.nombre}>
              {guardando ? "Cambiando…" : "Cambiar el nombre"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
