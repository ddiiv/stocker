import { useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, XCircle, AlertTriangle, Copy, Check } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { Card, PageHead, Aviso, Cargando } from "../components/ui";

/*
 * Estado de la pasarela de cobro.
 *
 * Existe porque el primer cobro real siempre falla por algo chico: el token es
 * de prueba, falta la URL del webhook, o el secreto de firma no se copió.
 * Averiguar cuál de las tres es la parte lenta, y esta pantalla la salta.
 *
 * No muestra el token ni el secreto: sólo si están cargados y si Mercado Pago
 * los acepta. Un panel que imprime credenciales es una credencial filtrada
 * cada vez que alguien comparte una captura.
 */

/* Las variables se documentan acá y no en un README: es donde se las busca. */
const VARIABLES = [
  {
    clave: "MP_ACCESS_TOKEN",
    que: "Access Token de producción de tu aplicación de Mercado Pago.",
    donde: "mercadopago.com.ar/developers → Tus integraciones → tu app → Credenciales de producción",
  },
  {
    clave: "MP_WEBHOOK_URL",
    que: "A dónde avisa Mercado Pago que un pago se acreditó. Sin esto hay que aprobar cada cobro a mano.",
    donde: "El dominio PÚBLICO de tu app: https://tu-app.up.railway.app/api/billing/webhook/mercadopago",
  },
  {
    clave: "MP_WEBHOOK_SECRET",
    que: "Firma de los avisos. Sin ella cualquiera que conozca la URL podría activar cuentas gratis.",
    donde: "En la misma pantalla de la app → Webhooks → Clave secreta",
  },
  {
    clave: "MP_BACK_URL",
    que: "A dónde vuelve el cliente después de pagar. Con localhost ve un error de conexión.",
    donde: "https://tu-app.up.railway.app/cuenta/suscripcion",
  },
];

