import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { UserCog, Mail, Check, Landmark, Lock, RefreshCw, ShieldCheck, ChevronRight } from "lucide-react";
import {
  fetchAccount, updateAccount, sincronizarConArca,
  solicitarCambioEmail, confirmarCambioEmail,
} from "../services/accountService";
import { PageHeader, Card } from "../components/ui/Layout";
import CuentaTabs from "../components/cuenta/CuentaTabs";
import { formatDate } from "../utils/formatters";

/*
 * Cuenta del dueño: la primera pestaña de Configuración.
 *
 * Los datos comunes se guardan directo. Email y contraseña van por un flujo de
 * dos pasos con código al mail: son las llaves de la cuenta, y cambiarlas sin
 * confirmar dejaría que cualquiera con la sesión abierta se apropie de ella.
 *
 * La contraseña, el doble factor y "cerrar todas las sesiones" vivían acá y
 * se mudaron a sus pestañas (Seguridad y Sesiones) sin cambiar su lógica. La
 * tarjeta "La cuenta" deja el camino: quien venía a buscar el doble factor a
 * Mi cuenta lo encuentra a un clic, con su estado a la vista.
 */
export default function AccountPage() {
  const [cuenta, setCuenta] = useState(null);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");
  const [sincronizando, setSincronizando] = useState(false);
  const [errorArca, setErrorArca] = useState("");

  // Cambio de email: paso 1 pide el nuevo, paso 2 el código.
  const [emailNuevo, setEmailNuevo] = useState("");
  const [pasoEmail, setPasoEmail] = useState(1);
  const [codigoEmail, setCodigoEmail] = useState("");
  const [errorEmail, setErrorEmail] = useState("");
  const [enviandoEmail, setEnviandoEmail] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const c = await fetchAccount();
      setCuenta(c);
      // Sólo lo editable: nombre, apellido, CUIT y condición fiscal salen de
      // ARCA y se muestran aparte en solo lectura.
      setForm({
        nombreNegocio: c.nombreNegocio || "",
        ownerTelefono: c.ownerTelefono || "",
        telefono: c.telefono || "",
      });
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo cargar la cuenta");
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function guardarDatos(e) {
    e.preventDefault();
    setGuardando(true); setError(""); setAviso("");
    try {
      const c = await updateAccount(form);
      setCuenta((prev) => ({ ...prev, ...c }));
      setAviso("Datos actualizados.");
    } catch (err) {
      setError(err.response?.data?.message || "No se pudieron guardar los datos");
    } finally { setGuardando(false); }
  }

  async function sincronizar() {
    setSincronizando(true); setErrorArca(""); setAviso("");
    try {
      const c = await sincronizarConArca();
      setCuenta((prev) => ({ ...prev, ...c }));
      setAviso(c.message || "Datos actualizados desde ARCA.");
    } catch (err) {
      setErrorArca(err.response?.data?.message || "No se pudo consultar ARCA");
    } finally { setSincronizando(false); }
  }

  async function pedirCodigoEmail(e) {
    e.preventDefault();
    setEnviandoEmail(true); setErrorEmail("");
    try {
      const r = await solicitarCambioEmail(emailNuevo.trim());
      setAviso(r.message);
      setPasoEmail(2);
    } catch (err) {
      setErrorEmail(err.response?.data?.message || "No se pudo enviar el código");
    } finally { setEnviandoEmail(false); }
  }

  async function confirmarEmail(e) {
    e.preventDefault();
    setEnviandoEmail(true); setErrorEmail("");
    try {
      const r = await confirmarCambioEmail(codigoEmail.trim());
      setAviso(r.message);
      setCuenta((prev) => ({ ...prev, email: r.email }));
      setPasoEmail(1); setEmailNuevo(""); setCodigoEmail("");
    } catch (err) {
      setErrorEmail(err.response?.data?.message || "No se pudo confirmar el cambio");
    } finally { setEnviandoEmail(false); }
  }

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;

  return (
    <div>
      <PageHeader title="Mi cuenta" subtitle="Datos del negocio y credenciales de acceso" />
      <CuentaTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700">
          <Check size={15} className="mt-0.5 shrink-0" /> {aviso}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── Datos generales ── */}
        <Card>
          <p className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
            <UserCog size={17} /> Datos del negocio
          </p>
          <form onSubmit={guardarDatos} className="space-y-3">
            <div>
              <label className="label" htmlFor="cuenta-nombre">Nombre del negocio</label>
              <input id="cuenta-nombre" className="input" value={form.nombreNegocio}
                onChange={(e) => setForm({ ...form, nombreNegocio: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="cuenta-tel-duenio">Tu teléfono</label>
                <input id="cuenta-tel-duenio" className="input" value={form.ownerTelefono}
                  onChange={(e) => setForm({ ...form, ownerTelefono: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="cuenta-tel-negocio">Teléfono del negocio</label>
                <input id="cuenta-tel-negocio" className="input" value={form.telefono}
                  onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
              </div>
            </div>
            <button className="btn-accent" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar cambios"}
            </button>
          </form>
        </Card>

        {/* ── Datos fiscales: los define ARCA, no el usuario ── */}
        <Card>
          <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
            <Landmark size={17} /> Datos fiscales
          </p>
          <p className="mb-3 text-sm text-ink-600">
            Salen del padrón de ARCA. No se editan a mano: si no coincidieran con lo que
            AFIP tiene registrado, los comprobantes no validarían.
          </p>

          {errorArca && <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorArca}</p>}

          <dl className="space-y-2 text-sm">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-ink-600">CUIT</dt>
              <dd className="flex items-center gap-1.5 font-mono text-ink-900">
                {cuenta?.cuit}
                <Lock size={12} className="text-ink-400" />
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-ink-600">Titular</dt>
              <dd className="text-right text-ink-900">
                {[cuenta?.ownerApellido, cuenta?.ownerNombre].filter(Boolean).join(", ") || "—"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-ink-600">Condición frente a ARCA</dt>
              <dd className="text-right text-ink-900">
                {cuenta?.condicionIva || <span className="text-ink-400">sin consultar</span>}
              </dd>
            </div>
          </dl>

          <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-500">
            <Lock size={12} className="mt-0.5 shrink-0" />
            El CUIT queda fijo desde el registro: identifica fiscalmente a la cuenta y las
            facturas emitidas quedaron a su nombre.
          </p>

          <div className="mt-3 flex items-center gap-3">
            <button type="button" className="btn-ghost border border-line" onClick={sincronizar} disabled={sincronizando}>
              <RefreshCw size={14} className={sincronizando ? "animate-spin" : ""} />
              {sincronizando ? "Consultando ARCA…" : "Actualizar desde ARCA"}
            </button>
            {cuenta?.arcaSyncEn && (
              <span className="text-xs text-ink-500">
                Última consulta: {new Date(cuenta.arcaSyncEn).toLocaleString("es-AR")}
              </span>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          {/* ── Email ── */}
          <Card>
            <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
              <Mail size={17} /> Email de acceso
            </p>
            <p className="mb-3 text-sm text-ink-600">
              Actual: <span className="font-medium text-ink-900">{cuenta?.email}</span>
            </p>

            {errorEmail && <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorEmail}</p>}

            {pasoEmail === 1 ? (
              <form onSubmit={pedirCodigoEmail} className="space-y-3">
                <div>
                  <label className="label" htmlFor="cuenta-email-nuevo">Email nuevo</label>
                  <input id="cuenta-email-nuevo" className="input" type="email" value={emailNuevo}
                    onChange={(e) => setEmailNuevo(e.target.value)} placeholder="nuevo@negocio.com" />
                  <p className="mt-1 text-xs text-ink-500">
                    Te vamos a mandar un código a esa casilla para confirmar que la controlás.
                  </p>
                </div>
                <button className="btn-ghost border border-line" disabled={enviandoEmail || !emailNuevo.trim()}>
                  {enviandoEmail ? "Enviando…" : "Enviar código"}
                </button>
              </form>
            ) : (
              <form onSubmit={confirmarEmail} className="space-y-3">
                <div>
                  <label className="label" htmlFor="cuenta-email-codigo">Código recibido en {emailNuevo}</label>
                  <input id="cuenta-email-codigo" className="input font-mono tracking-widest" value={codigoEmail} maxLength={6}
                    onChange={(e) => setCodigoEmail(e.target.value)} placeholder="000000" />
                </div>
                <div className="flex gap-2">
                  <button className="btn-accent" disabled={enviandoEmail}>
                    {enviandoEmail ? "Confirmando…" : "Confirmar cambio"}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => { setPasoEmail(1); setCodigoEmail(""); setErrorEmail(""); }}>
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </Card>
        </div>

        <ResumenCuenta cuenta={cuenta} />
      </div>
    </div>
  );
}

/*
 * La cuenta de un vistazo: desde cuándo existe y cómo está su seguridad, con
 * el camino a la pestaña donde se cambia cada cosa.
 *
 * Es también el cartel de la mudanza: el doble factor y la contraseña estaban
 * en esta pantalla, y quien los busca acá tiene que encontrar adónde fueron.
 */
function ResumenCuenta({ cuenta }) {
  const dobleFactor = Boolean(cuenta?.dobleFactor?.habilitado);
  return (
    <Card>
      <p className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
        <ShieldCheck size={17} /> La cuenta
      </p>
      <dl className="space-y-2 text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-ink-600">Creada el</dt>
          <dd className="text-right text-ink-900">{formatDate(cuenta?.createdAt)}</dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-ink-600">Verificación en dos pasos</dt>
          <dd className="text-right">
            {dobleFactor
              ? <span className="badge badge-ok">Activa</span>
              : <span className="badge badge-low">Sin activar</span>}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-ink-600">Términos aceptados</dt>
          <dd className="text-right text-ink-900">
            {cuenta?.terminosVersion
              ? `Versión ${cuenta.terminosVersion}`
              : <span className="text-ink-500">sin registro</span>}
          </dd>
        </div>
      </dl>
      <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
        <AtajoCuenta to="/cuenta/seguridad" texto="Contraseña y verificación en dos pasos" />
        <AtajoCuenta to="/cuenta/sesiones" texto="Dónde está abierta la cuenta" />
        <AtajoCuenta to="/cuenta/terminos" texto="Términos y condiciones" />
      </ul>
    </Card>
  );
}

function AtajoCuenta({ to, texto }) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-2 py-2.5 text-ink-700 hover:text-ink-950">
        {texto} <ChevronRight size={15} className="shrink-0 text-ink-400" />
      </Link>
    </li>
  );
}
