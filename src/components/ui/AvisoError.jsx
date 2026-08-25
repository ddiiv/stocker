import { Link } from "react-router-dom";
import { AlertTriangle, WifiOff, Lock, Clock, PackageX, ServerCrash } from "lucide-react";

/*
 * El aviso de error de una operación, con su causa y su salida.
 *
 * Cada tipo lleva su ícono y su color porque son problemas de naturaleza
 * distinta: quedarse sin stock es parte del trabajo del día, perder la sesión
 * es una molestia, y un 500 es algo que la persona del mostrador no puede
 * arreglar. Mostrarlos todos iguales obliga a leer el texto entero para saber
 * si hay algo que hacer.
 */

const ICONO = {
  red: WifiOff,
  sesion: Lock,
  permiso: Lock,
  turno: Clock,
  stock: PackageX,
  servidor: ServerCrash,
};

const TONO = {
  stock:  "border-brass-300 bg-brass-50 text-brass-800",
  turno:  "border-brass-300 bg-brass-50 text-brass-800",
  sesion: "border-brass-300 bg-brass-50 text-brass-800",
  red:    "border-ink-400/30 bg-paper-100 text-ink-700",
  servidor: "border-ink-400/30 bg-paper-100 text-ink-700",
};

export default function AvisoError({ error, className = "" }) {
  if (!error) return null;
  const Icono = ICONO[error.tipo] || AlertTriangle;
  const tono = TONO[error.tipo] || "border-brick-500/30 bg-brick-50 text-brick-500";

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${tono} ${className}`}>
      <p className="flex items-start gap-2 font-medium">
        <Icono size={15} className="mt-0.5 shrink-0" />
        <span>{error.titulo}</span>
      </p>
      {error.detalle && <p className="mt-1 pl-6 text-xs opacity-90">{error.detalle}</p>}
      {error.accion && (
        <Link to={error.accion.href} className="mt-1.5 ml-6 inline-block text-xs font-medium underline">
          {error.accion.texto}
        </Link>
      )}
    </div>
  );
}
