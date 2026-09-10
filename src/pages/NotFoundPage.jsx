import { Link, useLocation } from "react-router-dom";
import { Compass } from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";

/*
 * Pantalla para una dirección que no existe.
 *
 * Antes cualquier ruta desconocida redirigía al dashboard sin decir nada. El
 * problema no es estético: quien llegó por un enlace viejo, un favorito roto o
 * una letra de más termina en una pantalla que no pidió, sin ninguna señal de
 * que se equivocó de dirección, y lo más probable es que crea que la función
 * que buscaba se eliminó.
 *
 * Va adentro del armazón de la app —con la barra lateral— a propósito: el
 * error es de la dirección, no de la sesión, y sacarle la navegación a alguien
 * que sí está adentro convierte un tropiezo en un callejón.
 */
export default function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <div>
      <PageHeader title="Esta página no existe" subtitle="La dirección no corresponde a ninguna pantalla de Stocker" />

      <Card className="max-w-xl">
        <div className="flex items-start gap-3">
          <Compass size={20} className="mt-0.5 shrink-0 text-ink-500" />
          <div>
            <p className="text-sm text-ink-700">
              Pediste <code className="break-all rounded bg-paper-200 px-1.5 py-0.5 font-mono text-xs text-ink-900">{pathname}</code>,
              y no hay nada en esa dirección.
            </p>
            <p className="mt-2 text-sm text-ink-600">
              Suele pasar con un favorito viejo, un enlace que quedó de una versión
              anterior, o una letra de más. Los datos no se tocaron.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link className="btn-accent" to="/dashboard">Ir al inicio</Link>
              <Link className="btn-ghost border border-line" to="/ventas">Ver ventas</Link>
              <Link className="btn-ghost border border-line" to="/stock">Ver stock</Link>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
