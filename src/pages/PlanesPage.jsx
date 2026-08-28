import { useEffect, useState } from "react";
import { PencilLine, RefreshCw, Lock } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { plata, tope, fecha } from "../lib/formato";
import { useAdmin, puede } from "../context/AdminAuth";
import { Card, PageHead, Aviso, Cargando, Modal, Campo } from "../components/ui";

/*
 * Catálogo comercial.
 *
 * Editar un plan acá lo marca como tocado a mano, y desde ese momento la
 * semilla del código deja de sincronizarlo. Es lo que evita que un deploy
 * revierta un precio que alguien cambió a propósito, y por eso la pantalla lo
 * dice en vez de dejarlo como un efecto invisible.
 */

/*
 * Las funciones NO se escriben acá.
 *
 * Estaban: nueve pares clave-etiqueta a mano. Cuando el backend pasó a doce
 * —Eventos, Depósito y Reposición— esta lista no se enteró, y el efecto era
 * peor que cosmético: la tarjeta de un plan mostraba menos de lo que el plan
 * daba, y en el editor no había casilla para tocarlas. Un operador no podía
 * ni ver ni cambiar tres de las doce funciones que vende.
 *
 * Ahora las trae el servidor, que es el único que sabe cuáles existen.
 */

export default function PlanesPage() {
  const { admin } = useAdmin();
  const comercial = puede(admin, "owner");

  const [planes, setPlanes] = useState([]);
  const [features, setFeatures] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [editando, setEditando] = useState(null);

  async function cargar() {
    setCargando(true); setError("");
    try {
      const [ps, cat] = await Promise.all([api.getPlanes(), api.getCatalogoFeatures()]);
      setPlanes(ps);
      setFeatures(cat);
    }
    catch (e) { setError(mensajeDe(e, "No se pudieron cargar los planes.")); }
    finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  if (cargando) return <Cargando />;

  return (
    <div>
      <PageHead
        titulo="Planes"
        bajada="Precios, topes y funciones de cada plan"
        acciones={
          <button className="btn-ghost btn-sm" onClick={cargar}>
            <RefreshCw size={13} /> Actualizar
          </button>
        }
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>
      <Aviso tono="ok" onCerrar={() => setOk("")}>{ok}</Aviso>

      {!comercial && (
        <Aviso tono="info">
          <Lock size={13} className="mr-1 inline" />
          Con tu rol podés ver los planes pero no editarlos.
        </Aviso>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {planes.map((p) => (
          <Card key={p.codigo} className={`flex flex-col p-4 ${p.activo ? "" : "opacity-55"}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-brass">{p.codigo}</p>
                <h3 className="mt-0.5 font-semibold">{p.nombre}</h3>
              </div>
              {!p.activo && <span className="chip chip-mute">Oculto</span>}
            </div>

            <p className="mt-3 font-mono text-xl font-semibold tabular">
              {p.precioMensual != null ? plata(p.precioMensual) : "A cotizar"}
              {p.precioMensual != null && <span className="text-xs font-normal text-faint"> /mes</span>}
            </p>
            <p className="mt-1 text-xs text-dim">{p.descripcion}</p>

            <dl className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
              <Fila k="Comprobantes/mes" v={tope(p.maxComprobantes)} />
              <Fila k="SKUs" v={tope(p.maxSkus)} />
              <Fila k="CUITs" v={tope(p.maxCuits)} />
              <Fila k="Usuarios" v={tope(p.maxEmpleados)} />
              <Fila k="Locales" v={tope(p.maxLocales)} />
              <Fila k="Soporte" v={p.soporte || "—"} />
            </dl>

            <ul className="mt-3 flex flex-wrap gap-1">
              {features.filter((f) => p.features?.[f.clave]).map((f) => (
                <li key={f.clave} className="rounded-[2px] border border-line px-1.5 py-0.5 text-[10px] text-dim" title={f.ayuda}>
                  {f.label}
                </li>
              ))}
            </ul>

            <div className="mt-auto pt-4">
              {p.editadoEn && (
                <p className="mb-2 text-[11px] text-faint">
                  Editado a mano el {fecha(p.editadoEn)} — el código ya no lo sincroniza.
                </p>
              )}
              {comercial && (
                <button className="btn-ghost btn-sm w-full" onClick={() => setEditando(p)}>
                  <PencilLine size={13} /> Editar
                </button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <ModalPlan
        plan={editando}
        features={features}
        onClose={() => setEditando(null)}
        onGuardado={(m) => { setEditando(null); setOk(m); cargar(); }}
        onError={setError}
      />
    </div>
  );
}

function Fila({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-faint">{k}</dt>
      <dd className="text-dim">{v}</dd>
    </div>
  );
}

function ModalPlan({ plan, features, onClose, onGuardado, onError }) {
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!plan) return setForm(null);
    setForm({
      nombre: plan.nombre || "",
      descripcion: plan.descripcion || "",
      soporte: plan.soporte || "",
      // Se muestran vacíos cuando no hay tope: "sin límite" no es un número.
      precioMensual: plan.precioMensual ?? "",
      maxCuits: plan.maxCuits ?? "",
      maxEmpleados: plan.maxEmpleados ?? "",
      maxLocales: plan.maxLocales ?? "",
      maxSkus: plan.maxSkus ?? "",
      maxComprobantes: plan.maxComprobantes ?? "",
      activo: plan.activo !== false,
      features: { ...(plan.features || {}) },
    });
  }, [plan]);

  if (!plan || !form) return null;

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value });
  const toggleFeature = (clave) =>
    setForm({ ...form, features: { ...form.features, [clave]: !form.features[clave] } });

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true);
    try {
      const vacioEsNull = (v) => (v === "" ? null : Number(v));
      await api.editarPlan(plan.codigo, {
        nombre: form.nombre,
        descripcion: form.descripcion,
        soporte: form.soporte,
        precioMensual: vacioEsNull(form.precioMensual),
        maxCuits: vacioEsNull(form.maxCuits),
        maxEmpleados: vacioEsNull(form.maxEmpleados),
        maxLocales: vacioEsNull(form.maxLocales),
        maxSkus: vacioEsNull(form.maxSkus),
        maxComprobantes: vacioEsNull(form.maxComprobantes),
        activo: form.activo,
        features: form.features,
      });
      onGuardado(`${form.nombre} actualizado.`);
    } catch (err) {
      onError(mensajeDe(err, "No se pudo guardar el plan."));
    } finally { setGuardando(false); }
  }

  return (
    <Modal open onClose={onClose} titulo={`Editar ${plan.nombre}`} ancho="max-w-xl">
      <form onSubmit={guardar} className="space-y-4">
        <Aviso tono="info">
          Al guardar, este plan queda fuera de la sincronización automática con el código:
          los cambios que hagas acá ya no se pisan en el próximo deploy.
        </Aviso>

        <div className="grid gap-3 sm:grid-cols-2">
          <Campo etiqueta="Nombre">
            <input className="input" value={form.nombre} onChange={set("nombre")} />
          </Campo>
          <Campo etiqueta="Precio mensual" ayuda="Vacío = a cotizar.">
            <input className="input" type="number" min="0" step="0.01"
                   value={form.precioMensual} onChange={set("precioMensual")} />
          </Campo>
        </div>

        <Campo etiqueta="Descripción">
          <input className="input" value={form.descripcion} onChange={set("descripcion")} />
        </Campo>

        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            etiqueta="Comprobantes por mes"
            ayuda="Vacío = sin tope. Se reinicia el día 1."
          >
            <input className="input" type="number" min="0" value={form.maxComprobantes} onChange={set("maxComprobantes")} />
          </Campo>
          <Campo etiqueta="Máx. SKUs" ayuda="Vacío = sin tope. Es espacio de almacenamiento.">
            <input className="input" type="number" min="0" value={form.maxSkus} onChange={set("maxSkus")} />
          </Campo>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Campo etiqueta="Máx. CUITs" ayuda="Vacío = sin tope.">
            <input className="input" type="number" min="0" value={form.maxCuits} onChange={set("maxCuits")} />
          </Campo>
          <Campo etiqueta="Máx. usuarios" ayuda="Vacío = sin tope.">
            <input className="input" type="number" min="0" value={form.maxEmpleados} onChange={set("maxEmpleados")} />
          </Campo>
          <Campo etiqueta="Máx. locales" ayuda="Vacío = sin tope.">
            <input className="input" type="number" min="0" value={form.maxLocales} onChange={set("maxLocales")} />
          </Campo>
        </div>

        <Campo etiqueta="Soporte">
          <input className="input" value={form.soporte} onChange={set("soporte")} />
        </Campo>

        <div>
          <p className="label">Funciones incluidas</p>
          {/* El `title` con la ayuda no es adorno: quien tilda la casilla no
              siempre sabe qué habilita "Reposición" o "Multi-depósito". */}
          <div className="grid gap-1.5 sm:grid-cols-2">
            {features.map((f) => (
              <label key={f.clave} className="flex items-start gap-2 text-sm text-dim" title={f.ayuda}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={Boolean(form.features[f.clave])}
                  onChange={() => toggleFeature(f.clave)}
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-dim">
          <input
            type="checkbox"
            checked={form.activo}
            onChange={(e) => setForm({ ...form, activo: e.target.checked })}
          />
          Visible al contratar
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={guardando}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
