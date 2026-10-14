import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Truck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { PageHeader, Card } from "../../components/ui/Layout";
import CotizacionForm from "../../components/plataformas/CotizacionForm";
import PedidosMayoristasPage from "../PedidosMayoristasPage";
import { fetchPlataformas } from "../../services/plataformasService";
import { haceCuanto } from "../../utils/cuenta";
import { plataforma, muestraBandejaMayorista, avisoDeUso, ultimaCotizacion } from "../../utils/plataformas";
import { esAdministradorTotal } from "../../utils/permissions";
import { useAuth } from "../../context/AuthContext";

/*
 * Plataformas → Mayoristas.
 *
 * Con portal (credencial viva de origen 'isuwaya'): la bandeja de pedidos
 * mayoristas de siempre, sin tocarla. Sin portal: qué es, y el pedido de
 * cotización de uno hecho a medida (decisión del dueño).
 *
 * Se decide por la credencial y no por si llegaron pedidos: un portal recién
 * conectado todavía no mandó nada y tiene que ver su bandeja. Y si el portal
 * ya no está pero quedaron pedidos, la bandeja sigue abajo de la explicación:
 * son datos del negocio y no se esconden.
 *
 * Si no se puede leer el estado, se muestra la bandeja: es lo que se usa
 * todos los días, y un error al leer el estado no puede dejar a nadie sin
 * ella.
 */
const QUE_ES = [
  "Tus clientes mayoristas entran a un portal con tu catálogo y tus precios mayoristas, y arman el pedido solos.",
  "Cada pedido llega a esta bandeja. No aparta stock: alguien lo revisa y lo acepta —y ahí se registra como venta, con tu local y tu caja— o lo rechaza con un motivo.",
  "El portal se entera de lo que decidiste, sin que tengas que avisarle a nadie.",
];

export default function MayoristasPage() {
  const { user } = useAuth();
  const [estado, setEstado] = useState(null);
  const [fallo, setFallo] = useState(false);

  async function cargar() {
    try {
      setEstado(await fetchPlataformas());
      setFallo(false);
    } catch {
      setFallo(true);
    }
  }
  useEffect(() => { cargar(); }, []);

  if (!estado && !fallo) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (fallo) return <PedidosMayoristasPage />;

  const p = plataforma(estado, "mayorista");
  const conBandeja = muestraBandejaMayorista(estado);

  // Con portal conectado: la bandeja, con una línea de estado arriba.
  if (p?.conectada) {
    return (
      <div>
        <EstadoDelPortal p={p} duenio={esAdministradorTotal(user)} />
        <PedidosMayoristasPage />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Pedidos mayoristas"
        subtitle="Un portal propio para que tus clientes mayoristas te hagan los pedidos solos."
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <h3 className="mb-2 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
            <Truck size={17} className="text-brass-700" /> Tu negocio todavía no tiene un portal mayorista
          </h3>
          <ul className="space-y-2 text-sm text-ink-600">
            {QUE_ES.map((t) => <li key={t}>· {t}</li>)}
          </ul>
          <p className="mt-3 text-sm text-ink-600">
            El portal se hace a medida para tu negocio (tu marca, tus condiciones de venta) y se cotiza por única
            vez. Cómo se conecta con Stocker está en el <Link className="underline" to="/plataformas">Resumen</Link>.
          </p>
        </Card>
        <Card>
          <h3 className="mb-3 font-display text-base font-semibold text-ink-950">Pedir la cotización de tu portal</h3>
          <CotizacionForm
            tipo="portal_mayorista"
            plataforma={p}
            whatsapp={estado?.whatsapp?.portal_mayorista}
            ultima={ultimaCotizacion(estado, "portal_mayorista")}
            placeholder={"Ej: vendemos por mayor a unos 40 locales del interior y hoy tomamos los pedidos por WhatsApp.\nQueremos que vean el catálogo con precio mayorista y armen el pedido solos."}
            onEnviada={cargar}
          />
        </Card>
      </div>

      {conBandeja && (
        <div className="mt-8 border-t border-line pt-6">
          <p className="mb-3 text-sm text-ink-600">Los pedidos que llegaron de tu portal anterior siguen acá.</p>
          <PedidosMayoristasPage />
        </div>
      )}
    </div>
  );
}

function EstadoDelPortal({ p, duenio }) {
  const aviso = avisoDeUso(p);
  if (p.estado === "fuera_de_plan") {
    return (
      <p className="mb-4 flex items-start gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-700" role="alert">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <span>
          Tu plan no incluye el portal mayorista: Stocker está rechazando los pedidos que manda.
          {" "}{duenio
            ? <>Pasá al {p.desde?.nombre || "plan que lo incluye"} desde <Link className="underline" to="/cuenta/suscripcion">Suscripción</Link>.</>
            : <>Avisale al dueño del negocio.</>}
        </span>
      </p>
    );
  }
  return (
    <p className={`mb-4 flex items-start gap-2 rounded-md px-3 py-2 text-xs ${aviso ? "bg-brass-50 text-brass-800" : "bg-paper-100 text-ink-600"}`}>
      {aviso ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-teal-600" />}
      <span>
        Portal conectado
        {p.detalle?.ultimoUso ? ` · se comunicó con Stocker ${haceCuanto(p.detalle.ultimoUso)}` : ""}
        {aviso ? `. ${aviso}` : ""}
      </span>
    </p>
  );
}
