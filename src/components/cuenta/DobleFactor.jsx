import { useState } from "react";
import { Smartphone, ShieldCheck } from "lucide-react";
import {
  iniciar2FA, activar2FA, desactivar2FA, regenerarCodigos2FA,
  enviarCodigoCanal2FA, activarCanal2FA, desactivarCanal2FA, updateAccount,
} from "../../services/accountService";
import { Card } from "../ui/Layout";

/*
 * Verificación en dos pasos del dueño: la app (TOTP con QR), y los canales de
 * código por mail y WhatsApp.
 *
 * MOVIDO tal cual desde la pantalla de Mi cuenta a la pestaña Seguridad. Son
 * unos veinte estados con flujos delicados —activar en dos pasos, códigos de
 * recuperación que se ven una sola vez, canales que se prenden con un código—
 * y cada cosa que se reescribe es una regresión posible. Lo único nuevo es de
 * dónde salen la cuenta y la recarga: antes eran de la página, ahora llegan
 * por props (`cuenta`, `recargar`).
 */
export default function DobleFactor({ cuenta, recargar }) {
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
      await recargar();
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
      await recargar();
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
      await recargar();
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
      await recargar();
    } catch (err) {
      setError2fa(err.response?.data?.message || "No se pudieron regenerar");
    } finally { setOcupado2fa(false); }
  }

  return (
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

      {/*
        Cada cuánto se vuelve a pedir el código. Antes se pedía cada vez que
        la sesión se cerraba por inactividad; ahora alcanza con la contraseña
        mientras esta computadora se siga usando dentro de estas horas.
      */}
      {activo2fa && (
        <div className="mt-4 border-t border-line pt-3">
          <label className="label" htmlFor="ventana-2fa">Pedir el código otra vez</label>
          <select
            id="ventana-2fa"
            className="input"
            value={cuenta?.dobleFactor?.ventanaH ?? 24}
            onChange={async (e) => {
              setError2fa("");
              try { await updateAccount({ dobleFactorVentanaH: Number(e.target.value) }); await recargar(); }
              catch (err) { setError2fa(err.response?.data?.message || "No se pudo guardar"); }
            }}
          >
            <option value={0}>En cada ingreso</option>
            <option value={1}>Después de 1 hora sin usar Stocker en esa computadora</option>
            <option value={8}>Después de 8 horas sin usar Stocker en esa computadora</option>
            <option value={24}>Después de 24 horas sin usar Stocker en esa computadora</option>
            <option value={72}>Después de 3 días sin usar Stocker en esa computadora</option>
            <option value={168}>Después de 7 días sin usar Stocker en esa computadora</option>
          </select>
          <p className="mt-1 text-xs text-ink-500">
            Mientras tanto, cuando la sesión se cierra por inactividad alcanza con la contraseña.
            Cambiar la contraseña o cerrar todas las sesiones vuelve a pedir el código en todas las computadoras.
          </p>
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-500">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        Los empleados entran con su propio usuario y no se ven afectados por esto.
      </p>
    </Card>
  );
}
