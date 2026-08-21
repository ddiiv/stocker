import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import Modal from "../ui/Modal";
import { fetchVariantTypes } from "../../services/variantTypeService";
import { variantesMasivo } from "../../services/productService";
import { fetchPos } from "../../services/employeeService";

/*
 * Alta de variantes eligiéndolas de la tabla maestra del negocio.
 *
 * Cargar talle por talle es lo que más tiempo lleva del alta de un producto, y
 * es donde aparecen los valores escritos distinto ("M", "m", "Mediano"). Acá se
 * tildan los valores y el servidor arma la combinatoria.
 *
 * Dos cosas que esta pantalla NO hace, y que están dichas en el aviso porque de
 * otro modo dan miedo:
 *
 *   - Destildar un valor que ya tiene variante no la borra. Sólo deja de
 *     proponerla. Sacar mercadería del catálogo se hace variante por variante.
 *   - Nada se duplica: lo que ya existe aparece marcado y se omite.
 *
 * La vista previa la calcula el backend con el mismo código que después graba,
 * así lo que se lee en pantalla es exactamente lo que va a quedar.
 */

const clave = (v) => String(v ?? "").trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function BulkVariantsModal({ open, onClose, group, onCreated }) {
  const productId = group?.variants?.[0]?.productId;

  const [tipos, setTipos] = useState([]);
  const [cargandoTipos, setCargandoTipos] = useState(false);
  // { [nombreEje]: Set(valores) }
  const [elegidos, setElegidos] = useState({});
  const [plan, setPlan] = useState(null);
  const [calculando, setCalculando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState("");

  const [stock, setStock] = useState(0);
  const [stockMinimo, setStockMinimo] = useState(5);
  const [locales, setLocales] = useState([]);
  const [locationId, setLocationId] = useState("");

  // Los ejes del producto: los define la variante de referencia, no la tabla
  // maestra. Un producto de Color/Talle no puede recibir uno por Sabor.
  const ejes = useMemo(() => {
    const v = group?.variants?.[0];
    return [v?.variante1Nombre, v?.variante2Nombre].filter(Boolean);
  }, [group]);

  // Qué combinaciones ya tiene el producto, para marcarlas en los chips.
  const yaUsados = useMemo(() => {
    const m = {};
    for (const eje of ejes) m[eje] = new Set();
    for (const v of group?.variants || []) {
      if (v.variante1Valor && m[ejes[0]]) m[ejes[0]].add(clave(v.variante1Valor));
      if (v.variante2Valor && m[ejes[1]]) m[ejes[1]].add(clave(v.variante2Valor));
    }
    return m;
  }, [group, ejes]);

  useEffect(() => {
    if (!open) return;
    setError(""); setPlan(null); setElegidos({}); setStock(0);
    setCargandoTipos(true);
    fetchVariantTypes().then(setTipos).catch(() => setTipos([])).finally(() => setCargandoTipos(false));
    fetchPos().then((ls) => {
      setLocales(ls);
      if (ls.length === 1) setLocationId(String(ls[0].id));
    }).catch(() => {});
  }, [open]);

  // La lista maestra de cada eje del producto, emparejada por nombre sin
  // distinguir mayúsculas ni acentos ("talle" y "Talle" son el mismo eje).
  const maestras = useMemo(() => ejes.map((eje) => ({
    eje,
    valores: tipos.find((t) => clave(t.nombre) === clave(eje))?.valores || null,
  })), [ejes, tipos]);

  const faltanEnMaestra = maestras.filter((m) => !m.valores?.length).map((m) => m.eje);

  const hayAlgoElegido = Object.values(elegidos).some((s) => s?.size > 0);

  function alternar(eje, valor) {
    setElegidos((prev) => {
      const set = new Set(prev[eje] || []);
      if (set.has(valor)) set.delete(valor); else set.add(valor);
      return { ...prev, [eje]: set };
    });
  }

  function todos(eje, valores) {
    setElegidos((prev) => {
      const set = new Set(prev[eje] || []);
      const faltan = valores.filter((v) => !set.has(v));
      return { ...prev, [eje]: faltan.length ? new Set([...set, ...faltan]) : new Set() };
    });
  }

  const pedirPlan = useCallback(async () => {
    const cuerpo = maestras
      .map((m) => ({ nombre: m.eje, valores: [...(elegidos[m.eje] || [])] }))
      .filter((e) => e.valores.length > 0);
    if (!cuerpo.length) { setPlan(null); return; }
    setCalculando(true); setError("");
    try {
      setPlan(await variantesMasivo(productId, { ejes: cuerpo }));
    } catch (e) {
      setPlan(null);
      setError(e.response?.data?.message || "No se pudo calcular la vista previa.");
    }
    setCalculando(false);
  }, [maestras, elegidos, productId]);

  // Se recalcula al soltar el tilde, con una pausa corta: tildar cuatro talles
  // seguidos no tiene por qué disparar cuatro consultas.
  const timer = useRef(null);
  useEffect(() => {
    if (!open || !productId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(pedirPlan, 250);
    return () => clearTimeout(timer.current);
  }, [open, productId, pedirPlan]);

  const necesitaLocal = Number(stock) > 0 && locales.length > 1;

  async function crear() {
    if (!plan?.aCrear?.length) return;
    if (necesitaLocal && !locationId) { setError("Elegí a qué local entra el stock inicial."); return; }
    setCreando(true); setError("");
    try {
      const cuerpo = maestras
        .map((m) => ({ nombre: m.eje, valores: [...(elegidos[m.eje] || [])] }))
        .filter((e) => e.valores.length > 0);
      const r = await variantesMasivo(productId, {
        ejes: cuerpo,
        stock: Number(stock) || 0,
        stockMinimo: Number(stockMinimo) || 0,
        locationId: locationId ? Number(locationId) : null,
        confirmar: true,
      });
      await onCreated?.(r);
      onClose();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron crear las variantes.");
    }
    setCreando(false);
  }

  return (
    <Modal open={open} onClose={onClose} width="max-w-2xl"
      title={`Agregar variantes desde la tabla maestra — ${group?.title || ""}`}>
      <div className="space-y-5">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

        {cargandoTipos && <p className="text-sm text-ink-500">Cargando la tabla maestra…</p>}

        {!cargandoTipos && faltanEnMaestra.length > 0 && (
          <p className="rounded-md bg-brass-50 px-3 py-2 text-xs text-brass-800">
            <TriangleAlert size={13} className="mr-1 inline" />
            No hay valores cargados para {faltanEnMaestra.join(" ni ")} en la tabla maestra.{" "}
            <Link to="/stock/variantes" className="underline">Cargalos ahí</Link> y volvé.
          </p>
        )}

        {maestras.map(({ eje, valores }) => valores?.length ? (
          <div key={eje}>
            <div className="mb-2 flex items-center justify-between">
              <label className="label mb-0">{eje}</label>
              <button type="button" className="text-xs text-ink-500 underline" onClick={() => todos(eje, valores)}>
                {(elegidos[eje]?.size || 0) >= valores.length ? "Ninguno" : "Todos"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {valores.map((v) => {
                const activo = elegidos[eje]?.has(v);
                const usado = yaUsados[eje]?.has(clave(v));
                return (
                  <button
                    type="button"
                    key={v}
                    onClick={() => alternar(eje, v)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      activo
                        ? "border-teal-600 bg-teal-600 text-paper-50"
                        : "border-line bg-paper-50 text-ink-700 hover:bg-paper-100"
                    }`}
                  >
                    {activo && <Check size={11} className="mr-1 inline" />}
                    {v}
                    {/* Marcado, no bloqueado: un color que ya está puede tener
                        talles que faltan, y las que existan se omiten solas. */}
                    {usado && <span className={activo ? "ml-1 opacity-70" : "ml-1 text-ink-400"}>· en uso</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null)}

        {hayAlgoElegido && (
          <div className="rounded-md border border-line bg-paper-100 px-3 py-3">
            {calculando ? (
              <p className="text-sm text-ink-500"><Loader2 size={13} className="mr-1 inline animate-spin" />Calculando…</p>
            ) : plan ? (
              <>
                <p className="text-sm font-medium text-ink-900">
                  {plan.aCrear.length === 0
                    ? "No hay nada nuevo para crear."
                    : `Se cre${plan.aCrear.length === 1 ? "a" : "an"} ${plan.aCrear.length} variante${plan.aCrear.length === 1 ? "" : "s"}.`}
                  {plan.omitidas.length > 0 && (
                    <span className="font-normal text-ink-500">
                      {" "}{plan.omitidas.length} ya {plan.omitidas.length === 1 ? "existe" : "existen"} y se {plan.omitidas.length === 1 ? "omite" : "omiten"}.
                    </span>
                  )}
                </p>
                {plan.aCrear.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {plan.aCrear.map((f) => (
                          <tr key={f.sku} className="border-b border-line/60 last:border-0">
                            <td className="py-1 text-ink-700">{f.etiqueta}</td>
                            <td className="py-1 text-right font-mono text-ink-500">{f.sku}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {plan?.aCrear?.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Stock inicial de cada una</label>
              <input type="number" min="0" className="input" value={stock}
                onChange={(e) => setStock(e.target.value)} />
            </div>
            <div>
              <label className="label">Stock mínimo</label>
              <input type="number" min="0" className="input" value={stockMinimo}
                onChange={(e) => setStockMinimo(e.target.value)} />
            </div>
            {necesitaLocal && (
              <div>
                <label className="label">Entra al local</label>
                <select className={`input ${!locationId ? "border-brick-500" : ""}`}
                  value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Elegí…</option>
                  {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-ink-500">
          Destildar un valor no borra nada: las variantes que ya existen se quedan como están.
          Esta pantalla sólo agrega.
        </p>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button
            type="button"
            className="btn-accent"
            disabled={!plan?.aCrear?.length || creando || calculando}
            onClick={crear}
          >
            {creando
              ? <><Loader2 size={15} className="animate-spin" /> Creando…</>
              : `Crear ${plan?.aCrear?.length || 0} variante${plan?.aCrear?.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