export default function CobrosPage() {
  const [mp, setMp] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [copiada, setCopiada] = useState("");

  async function cargar() {
    setCargando(true); setError("");
    try { setMp(await api.getMercadoPago()); }
    catch (e) { setError(mensajeDe(e, "No se pudo consultar Mercado Pago.")); }
    finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  function copiar(texto, clave) {
    navigator.clipboard?.writeText(texto).then(() => {
      setCopiada(clave);
      setTimeout(() => setCopiada(""), 1500);
    });
  }

  if (cargando) return <Cargando texto="Consultando Mercado Pago…" />;

  return (
    <div>
      <PageHead
        titulo="Cobros"
        bajada="Con qué cuenta se cobran las suscripciones"
        acciones={
          <button className="btn-ghost btn-sm" onClick={cargar}>
            <RefreshCw size={13} /> Volver a chequear
          </button>
        }
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>

      {mp && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* ── Diagnóstico ──────────────────────────────── */}
          <Card className={`p-4 lg:col-span-2 ${
            !mp.cuentaValida ? "stripe-crit" : mp.modo === "prueba" ? "stripe-warn" : ""
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">Mercado Pago</p>
                <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
                  {mp.cuentaValida ? (
                    <><CheckCircle2 size={18} className="text-ok" /> Conectado</>
                  ) : (
                    <><XCircle size={18} className="text-crit" /> Sin conectar</>
                  )}
                </p>
              </div>
              <span className={`chip ${
                mp.modo === "produccion" ? "chip-ok" : mp.modo === "prueba" ? "chip-warn" : "chip-mute"
              }`}>
                {mp.modo === "produccion" ? "Producción" : mp.modo === "prueba" ? "Prueba" : "Sin configurar"}
              </span>
            </div>

            {mp.problema && (
              <p className="mt-3 rounded-[3px] border border-crit/40 bg-crit-bg px-3 py-2 text-sm text-crit">
                {mp.problema}
              </p>
            )}

            {mp.cuenta && (
              <dl className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
                <Dato k="Cuenta" v={mp.cuenta.apodo || `#${mp.cuenta.id}`} />
                <Dato k="Email" v={mp.cuenta.email || "—"} />
                <Dato k="País" v={mp.cuenta.pais || "—"} />
                <Dato k="ID de usuario" v={String(mp.cuenta.id)} mono />
              </dl>
            )}

            {/* Los checks van juntos: es la lista que uno recorre cuando algo
                no anda, y separarlos obliga a mirar en dos lugares. */}
            <ul className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
              <Check2 ok={mp.tokenCargado} texto="Access Token cargado" />
              <Check2
                ok={mp.webhookConfigurado}
                texto="URL del webhook configurada"
                detalle={mp.webhookUrl}
                aviso="Sin esto los pagos no se acreditan solos: hay que aprobarlos desde la ficha de la cuenta."
              />
              <Check2
                ok={mp.firmaVerificable}
                texto="Firma del webhook verificable"
                aviso="Sin el secreto, el aviso se procesa pero queda registrado como no verificado."
              />
              <Check2 ok={Boolean(mp.urlDeRetorno)} texto="URL de retorno configurada" detalle={mp.urlDeRetorno} />
            </ul>

            {mp.advertencias?.length > 0 && (
              <div className="mt-4 space-y-1.5 border-t border-line pt-4">
                {mp.advertencias.map((a, i) => {
                  /*
                   * Una URL a localhost no es una advertencia: el pago entra y
                   * la cuenta no se activa, sin ningún error en el medio. Se
                   * pinta como problema para que no se lea como un detalle.
                   */
                  const grave = /localhost|vacía|https en producción/i.test(a);
                  return (
                    <p key={i} className={`flex items-start gap-2 text-xs ${grave ? "text-crit" : "text-warn"}`}>
                      {grave
                        ? <XCircle size={13} className="mt-0.5 shrink-0" />
                        : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
                      {a}
                    </p>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ── Cómo se cobra ────────────────────────────── */}
          <Card className="p-4">
            <p className="eyebrow mb-3">Cómo se cobra</p>
            <div className="space-y-3 text-sm text-dim">
              <p>
                <strong className="text-text">Débito automático.</strong> El cliente autoriza
                una vez y Mercado Pago cobra cada mes. Es lo que evita perseguir el cobro.
              </p>
              <p>
                <strong className="text-text">Link de un mes.</strong> Un pago suelto. Sirve
                para el primer mes o para quien no quiere dejar débito.
              </p>
              <p>
                <strong className="text-text">Transferencia.</strong> El cliente avisa y
                alguien lo verifica contra el banco. No se acredita sola.
              </p>
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs text-faint">
              Los tres caminos escriben en el mismo historial, así que la ficha de cada
              cuenta muestra todo junto.
            </p>
          </Card>
        </div>
      )}

      {/* ── Variables ──────────────────────────────────── */}
      <h2 className="mb-3 mt-8 text-lg font-semibold">Variables de entorno</h2>
      <Card className="divide-y divide-line2 p-0">
        {VARIABLES.map((v) => (
          <div key={v.clave} className="flex flex-wrap items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <button
                onClick={() => copiar(v.clave, v.clave)}
                className="inline-flex items-center gap-1.5 font-mono text-sm text-brass hover:underline"
                title="Copiar el nombre"
              >
                {v.clave}
                {copiada === v.clave ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
              </button>
              <p className="mt-1 text-sm text-dim">{v.que}</p>
              <p className="mt-0.5 break-words text-xs text-faint">{v.donde}</p>
            </div>
          </div>
        ))}
      </Card>

      <p className="mt-4 text-xs text-faint">
        Se cargan en las variables del servicio backend y toman efecto al reiniciarlo.
        Con un token que empiece en <span className="font-mono">TEST-</span> los pagos no
        mueven plata real, así que sirve para probar el flujo completo sin cobrarle a nadie.
      </p>
    </div>
  );
}

function Dato({ k, v, mono }) {
  return (
    <div>
      <dt className="eyebrow">{k}</dt>
      <dd className={`mt-0.5 break-words text-sm text-text ${mono ? "font-mono" : ""}`}>{v}</dd>
    </div>
  );
}

/* Un check con su porqué. El aviso sólo aparece cuando falta: explicar lo que
   ya está resuelto es ruido. */
function Check2({ ok, texto, detalle, aviso }) {
  return (
    <li>
      <p className="flex items-start gap-2">
        {ok
          ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
          : <XCircle size={15} className="mt-0.5 shrink-0 text-crit" />}
        <span className={ok ? "text-text" : "text-dim"}>{texto}</span>
      </p>
      {ok && detalle && <p className="ml-6 break-all font-mono text-[11px] text-faint">{detalle}</p>}
      {!ok && aviso && <p className="ml-6 text-xs text-warn">{aviso}</p>}
    </li>
  );
}
