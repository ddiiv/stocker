import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShoppingBag, Store, Globe, Truck, ArrowRight, RefreshCw, Plug } from "lucide-react";
import { PageHeader, Card } from "../../components/ui/Layout";
import EstadoPlataforma from "../../components/plataformas/EstadoPlataforma";
import { fetchPlataformas } from "../../services/plataformasService";
import { mensajeDeError } from "../../utils/errores";
import { haceCuanto } from "../../utils/cuenta";
import { pestanasDePlataformas, plataforma } from "../../utils/plataformas";
import { useAuth } from "../../context/AuthContext";

/*
 * Plataformas → Resumen: todas las formas de conectar el negocio con dónde
 * vende, y cómo está cada una.
 *
 * Sólo lo que existe de verdad. Lo que esta pantalla muestra como "se puede
 * conectar" es una promesa al cliente, y una plataforma que no está construida
 * no va acá aunque se piense hacer.
 */
const TARJETAS = [
  {
    clave: "mercadolibre",
    icono: ShoppingBag,
    to: "/plataformas/mercadolibre",
    como: "Autorizás tu cuenta de Mercado Libre. Stocker publica el stock por SKU y trae las ventas.",
  },
  {
    clave: "jumpseller",
    icono: Store,
    to: "/plataformas/jumpseller",
    como: "Cargás la clave de tu tienda Jumpseller. Stocker le manda el stock y trae los pedidos.",
  },
  {
    clave: "tienda",
    icono: Globe,
    to: "/plataformas/tienda",
    como: "Tu propia página de venta online, hecha a medida, conectada con una credencial que entrega el equipo de Stocker.",
  },
  {
    clave: "mayorista",
    icono: Truck,
    to: "/plataformas/mayoristas",
    como: "Un portal donde tus clientes mayoristas arman sus pedidos. Llegan a una bandeja para aceptarlos o rechazarlos.",
  },
];

/*
 * El protocolo, en el idioma del cliente.
 *
 * Resume el contrato de movimientos (back/docs/contrato-movimientos.md) sin
 * nombres de rutas ni detalles internos: lo que quien pide una página a medida
 * necesita saber para entender qué va a hacer y qué no. La guía técnica se la
 * pasa el equipo a quien la programa, al conectar.
 */
const PASOS_PROTOCOLO = [
  ["Una credencial por página", "El equipo de Stocker emite una clave larga para tu página y se la entrega una sola vez a quien la programa. Si se pierde o cambia quien te hace la página, se emite otra y la anterior deja de servir."],
  ["La página pregunta, Stocker responde", "Catálogo, precios y stock disponible para vender online salen siempre de Stocker. La página no calcula ni corrige el stock: lo consulta."],
  ["Al vender, Stocker aparta en el momento", "La página manda el pedido y Stocker reserva la mercadería al instante. Si no alcanza el stock no descuenta nada y la página se entera en la misma respuesta."],
  ["Un pedido nunca se cuenta dos veces", "Cada pedido viaja con su número. Si por un corte la página lo manda de nuevo, Stocker lo reconoce y lo registra una sola vez."],
  ["Lo que pasa después, se consulta", "Cobros, despachos y cancelaciones la página los pregunta cada tanto. Si se cae un rato, cuando vuelve sigue desde donde quedó y no se pierde nada."],
  ["El portal mayorista no aparta", "Un pedido mayorista queda en la bandeja hasta que alguien lo acepta (y ahí se convierte en venta) o lo rechaza con un motivo que le llega al portal."],
];

const NO_HACE = [
  "No emite facturas: las emite Stocker contra ARCA.",
  "No decide precios: usa los de Stocker.",
  "No toca el stock: lo consulta y manda cantidades.",
];

