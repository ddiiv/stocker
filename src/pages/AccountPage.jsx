import { useEffect, useState } from "react";
import { UserCog, Mail, KeyRound, Smartphone, Check, ShieldCheck, Landmark, Lock, RefreshCw, LogOut } from "lucide-react";
import {
  fetchAccount, updateAccount, sincronizarConArca,
  solicitarCambioEmail, confirmarCambioEmail,
  solicitarCambioPassword, confirmarCambioPassword, cerrarTodasLasSesiones,
  iniciar2FA, activar2FA, desactivar2FA, regenerarCodigos2FA,
  enviarCodigoCanal2FA, activarCanal2FA, desactivarCanal2FA,
} from "../services/accountService";
import { PageHeader, Card } from "../components/ui/Layout";
import PasswordStrength from "../components/ui/PasswordStrength";

/*
 * Cuenta del dueño.
 *
 * Los datos comunes se guardan directo. Email y contraseña van por un flujo de
 * dos pasos con código al mail: son las llaves de la cuenta, y cambiarlas sin
 * confirmar dejaría que cualquiera con la sesión abierta se apropie de ella.
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

  // Cambio de contraseña: paso 1 valida la actual, paso 2 código + nueva.
  const [passActual, setPassActual] = useState("");
  const [passNueva, setPassNueva] = useState("");
  const [pasoPass, setPasoPass] = useState(1);
  const [codigoPass, setCodigoPass] = useState("");
  const [errorPass, setErrorPass] = useState("");
  const [enviandoPass, setEnviandoPass] = useState(false);

  // Cerrar todas las sesiones: se confirma pidiendo la contraseña actual.
  const [abriendoCierre, setAbriendoCierre] = useState(false);
  const [passCierre, setPassCierre] = useState("");
  const [errorCierre, setErrorCierre] = useState("");
  const [avisoCierre, setAvisoCierre] = useState("");
  const [cerrando, setCerrando] = useState(false);

  /*
   * ── Verificación en dos pasos ──────────────────────────────────
   *
   * Una sola variable de paso en vez de varios booleanos: los estados son
   * excluyentes —o estás pidiendo la contraseña, o cargando la app, o mirando
   * los códigos— y con booleanos sueltos siempre termina existiendo la
   * combinación imposible que nadie previó.
   */
  const [paso2fa, setPaso2fa] = useState("inicio");
  const [clave2fa, setClave2fa] = useState("");
  const [codigo2fa, setCodigo2fa] = useState("");
  const [secreto2fa, setSecreto2fa] = useState(null);
  const [uri2fa, setUri2fa] = useState("");
  const [qr2fa, setQr2fa] = useState(null);
  const [codigosRec, setCodigosRec] = useState(null);
  const [error2fa, setError2fa] = useState("");
  const [aviso2fa, setAviso2fa] = useState("");
  const [ocupado2fa, setOcupado2fa] = useState(false);
  const activo2fa = Boolean(cuenta?.dobleFactor?.habilitado);

  function reiniciar2fa() {
    setPaso2fa("inicio"); setClave2fa(""); setCodigo2fa("");
    setSecreto2fa(null); setUri2fa(""); setQr2fa(null); setError2fa("");
  }

  /*
   * Canales de código: mail y WhatsApp.
   *
   * `canalEnCurso` guarda cuál se está prendiendo o apagando, para que dos
   * filas no compartan el mismo formulario abierto. Con un booleano suelto,
   * abrir el de WhatsApp mientras estaba abierto el del mail dejaba dos
   * formularios pidiendo lo mismo y ninguno sabiendo cuál era el suyo.
   */
  const [canalEnCurso, setCanalEnCurso] = useState(null);
  const [accionCanal, setAccionCanal] = useState(null);
  const [claveCanal, setClaveCanal] = useState("");
  const [codigoCanal, setCodigoCanal] = useState("");
  const [destinoCanal, setDestinoCanal] = useState("");
  const [errorCanal, setErrorCanal] = useState("");
  const [ocupadoCanal, setOcupadoCanal] = useState(false);

  function cerrarCanal() {
    setCanalEnCurso(null); setAccionCanal(null);
    setClaveCanal(""); setCodigoCanal(""); setDestinoCanal(""); setErrorCanal("");
  }

  async function mandarCodigoCanal(e) {
    e.preventDefault();
    setOcupadoCanal(true); setErrorCanal("");
    try {
      const r = await enviarCodigoCanal2FA({ passwordActual: claveCanal, canal: canalEnCurso });
      setDestinoCanal(r.destino || "");
    } catch (err) {
      setErrorCanal(err.response?.data?.message || "No se pudo mandar el código");
    } finally { setOcupadoCanal(false); }
  }

  async function confirmarCanal(e) {
    e.preventDefault();
    setOcupadoCanal(true); setErrorCanal("");
    try {
      if (accionCanal === "apagar") {
        await desactivarCanal2FA({ passwordActual: claveCanal, canal: canalEnCurso, code: codigoCanal.trim() });
        setAviso2fa("Listo, ese canal quedó apagado.");
      } else {
        await activarCanal2FA({ canal: canalEnCurso, code: codigoCanal.trim() });
        setAviso2fa("Listo, ya podés recibir el código por ahí.");
      }
      cerrarCanal();
      await load();
    } catch (err) {
      setErrorCanal(err.response?.data?.message || "No se pudo confirmar");
    } finally { setOcupadoCanal(false); }
  }

  async function pedirSecreto(e) {
    e.preventDefault();
    setOcupado2fa(true); setError2fa("");
    try {
      const r = await iniciar2FA(clave2fa);
      setSecreto2fa(r.secreto); setUri2fa(r.uri); setQr2fa(r.qr || null); setPaso2fa("cargar");
    } catch (err) {
      setError2fa(err.response?.data?.message || "No se pudo empezar");
    } finally { setOcupado2fa(false); }
  }

  async function confirmarActivacion(e) {
    e.preventDefault();
    setOcupado2fa(true); setError2fa("");
    try {
      const r = await activar2FA(codigo2fa.trim());
      setCodigosRec(r.codigosDeRecuperacion);
      setPaso2fa("codigos"); setCodigo2fa(""); setClave2fa(""); setSecreto2fa(null);
      await load();
    } catch (err) {
      setError2fa(err.response?.data?.message || "No se pudo activar");
    } finally { setOcupado2fa(false); }
  }

  async function apagar2fa(e) {
    e.preventDefault();
    setOcupado2fa(true); setError2fa("");
    try {
      await desactivar2FA({ passwordActual: clave2fa, code: codigo2fa.trim() });
      setAviso2fa("La verificación en dos pasos quedó desactivada.");
      reiniciar2fa();
      await load();
    } catch (err) {
      setError2fa(err.response?.data?.message || "No se pudo desactivar");
    } finally { setOcupado2fa(false); }
  }

  async function pedirCodigosNuevos(e) {
    e.preventDefault();
    setOcupado2fa(true); setError2fa("");
    try {
      const r = await regenerarCodigos2FA({ passwordActual: clave2fa, code: codigo2fa.trim() });
      setCodigosRec(r.codigosDeRecuperacion);
      setPaso2fa("codigos"); setClave2fa(""); setCodigo2fa("");
      await load();
    } catch (err) {
      setError2fa(err.response?.data?.message || "No se pudieron regenerar");
    } finally { setOcupado2fa(false); }
  }

  async function cerrarSesiones(e) {
    e.preventDefault();
    setCerrando(true); setErrorCierre(""); setAvisoCierre("");
    try {
      const r = await cerrarTodasLasSesiones(passCierre);
      const n = r?.empleadosAfectados ?? 0;
      setAvisoCierre(
        n > 0
          ? `Listo. Se cerraron las sesiones del negocio, incluidas las de ${n} ${n === 1 ? "empleado" : "empleados"}. En este dispositivo seguís adentro.`
          : "Listo. Se cerraron las sesiones abiertas. En este dispositivo seguís adentro.",
      );
      setPassCierre("");
      setAbriendoCierre(false);
    } catch (err) {
      setErrorCierre(err.response?.data?.message || "No se pudieron cerrar las sesiones");
    } finally {
      setCerrando(false);
    }
  }

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

  async function pedirCodigoPass(e) {
    e.preventDefault();
    setEnviandoPass(true); setErrorPass("");
    try {
      const r = await solicitarCambioPassword(passActual);
      setAviso(r.message);
      setPasoPass(2);
    } catch (err) {
      setErrorPass(err.response?.data?.message || "No se pudo enviar el código");
    } finally { setEnviandoPass(false); }
  }

  async function confirmarPass(e) {
    e.preventDefault();
    setEnviandoPass(true); setErrorPass("");
    try {
      const r = await confirmarCambioPassword({ code: codigoPass.trim(), passwordNueva: passNueva });
      setAviso(r.message);
      setPasoPass(1); setPassActual(""); setPassNueva(""); setCodigoPass("");
    } catch (err) {
      setErrorPass(err.response?.data?.message || "No se pudo cambiar la contraseña");
    } finally { setEnviandoPass(false); }
  }

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;

  return (
    <div>
      <PageHeader title="Mi cuenta" subtitle="Datos del negocio y credenciales de acceso" />

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
              <label className="label">Nombre del negocio</label>
              <input className="input" value={form.nombreNegocio}
                onChange={(e) => setForm({ ...form, nombreNegocio: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Tu teléfono</label>
                <input className="input" value={form.ownerTelefono}
                  onChange={(e) => setForm({ ...form, ownerTelefono: e.target.value })} />
              </div>
              <div>
                <label className="label">Teléfono del negocio</label>
                <input className="input" value={form.telefono}
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
                  <label className="label">Email nuevo</label>
                  <input className="input" type="email" value={emailNuevo}
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
                  <label className="label">Código recibido en {emailNuevo}</label>
                  <input className="input font-mono tracking-widest" value={codigoEmail} maxLength={6}
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

          {/* ── Contraseña ── */}
          <Card>
            <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
              <KeyRound size={17} /> Contraseña
            </p>
            <p className="mb-2 text-sm text-ink-600">
              Por seguridad no se muestra. Para cambiarla pedimos la actual y un código al mail.
            </p>
            {/*
              Se avisa ANTES de tocar nada, no después.
              Cerrar las sesiones es el sentido de cambiar la contraseña cuando
              sospechás que alguien entró, pero si el aviso llegara recién con
              el resultado, quien la cambia por rutina descubre que dejó a la
              cajera afuera en el peor momento sin haber podido preverlo.
            */}
            <p className="mb-3 rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
              Al cambiarla se cierran las sesiones abiertas en otros dispositivos.
              En éste vas a seguir adentro.
            </p>

            {errorPass && <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorPass}</p>}

            {pasoPass === 1 ? (
              <form onSubmit={pedirCodigoPass} className="space-y-3">
                <div>
                  <label className="label">Contraseña actual</label>
                  <input className="input" type="password" value={passActual}
                    onChange={(e) => setPassActual(e.target.value)} autoComplete="current-password" />
                </div>
                <button className="btn-ghost border border-line" disabled={enviandoPass || !passActual}>
                  {enviandoPass ? "Enviando…" : "Enviar código"}
                </button>
              </form>
            ) : (
              <form onSubmit={confirmarPass} className="space-y-3">
                <div>
                  <label className="label">Código recibido en {cuenta?.email}</label>
                  <input className="input font-mono tracking-widest" value={codigoPass} maxLength={6}
                    onChange={(e) => setCodigoPass(e.target.value)} placeholder="000000" />
                </div>
                <div>
                  <label className="label">Contraseña nueva</label>
                  <input className="input" type="password" value={passNueva}
                    onChange={(e) => setPassNueva(e.target.value)} autoComplete="new-password" />
                  <PasswordStrength value={passNueva} />
                </div>
                <div className="flex gap-2">
                  <button className="btn-accent" disabled={enviandoPass}>
                    {enviandoPass ? "Guardando…" : "Cambiar contraseña"}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => { setPasoPass(1); setCodigoPass(""); setPassNueva(""); setErrorPass(""); }}>
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </Card>

          {/*
            ── Cerrar todas las sesiones ──────────────────────────────
            Distinto de cambiar la contraseña, que sólo cierra las sesiones que
            ESA contraseña abrió. Acá el caso es el teléfono perdido con la
            sesión abierta, la computadora que quedó prendida en el local, el
            que se fue sabiendo una clave: no hace falta que todo el equipo se
            invente contraseñas nuevas, con que vuelvan a entrar alcanza.
          */}
          <Card>
            <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
              <LogOut size={17} /> Cerrar todas las sesiones
            </p>
            <p className="mb-3 text-sm text-ink-600">
              Saca a todos de todas las computadoras y teléfonos —vos y tus empleados—
              sin cambiarle la contraseña a nadie. Cada uno vuelve a entrar con la que
              ya tenía. En este dispositivo vas a seguir adentro.
            </p>

            {avisoCierre && (
              <p className="mb-3 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{avisoCierre}</p>
            )}
            {errorCierre && (
              <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorCierre}</p>
            )}

            {!abriendoCierre ? (
              <button type="button" className="btn-ghost border border-line"
                onClick={() => { setAbriendoCierre(true); setAvisoCierre(""); setErrorCierre(""); }}>
                Cerrar sesiones
              </button>
            ) : (
              <form onSubmit={cerrarSesiones} className="space-y-3">
                {/*
                  Se avisa lo que duele ANTES de pedir la contraseña: si hay
                  gente vendiendo, esto los deja con la venta a medio cargar.
                */}
                <p className="rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
                  Si hay alguien vendiendo en este momento, va a tener que volver a entrar.
                </p>
                <div>
                  <label className="label" htmlFor="pass-cierre">Confirmá con tu contraseña actual</label>
                  <input id="pass-cierre" className="input" type="password" value={passCierre}
                    onChange={(e) => setPassCierre(e.target.value)} autoComplete="current-password" />
                </div>
                <div className="flex gap-2">
                  <button className="btn-accent" disabled={cerrando || !passCierre}>
                    {cerrando ? "Cerrando…" : "Cerrar todas las sesiones"}
                  </button>
                  <button type="button" className="btn-ghost"
                    onClick={() => { setAbriendoCierre(false); setPassCierre(""); setErrorCierre(""); }}>
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </Card>

          {/* ── Verificación en dos pasos (app de autenticación) ── */}
          <Card>
            <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
              <Smartphone size={17} /> Verificación en dos pasos
              {activo2fa && <span className="badge badge-ok">Activa</span>}
            </p>

            {aviso2fa && <p className="mb-3 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{aviso2fa}</p>}
            {error2fa && <p className="mb-3 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error2fa}</p>}

            {/*
              Los códigos de recuperación se muestran UNA sola vez, acá.
              El servidor guarda sólo su hash, así que si esta pantalla se
              cierra sin copiarlos no hay forma de volver a verlos: hay que
              generar otros. Por eso el cartel es tan insistente.
            */}
            {paso2fa === "codigos" && codigosRec && (
              <div>
                <p className="mb-2 rounded-md bg-brass-50 px-3 py-2 text-sm text-ink-900">
                  <strong>Guardá estos códigos ahora.</strong> Es la única vez que se
                  muestran. Cada uno sirve una sola vez y son lo que te deja entrar si
                  perdés el teléfono. Sacales una foto o anotalos en papel — no los
                  dejes en el mismo teléfono que tiene la app.
                </p>
                <ul className="mb-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-ink-900">
                  {codigosRec.map((c) => <li key={c} className="rounded bg-paper-200 px-2 py-1">{c}</li>)}
                </ul>
                <button type="button" className="btn-accent"
                  onClick={() => { setCodigosRec(null); setPaso2fa("inicio"); setAviso2fa("Listo. Guardá los códigos en un lugar seguro."); }}>
                  Ya los guardé
                </button>
              </div>
            )}

            {paso2fa !== "codigos" && !activo2fa && (
              <>
                <p className="mb-3 text-sm text-ink-600">
                  Además de la contraseña, para entrar hay que escribir un código de seis
                  dígitos que cambia cada 30 segundos. Si alguien se queda con tu
                  contraseña, sin el teléfono no entra.
                </p>

                {paso2fa === "inicio" && (
                  <button type="button" className="btn-accent"
                    onClick={() => { setPaso2fa("clave"); setError2fa(""); setAviso2fa(""); }}>
                    Activar
                  </button>
                )}

                {paso2fa === "clave" && (
                  <form onSubmit={pedirSecreto} className="space-y-3">
                    <div>
                      <label className="label" htmlFor="clave-2fa">Confirmá con tu contraseña actual</label>
                      <input id="clave-2fa" className="input" type="password" value={clave2fa}
                        onChange={(e) => setClave2fa(e.target.value)} autoComplete="current-password" />
                    </div>
                    <div className="flex gap-2">
                      <button className="btn-accent" disabled={ocupado2fa || !clave2fa}>
                        {ocupado2fa ? "Generando…" : "Continuar"}
                      </button>
                      <button type="button" className="btn-ghost" onClick={reiniciar2fa}>Cancelar</button>
                    </div>
                  </form>
                )}

                {paso2fa === "cargar" && (
                  <form onSubmit={confirmarActivacion} className="space-y-3">
                    <p className="text-sm text-ink-700">
                      Abrí tu app de autenticación —Google Authenticator, Authy, 1Password,
                      la que uses— y escaneá este código:
                    </p>
                    {/*
                      El QR lo arma el servidor y llega como imagen embebida.
                      Del lado del navegador habría que sumarle una librería al
                      bundle que descargan todos los clientes, para una pantalla
                      que se abre una vez en la vida de la cuenta.

                      Si no se pudo generar, no se muestra un hueco: queda la
                      clave para tipear, que es la que siempre funciona.
                    */}
                    {qr2fa && (
                      <img
                        src={qr2fa}
                        alt="Código QR para cargar la cuenta en tu app de autenticación"
                        className="rounded-md border border-line bg-paper-100 p-2"
                        width={200}
                        height={200}
                      />
                    )}
                    <p className="text-sm text-ink-700">
                      {qr2fa ? "O cargá la clave a mano:" : "Cargá esta clave en la app:"}
                    </p>
                    <p className="select-all break-all rounded-md bg-paper-200 px-3 py-2 font-mono text-sm text-ink-950">
                      {secreto2fa}
                    </p>
                    {/*
                      Desde el teléfono, tocar el enlace abre la app y carga la
                      cuenta sola: es más rápido y más seguro que tipear 32
                      caracteres a mano, que es donde se cometen los errores.
                    */}
                    <p className="text-xs text-ink-500">
                      Si estás en el teléfono, <a className="text-brass-500 underline" href={uri2fa}>tocá acá</a> y
                      se carga sola.
                    </p>
                    <div>
                      <label className="label" htmlFor="codigo-2fa">Escribí el código que muestra la app</label>
                      <input id="codigo-2fa" className="input font-mono tracking-widest" value={codigo2fa}
                        maxLength={6} inputMode="numeric" placeholder="000000"
                        onChange={(e) => setCodigo2fa(e.target.value)} />
                    </div>
                    <div className="flex gap-2">
                      <button className="btn-accent" disabled={ocupado2fa || codigo2fa.trim().length < 6}>
                        {ocupado2fa ? "Verificando…" : "Activar"}
                      </button>
                      <button type="button" className="btn-ghost" onClick={reiniciar2fa}>Cancelar</button>
                    </div>
                  </form>
                )}
              </>
            )}

            {paso2fa !== "codigos" && activo2fa && (
              <>
                <p className="mb-1 text-sm text-ink-600">
                  Para entrar te pedimos el código de la app además de la contraseña.
                </p>
                <p className="mb-3 text-sm text-ink-600">
                  Te quedan <strong className="text-ink-900">{cuenta?.dobleFactor?.codigosRestantes ?? 0}</strong> códigos
                  de recuperación sin usar.
                </p>

                {paso2fa === "inicio" && (
                  <div className="flex gap-2">
                    <button type="button" className="btn-ghost border border-line"
                      onClick={() => { setPaso2fa("regenerar"); setError2fa(""); setAviso2fa(""); }}>
                      Generar códigos nuevos
                    </button>
                    <button type="button" className="btn-ghost border border-line"
                      onClick={() => { setPaso2fa("apagar"); setError2fa(""); setAviso2fa(""); }}>
                      Desactivar
                    </button>
                  </div>
                )}

                {(paso2fa === "regenerar" || paso2fa === "apagar") && (
                  <form onSubmit={paso2fa === "apagar" ? apagar2fa : pedirCodigosNuevos} className="space-y-3">
                    {paso2fa === "apagar" && (
                      <p className="rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
                        Sin el segundo paso, tu contraseña vuelve a ser lo único que separa
                        a alguien de tu cuenta.
                      </p>
                    )}
                    {paso2fa === "regenerar" && (
                      <p className="rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
                        Los códigos que tengas anotados van a dejar de servir.
                      </p>
                    )}
                    <div>
                      <label className="label" htmlFor="clave-2fa-op">Contraseña actual</label>
                      <input id="clave-2fa-op" className="input" type="password" value={clave2fa}
                        onChange={(e) => setClave2fa(e.target.value)} autoComplete="current-password" />
                    </div>
                    <div>
                      <label className="label" htmlFor="codigo-2fa-op">Código de la app (o uno de recuperación)</label>
                      <input id="codigo-2fa-op" className="input font-mono tracking-widest" value={codigo2fa}
                        onChange={(e) => setCodigo2fa(e.target.value)} placeholder="000000" />
                    </div>
                    <div className="flex gap-2">
                      <button className="btn-accent" disabled={ocupado2fa || !clave2fa || !codigo2fa.trim()}>
                        {ocupado2fa ? "Verificando…" : paso2fa === "apagar" ? "Desactivar" : "Generar códigos"}
                      </button>
                      <button type="button" className="btn-ghost" onClick={reiniciar2fa}>Cancelar</button>
                    </div>
                  </form>
                )}
              </>
            )}

            {/*
              ── Otras formas de recibir el código ──────────────────
              Se pueden tener las tres prendidas. Cada una que se suma es otra
              forma de entrar el día que se pierde el teléfono, y ninguna
              debilita a las otras: para pasar hace falta UNA, y las tres piden
              algo que sólo el dueño tiene.

              Sólo se listan los canales que este servidor puede entregar de
              verdad: ofrecer WhatsApp sin credenciales cargadas dejaría a
              alguien esperando un código que no va a llegar.
            */}
            {paso2fa !== "codigos" && (
              <div className="mt-4 border-t border-line pt-4">
                <p className="mb-1 text-sm font-medium text-ink-900">Otras formas de recibir el código</p>
                <p className="mb-3 text-xs text-ink-500">
                  Podés tener varias prendidas a la vez. Con una alcanza para entrar.
                </p>

                {errorCanal && (
                  <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorCanal}</p>
                )}

                <ul className="space-y-2">
                  {[
                    { id: "email", nombre: "Código al mail", detalle: cuenta?.email },
                    { id: "whatsapp", nombre: "Código por WhatsApp", detalle: cuenta?.ownerTelefono || "sin teléfono cargado" },
                  ].map((c) => {
                    const prendido = (cuenta?.dobleFactor?.canales || []).includes(c.id);
                    const disponible = (cuenta?.dobleFactor?.canalesDisponibles || []).includes(c.id);
                    const abierto = canalEnCurso === c.id;
                    return (
                      <li key={c.id} className="rounded-md bg-paper-200 px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm text-ink-900">
                              {c.nombre} {prendido && <span className="badge badge-ok ml-1">Activo</span>}
                            </p>
                            <p className="truncate text-xs text-ink-500">{c.detalle}</p>
                          </div>
                          {!abierto && (
                            disponible || prendido ? (
                              <button type="button" className="btn-ghost px-2 py-1 text-xs"
                                onClick={() => {
                                  cerrarCanal();
                                  setCanalEnCurso(c.id);
                                  setAccionCanal(prendido ? "apagar" : "prender");
                                  setAviso2fa("");
                                }}>
                                {prendido ? "Apagar" : "Activar"}
                              </button>
                            ) : (
                              <span className="text-xs text-ink-500">No disponible</span>
                            )
                          )}
                        </div>

                        {abierto && (
                          <form className="mt-3 space-y-2" onSubmit={destinoCanal || accionCanal === "apagar" ? confirmarCanal : mandarCodigoCanal}>
                            <div>
                              <label className="label" htmlFor={`clave-canal-${c.id}`}>Contraseña actual</label>
                              <input id={`clave-canal-${c.id}`} className="input" type="password" value={claveCanal}
                                onChange={(e) => setClaveCanal(e.target.value)} autoComplete="current-password" />
                            </div>

                            {(destinoCanal || accionCanal === "apagar") && (
                              <div>
                                <label className="label" htmlFor={`codigo-canal-${c.id}`}>
                                  {accionCanal === "apagar"
                                    ? "Código de la app, del mail o uno de recuperación"
                                    : `Código que te mandamos a ${destinoCanal}`}
                                </label>
                                <input id={`codigo-canal-${c.id}`} className="input font-mono tracking-widest"
                                  value={codigoCanal} placeholder="000000"
                                  onChange={(e) => setCodigoCanal(e.target.value)} />
                              </div>
                            )}

                            <div className="flex gap-2">
                              <button className="btn-accent px-3 py-1.5 text-xs" disabled={ocupadoCanal || !claveCanal}>
                                {ocupadoCanal
                                  ? "Un momento…"
                                  : accionCanal === "apagar"
                                    ? "Apagar"
                                    : destinoCanal ? "Confirmar" : "Mandame el código"}
                              </button>
                              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={cerrarCanal}>
                                Cancelar
                              </button>
                            </div>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-500">
              <ShieldCheck size={13} className="mt-0.5 shrink-0" />
              Los empleados entran con su propio usuario y no se ven afectados por esto.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
