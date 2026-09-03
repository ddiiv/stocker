import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Copy, Check, AlertTriangle } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { Card, PageHead, Aviso, Cargando, Vacio, Tabla } from "../components/ui";

/*
 * Los CUIT esperando el trámite de delegación en AFIP.
 *
 * Es la única parte del alta de un cliente que no se puede automatizar: la
 * relación la tiene que crear una persona con la clave fiscal de Stocker, en el
 * AFIP del cliente. Va a seguir siendo a mano.
 *
 * Lo que sí se automatiza es enterarse y no perderlo. Antes el circuito era: el
 * cliente carga su CUIT, aprieta "Verificar", le sale un error que no puede
 * resolver solo, y ahí escribe. Ahora llega un mail cuando aparece uno, y esta
 * pantalla dice cuáles siguen abiertos y hace cuánto.
 *
 * Hace falta la lista además del mail. Un mail se lee una vez, se pospone y se
 * pierde entre los otros; el trámite queda sin hacer y el cliente sin poder
 * facturar, sin que nadie lo sepa hasta que vuelve a escribir.
 */

/*
 * Los pasos van acá y no en un instructivo aparte.
 *
 * Es un trámite que se hace cada varios meses: nadie se lo acuerda, y buscar
 * dónde estaba anotado es la mitad del tiempo que lleva hacerlo.
 */
const PASOS = [
  {
    que: "Entrar a AFIP con la clave fiscal de Stocker → Administrador de Relaciones.",
    ojo: null,
  },
  {
    que: 'Tocar "Actuar en nombre de" y elegir al CUIT del cliente.',
    ojo: "Este es el paso que se saltea. Si la relación se crea en nombre propio queda apuntando a nuestro CUIT, el token sale sin el del cliente, y AFIP contesta el mismo error que si no se hubiera hecho nada.",
  },
  {
    que: 'Nueva relación → Servicio: "Facturación Electrónica" (webservice wsfe).',
    ojo: '"Comprobantes en línea" es otro servicio: sirve para facturar a mano desde el sitio de AFIP y no habilita nada acá.',
  },
  {
    que: "Representante: el alias del certificado (Computador Fiscal), no una persona.",
    ojo: null,
  },
  {
    que: "Confirmar que se hizo en el mismo ambiente que figura en la fila.",
    ojo: "Homologación y producción son dos listas separadas. Hacer el trámite en una y consultar la otra da exactamente este error.",
  },
  {
    que: 'Avisarle al cliente que apriete "Verificar" de nuevo.',
    ojo: null,
  },
];

function Espera({ dias }) {
  if (dias === null || dias === undefined) return <span className="text-faint">—</span>;
  /*
   * Se marca a partir de tres días. Antes de eso el trámite está fresco y
   * pintar todo de rojo hace que el rojo deje de significar algo.
   */
  const tarde = dias >= 3;
  return (
    <span className={tarde ? "font-medium text-crit" : "text-dim"}>
      {dias === 0 ? "hoy" : dias === 1 ? "1 día" : `${dias} días`}
    </span>
  );
}

function Copiable({ valor }) {
  const [copiado, setCopiado] = useState(false);
  if (!valor) return <span className="text-faint">—</span>;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(valor);
        setCopiado(true);
        setTimeout(() => setCopiado(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 font-mono text-sm text-text hover:text-brass"
      title="Copiar el CUIT"
    >
      {valor}
      {copiado ? <Check size={13} className="text-ok" /> : <Copy size={13} className="opacity-40" />}
    </button>
  );
}

export default function ArcaPage() {
  const [pendientes, setPendientes] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const r = await api.getDelegacionesArca();
      setPendientes(r.pendientes || []);
    } catch (e) {
      setError(mensajeDe(e));
      setPendientes([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  return (
    <div>
      <PageHead
        titulo="Delegaciones de AFIP"
        bajada="Los CUIT de clientes esperando que hagamos el trámite. Es la única parte del alta que no se puede automatizar."
        acciones={
          <button onClick={cargar} disabled={cargando} className="btn-ghost gap-1.5 text-sm">
            <RefreshCw size={14} className={cargando ? "animate-spin" : ""} /> Actualizar
          </button>
        }
      />

      {error && <Aviso tono="error">{error}</Aviso>}

      {pendientes === null ? (
        <Cargando />
      ) : pendientes.length === 0 ? (
        <Card>
          <Vacio>No hay ninguna delegación pendiente. Todos los CUIT cargados pueden facturar.</Vacio>
        </Card>
      ) : (
        <Card className="p-0">
          <Tabla
            cabeceras={["Cliente", "CUIT a habilitar", "Ambiente", "Esperando", "Qué contestó AFIP"]}
            min="min-w-[900px]"
          >
            {pendientes.map((p) => (
              <tr key={p.configId} className="border-b border-line last:border-0">
                <td className="px-4 py-3">
                  <p className="font-medium text-text">{p.negocio?.nombre || "—"}</p>
                  <p className="text-xs text-dim">{p.negocio?.email || ""}</p>
                </td>
                <td className="px-4 py-3">
                  <Copiable valor={p.cuit} />
                  {p.nombreFiscal && <p className="text-xs text-dim">{p.nombreFiscal}</p>}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.ambiente === "produccion"
                        ? "bg-crit-bg text-crit"
                        : "bg-surface2 text-dim"
                    }`}
                  >
                    {p.ambiente}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">
                  <Espera dias={p.diasEsperando} />
                  {/* Que ya se haya avisado importa: si el mail salió y el
                      trámite sigue abierto, el problema no es que nadie se
                      enteró. */}
                  {p.avisadoEn && (
                    <p className="text-[11px] text-faint">avisado por mail</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <p className="max-w-md text-xs text-dim">{p.ultimoError || "—"}</p>
                </td>
              </tr>
            ))}
          </Tabla>
        </Card>
      )}

      <Card className="mt-5">
        <h3 className="mb-1 text-base font-semibold text-text">Cómo se hace el trámite</h3>
        <p className="mb-4 text-xs text-dim">
          Se hace una vez por CUIT y habilita a Stocker a facturar en nombre de ese cliente.
        </p>
        <ol className="space-y-3">
          {PASOS.map((p, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface2 text-[11px] font-semibold text-text">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm text-text">{p.que}</p>
                {p.ojo && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-dim">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
                    <span>{p.ojo}</span>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