export default function ResumenPage() {
  const { user } = useAuth();
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);

  async function cargar() {
    setCargando(true);
    setError("");
    try {
      setEstado(await fetchPlataformas());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo leer el estado de las plataformas."));
    } finally {
      setCargando(false);
    }
  }
  useEffect(() => { cargar(); }, []);

  // Sólo se ofrece entrar a las pestañas que el cargo puede abrir.
  const visibles = new Set(pestanasDePlataformas(user).map((t) => t.to));

  return (
    <div>
      <PageHeader
        title="Plataformas"
        subtitle="Todas las formas de conectar tu negocio con dónde vendés, y cómo está cada una."
        actions={
          <button className="btn-ghost" onClick={cargar} disabled={cargando}>
            <RefreshCw size={15} className={cargando ? "animate-spin" : ""} /> Actualizar
          </button>
        }
      />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500" role="alert">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {TARJETAS.map(({ clave, icono: Icono, to, como }) => {
          const p = plataforma(estado, clave);
          const detalle = p?.detalle || {};
          return (
            <Card key={clave} className="flex flex-col gap-3">
              {/* Envuelve: "Disponible desde el Plan Pro" no entra al lado del
                  nombre en una tarjeta angosta, y cortado se lee mal. */}
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper-200 text-ink-700">
                    <Icono size={18} />
                  </div>
                  <h3 className="font-display text-base font-semibold text-ink-950">{p?.nombre || clave}</h3>
                </div>
                {cargando && !estado
                  ? <span className="h-5 w-24 animate-pulse rounded-full bg-paper-200" />
                  : p && <EstadoPlataforma plataforma={p} />}
              </div>
              <p className="text-sm text-ink-600">{como}</p>
              {p?.conectada && (
                <p className="text-xs text-ink-500">
                  {detalle.cuenta && <>Cuenta: <strong className="text-ink-700">{detalle.cuenta}</strong> · </>}
                  {"ultimaSync" in detalle && <>Última sincronización: {haceCuanto(detalle.ultimaSync)}</>}
                  {"conectadaDesde" in detalle && <>Último uso: {detalle.ultimoUso ? haceCuanto(detalle.ultimoUso) : "todavía no"}</>}
                </p>
              )}
              {clave === "mayorista" && estado?.mayoristas?.pendientes > 0 && (
                <p className="text-xs font-medium text-brass-800">
                  {estado.mayoristas.pendientes} pedido{estado.mayoristas.pendientes === 1 ? "" : "s"} por revisar
                </p>
              )}
              {visibles.has(to) && (
                <Link to={to} className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline">
                  {p?.conectada ? "Ver" : "Ver cómo conectarla"} <ArrowRight size={14} />
                </Link>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <h3 className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
          <Plug size={17} className="text-brass-700" /> Cómo se conecta una página hecha a medida
        </h3>
        <p className="mb-4 text-sm text-ink-600">
          Tu tienda online propia y el portal mayorista hablan con Stocker de la misma manera. Esto es lo que
          pasa, sin tecnicismos; la guía técnica se la damos a quien programe la página cuando la conectamos.
        </p>
        <ol className="grid gap-3 md:grid-cols-2">
          {PASOS_PROTOCOLO.map(([titulo, texto], i) => (
            <li key={titulo} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-950 text-xs font-semibold text-paper-50">{i + 1}</span>
              <div>
                <p className="text-sm font-medium text-ink-950">{titulo}</p>
                <p className="text-sm text-ink-600">{texto}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-500">Lo que la página nunca hace</p>
          <ul className="space-y-0.5 text-sm text-ink-600">
            {NO_HACE.map((t) => <li key={t}>· {t}</li>)}
          </ul>
        </div>
        {(visibles.has("/plataformas/tienda") || visibles.has("/plataformas/mayoristas")) && (
          <p className="mt-4 text-sm text-ink-700">
            ¿No tenés la página todavía? La cotizamos:{" "}
            {visibles.has("/plataformas/tienda") && <Link className="font-medium text-teal-700 hover:underline" to="/plataformas/tienda">tienda propia</Link>}
            {visibles.has("/plataformas/tienda") && visibles.has("/plataformas/mayoristas") && " o "}
            {visibles.has("/plataformas/mayoristas") && <Link className="font-medium text-teal-700 hover:underline" to="/plataformas/mayoristas">portal mayorista</Link>}.
          </p>
        )}
      </Card>
    </div>
  );
}
