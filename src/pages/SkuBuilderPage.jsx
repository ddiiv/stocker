import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, Save, RotateCcw, Tag, Info } from "lucide-react";
import { fetchReglaSku, saveReglaSku, previewSku } from "../services/skuService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";

/*
 * Confección de SKU.
 *
 * Define cómo se arman los códigos de las variantes y —lo que realmente hace
 * falta— muestra el resultado sobre las variantes maestras reales antes de
 * guardar nada.
 *
 * La vista previa no es un adorno. Con tres letras por valor los choques son
 * frecuentes y predecibles: "Azul Marino" y "Azul Claro" dan las dos AZU. Sin
 * verlo, eso aparece recién al cargar el producto, como un error de la base que
 * no dice qué cambiar. Acá se ve mientras se decide, y se corrige poniéndole a
 * ese valor su propia abreviatura.
 *
 * Todos los SKU se calculan en el servidor con la misma función que después los
 * graba, así que lo que se ve es literalmente lo que se va a guardar.
 */

const EJEMPLO = { nombre: "Color", valores: ["Azul Marino", "Azul Claro", "Marrón"] };
const EJEMPLO2 = { nombre: "Talle", valores: ["S", "M", "XL"] };

export default function SkuBuilderPage() {
  const [regla, setRegla] = useState(null);
  const [original, setOriginal] = useState(null);
  const [ejes, setEjes] = useState([]);
  const [agrupador, setAgrupador] = useState("BA-010");
  const [previa, setPrevia] = useState({ filas: [], ejes: [], choques: 0, tomados: 0 });
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetchReglaSku()
      .then((d) => {
        setRegla(d.regla);
        setOriginal(d.regla);
        setEjes(d.ejes || []);
      })
      .catch((e) => setError(e.response?.data?.message || "No se pudo cargar la regla."))
      .finally(() => setCargando(false));
  }, []);

  /*
   * Qué se previsualiza: las variantes maestras del negocio si las hay, y si
   * no, un ejemplo. Una pantalla de reglas en blanco no permite decidir nada, y
   * el ejemplo elegido es justo el par que choca con la regla de fábrica.
   */
  const ejesPrevia = ejes.length ? ejes.slice(0, 2) : [EJEMPLO, EJEMPLO2];
  const usandoEjemplo = ejes.length === 0;

  // La previa se recalcula al soltar el teclado, no en cada tecla: es un
  // pedido al servidor por cambio.
  const temporizador = useRef(null);
  const recalcular = useCallback((r, ags, ej) => {
    clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => {
      previewSku({ agrupador: ags, ejes: ej.map((e) => ({ nombre: e.nombre, valores: e.valores })), regla: r })
        .then(setPrevia)
        .catch(() => {});
    }, 300);
  }, []);

  useEffect(() => {
    if (!regla) return;
    recalcular(regla, agrupador, ejesPrevia);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regla, agrupador, ejes]);

  function cambiar(campo, valor) {
    setRegla((r) => ({ ...r, [campo]: valor }));
    setAviso("");
  }

  function ponerAbreviatura(eje, valor, corta) {
    setRegla((r) => {
      const abrev = { ...r.abreviaturas };
      const delEje = { ...abrev[eje] };
      if (corta.trim()) delEje[valor] = corta.trim();
      else delete delEje[valor];
      if (Object.keys(delEje).length) abrev[eje] = delEje;
      else delete abrev[eje];
      return { ...r, abreviaturas: abrev };
    });
    setAviso("");
  }

  async function guardar() {
    setGuardando(true); setError(""); setAviso("");
    try {
      const g = await saveReglaSku(regla);
      setRegla(g); setOriginal(g);
      setAviso("Regla guardada. Se aplica a los SKU que se generen de ahora en más.");
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar.");
    } finally { setGuardando(false); }
  }

  if (cargando) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (!regla) return <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>;

  const sinGuardar = JSON.stringify(regla) !== JSON.stringify(original);

  /*
   * Los valores que causan el choque, para ofrecer arreglarlos.
   *
   * Viene calculado del servidor y no se deduce de las filas rojas. Deducirlo
   * acá fue un error real: si dos colores chocan, todas sus filas salen rojas y
   * los talles quedan dentro de ellas sin tener nada que ver. La lista mezclaba
   * unos con otros y era facilísimo abreviar el talle —que no arregla nada— en
   * lugar del color.
   */
  const enConflicto = (previa.ejes || []).flatMap((e) =>
    e.valores.filter((v) => v.choca).map((v) => ({ eje: e.nombre, valor: v.valor, codigo: v.codigo })));

  return (
    <div>
      <PageHeader title="Stock" subtitle="Cómo se arman los códigos de las variantes" />
      <StockTabs />

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Reglas */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <p className="mb-3 font-display text-sm font-semibold text-ink-950">La regla</p>

            <div className="space-y-4">
              <div>
                <label className="label">Letras que se toman de cada valor</label>
                <input type="number" min="1" max="10" className="input"
                  value={regla.caracteres}
                  onChange={(e) => cambiar("caracteres", e.target.value === "" ? "" : Number(e.target.value))} />
                <p className="mt-1 text-xs text-ink-500">
                  Con 3, «Beige» entra como BEI. Un valor más corto queda entero.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Antes de los códigos</label>
                  <input className="input font-mono" maxLength={3} placeholder="(nada)"
                    value={regla.separadorAgrupador}
                    onChange={(e) => cambiar("separadorAgrupador", e.target.value)} />
                  <p className="mt-1 text-xs text-ink-500">Separa el SKU del producto.</p>
                </div>
                <div>
                  <label className="label">Entre códigos</label>
                  <input className="input font-mono" maxLength={3} placeholder="(nada)"
                    value={regla.separadorValores}
                    onChange={(e) => cambiar("separadorValores", e.target.value)} />
                  <p className="mt-1 text-xs text-ink-500">Vacío = todo junto.</p>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-ink-800">
                <input type="checkbox" checked={regla.mayusculas}
                  onChange={(e) => cambiar("mayusculas", e.target.checked)} />
                Todo en mayúsculas
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-800">
                <input type="checkbox" checked={regla.quitarAcentos}
                  onChange={(e) => cambiar("quitarAcentos", e.target.checked)} />
                Sin acentos <span className="text-xs text-ink-500">(«Marrón» → MARRON)</span>
              </label>
            </div>

            <div className="mt-5 flex items-center gap-2 border-t border-ink-100 pt-4">
              <button className="btn btn-primary" onClick={guardar} disabled={guardando || !sinGuardar}>
                <Save size={15} /> {guardando ? "Guardando…" : "Guardar regla"}
              </button>
              {sinGuardar && (
                <button className="btn-ghost text-xs" onClick={() => setRegla(original)}>
                  <RotateCcw size={13} /> Descartar
                </button>
              )}
            </div>

            {aviso && <p className="mt-3 flex items-center gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700"><Check size={15} /> {aviso}</p>}
            {error && <p className="mt-3 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
          </Card>

          {/* Abreviaturas: sólo para los valores que chocan */}
          <Card>
            <p className="mb-1 font-display text-sm font-semibold text-ink-950">Abreviaturas</p>
            <p className="mb-3 text-xs text-ink-600">
              Cuando dos valores dan el mismo código, acá se le pone uno propio a cada uno.
            </p>

            {enConflicto.length === 0 ? (
              <p className="flex items-center gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700">
                <Check size={15} /> Ningún valor choca con esta regla.
              </p>
            ) : (
              <div className="space-y-2">
                {enConflicto.map((c) => (
                  <div key={`${c.eje}·${c.valor}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800" title={`${c.eje}: ${c.valor}`}>
                      {c.valor}{" "}
                      <span className="text-xs text-ink-500">({c.eje} → <span className="font-mono">{c.codigo}</span>)</span>
                    </span>
                    <input
                      className="input w-24 py-1 font-mono text-xs"
                      maxLength={10}
                      placeholder="AZM"
                      value={regla.abreviaturas?.[c.eje]?.[c.valor] || ""}
                      onChange={(e) => ponerAbreviatura(c.eje, c.valor, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Las que ya están cargadas, aunque hoy no choquen: si no, una vez
                resuelto el conflicto la abreviatura desaparece de la vista y no
                hay forma de sacarla. */}
            {Object.entries(regla.abreviaturas || {}).flatMap(([eje, vals]) =>
              Object.entries(vals)
                .filter(([valor]) => !enConflicto.some((c) => c.eje === eje && c.valor === valor))
                .map(([valor, corta]) => (
                  <div key={`${eje}·${valor}`} className="mt-2 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-600" title={`${eje}: ${valor}`}>
                      {valor} <span className="text-xs text-ink-500">({eje})</span>
                    </span>
                    <input
                      className="input w-24 py-1 font-mono text-xs"
                      maxLength={10}
                      value={corta}
                      onChange={(e) => ponerAbreviatura(eje, valor, e.target.value)}
                    />
                  </div>
                ))
            )}
          </Card>
        </div>

        {/* Vista previa */}
        <div className="lg:col-span-3">
          <Card className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <p className="font-display text-sm font-semibold text-ink-950">Cómo quedan</p>
                <p className="text-xs text-ink-600">
                  {usandoEjemplo
                    ? "Ejemplo: todavía no cargaste variantes maestras."
                    : `Sobre ${ejesPrevia.map((e) => e.nombre).join(" × ")}, de tus variantes maestras.`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-ink-600">SKU del producto</label>
                <input className="input w-28 py-1 font-mono text-xs" value={agrupador}
                  onChange={(e) => setAgrupador(e.target.value)} />
              </div>
            </div>

            {previa.choques > 0 && (
              <p className="flex items-start gap-2 border-b border-line bg-brick-50 px-4 py-2.5 text-sm text-brick-600">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  <strong>{previa.choques} combinaciones dan el mismo código.</strong> Con esta regla no se
                  pueden cargar todas: los valores culpables están a la izquierda, ponéles una abreviatura propia.
                </span>
              </p>
            )}
            {previa.tomados > 0 && (
              <p className="flex items-start gap-2 border-b border-line bg-brass-50 px-4 py-2.5 text-sm text-brass-700">
                <Info size={15} className="mt-0.5 shrink-0" />
                <span>{previa.tomados} de estos SKU ya existen en tu catálogo. No es un problema si es el
                  mismo producto; sí lo es si estás por crear uno nuevo.</span>
              </p>
            )}

            {usandoEjemplo && (
              <p className="flex items-start gap-2 border-b border-line bg-paper-100 px-4 py-2.5 text-sm text-ink-700">
                <Tag size={15} className="mt-0.5 shrink-0" />
                <span>
                  Cargá tus tipos de variante en{" "}
                  <Link to="/stock/variantes" className="underline">Variantes</Link>{" "}
                  y esta tabla pasa a mostrar tus valores reales.
                </span>
              </p>
            )}

            {previa.filas.length === 0 ? (
              <EmptyState icon={Tag} title="Nada que previsualizar"
                description="Cargá al menos un tipo de variante con sus valores." />
            ) : (
              <div className="max-h-[560px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-paper-50">
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-4 py-2 font-medium">Combinación</th>
                      <th className="px-4 py-2 font-medium">SKU</th>
                      <th className="px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {previa.filas.map((f, i) => (
                      <tr key={i} className={`border-b border-line last:border-0 ${f.duplicadoEnLaTabla ? "bg-brick-50/60" : ""}`}>
                        <td className="px-4 py-2 text-ink-700">
                          {f.valores.map((v) => v.valor).join(" · ") || <span className="text-ink-400">sin variantes</span>}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`font-mono ${f.duplicadoEnLaTabla ? "font-semibold text-brick-600" : "text-ink-900"}`}>
                            {f.sku}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-xs">
                          {f.duplicadoEnLaTabla
                            ? <span className="text-brick-600">repetido</span>
                            : f.yaExiste
                              ? <span className="text-brass-700">ya existe</span>
                              : <span className="text-ink-400">libre</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
