import { useEffect, useState } from "react";
import { Save, ExternalLink, Lock, Globe } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { useAdmin, puede } from "../context/AdminAuth";
import { Card, PageHead, Aviso, Cargando, Campo } from "../components/ui";

/*
 * Lo que muestra la página pública.
 *
 * La página es un archivo estático: trae estos valores escritos como respaldo
 * y los pisa al cargar con lo que haya acá. O sea que cambiar un teléfono no
 * necesita volver a publicarla, y si esta API no responde el visitante ve los
 * valores del HTML igual.
 */
export default function AjustesPage() {
  const { admin } = useAdmin();
  const comercial = puede(admin, "owner");

  const [claves, setClaves] = useState([]);
  const [publico, setPublico] = useState(null);
  const [urlPublica, setUrlPublica] = useState(null);
  const [form, setForm] = useState({});
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function cargar() {
    setCargando(true); setError("");
    try {
      const [r, vista] = await Promise.all([
        api.getAjustes(),
        // Si falla, la vista previa cae a los valores guardados. No vale la
        // pena tumbar la pantalla de edición por no poder mostrar el preview.
        api.getVistaPublica().catch(() => null),
      ]);
      // La respuesta pasó a ser un objeto para poder traer también la URL de la
      // página. Se acepta el array viejo por si queda una versión sin desplegar.
      const lista = Array.isArray(r) ? r : (r.claves || []);
      setClaves(lista);
      setUrlPublica(Array.isArray(r) ? null : r.paginaPublica);
      setPublico(vista);
      setForm(Object.fromEntries(lista.map((c) => [c.clave, c.valor ?? ""])));
    } catch (e) {
      setError(mensajeDe(e, "No se pudieron cargar los ajustes."));
    } finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true); setError(""); setOk("");
    try {
      await api.editarAjustes(form);
      setOk("Guardado. La página pública ya lo muestra: recargala para verlo.");
      await cargar();
    } catch (err) {
      setError(mensajeDe(err, "No se pudo guardar."));
    } finally { setGuardando(false); }
  }

  if (cargando) return <Cargando />;

  const valor = (clave) => form[clave] ?? "";
  const set = (clave) => (e) => setForm({ ...form, [clave]: e.target.value });
  // Lo que el visitante ve hoy: lo editado si existe, y si no el valor por
  // defecto que resuelve el backend.
  const enVivo = {
    contactoEmail:    publico?.contacto?.email,
    contactoTelefono: publico?.contacto?.telefono,
    contactoWhatsapp: publico?.contacto?.whatsapp,
    cotizacionUsd:    publico?.cotizacionUsd,
  };
  const efectivo = (clave) => valor(clave) || enVivo[clave] || "—";
  const placeholder = (clave) => enVivo[clave] || "";

  return (
    <div>
      <PageHead
        titulo="Página pública"
        bajada="Contacto y precios que ve quien todavía no es cliente"
        acciones={urlPublica && (
          <a className="btn-primary btn-sm" href={urlPublica} target="_blank" rel="noopener noreferrer">
            <Globe size={13} /> Abrir la página <ExternalLink size={12} />
          </a>
        )}
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>
      <Aviso tono="ok" onCerrar={() => setOk("")}>{ok}</Aviso>

      {!comercial && (
        <Aviso tono="info">
          <Lock size={13} className="mr-1 inline" />
          Con tu rol podés ver estos valores pero no cambiarlos.
        </Aviso>
      )}

      <form onSubmit={guardar} className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-4 lg:col-span-2">
          <p className="eyebrow">Contacto</p>

          <Campo etiqueta="Email" ayuda="Aparece en los botones y en el pie.">
            <input className="input" type="email" disabled={!comercial}
                   value={valor("contactoEmail")} onChange={set("contactoEmail")}
                   placeholder={placeholder("contactoEmail") || "danteinsauviola@gmail.com"} />
          </Campo>

          <Campo
            etiqueta="WhatsApp"
            ayuda="Sólo dígitos, con código de país y sin el 15. Ej: 5491151180090"
          >
            <input className="input font-mono" disabled={!comercial}
                   value={valor("contactoWhatsapp")} onChange={set("contactoWhatsapp")}
                   placeholder={placeholder("contactoWhatsapp") || "5491151180090"} />
          </Campo>

          <Campo etiqueta="Teléfono" ayuda="Como querés que se lea en pantalla.">
            <input className="input" disabled={!comercial}
                   value={valor("contactoTelefono")} onChange={set("contactoTelefono")}
                   placeholder={placeholder("contactoTelefono") || "+54 9 11 5118-0090"} />
          </Campo>

          <div className="border-t border-line pt-4">
            <p className="eyebrow mb-3">Moneda</p>
            <Campo
              etiqueta="Pesos por dólar"
              ayuda="Sólo para mostrar los precios en USD como referencia. Se cobra siempre en pesos."
            >
              <input className="input font-mono tabular" type="number" min="1" step="1"
                     disabled={!comercial}
                     value={valor("cotizacionUsd")} onChange={set("cotizacionUsd")}
                     placeholder={String(placeholder("cotizacionUsd") || 1450)} />
            </Campo>
          </div>

          {comercial && (
            <div className="flex justify-end pt-1">
              <button className="btn-primary" disabled={guardando}>
                <Save size={15} /> {guardando ? "Guardando…" : "Guardar"}
              </button>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <p className="eyebrow mb-3">Cómo se ve</p>
          <div className="space-y-3 text-sm">
            <Vista rotulo="Email" valor={efectivo("contactoEmail")} />
            <Vista rotulo="WhatsApp" valor={efectivo("contactoWhatsapp")} />
            <Vista rotulo="Teléfono" valor={efectivo("contactoTelefono")} />
            <Vista
              rotulo={`${publico?.planes?.find((p) => p.codigo === "pro")?.nombre || "Plan Pro"} en USD`}
              valor={(() => {
                const cot = Number(valor("cotizacionUsd")) || Number(enVivo.cotizacionUsd) || 1450;
                const precio = publico?.planes?.find((p) => p.codigo === "pro")?.precioMensual;
                return precio ? `US$ ${Math.round(precio / cot)}` : "—";
              })()}
              nota="Mismo cálculo que hace la página"
            />
          </div>

          <div className="mt-4 space-y-2 border-t border-line pt-3 text-xs text-dim">
            <p>Los precios de los planes se editan en la sección Planes: la página los lee de ahí.</p>
            <p className="text-faint">
              Los cambios se ven en la próxima visita a la página. No hay que volver
              a publicarla: los lee de acá cada vez que carga.
            </p>
            {urlPublica ? (
              <a
                href={urlPublica}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-brass hover:underline"
              >
                {urlPublica.replace(/^https?:\/\//, "")} <ExternalLink size={12} />
              </a>
            ) : (
              <p className="text-warn">
                Cargá <span className="font-mono">LANDING_DOMAIN</span> en el backend para
                poder abrirla desde acá.
              </p>
            )}
          </div>
        </Card>
      </form>
    </div>
  );
}

function Vista({ rotulo, valor, nota }) {
  return (
    <div>
      <p className="eyebrow">{rotulo}</p>
      <p className="mt-0.5 break-words text-text">{valor}</p>
      {nota && <p className="text-xs text-faint">{nota}</p>}
    </div>
  );
}
