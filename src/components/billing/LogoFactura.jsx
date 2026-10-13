import { useEffect, useRef, useState } from "react";
import { ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { fetchCuitLogo, uploadCuitLogo, deleteCuitLogo } from "../../services/businessCuitService";

/*
 * El logo que sale arriba a la izquierda de la factura, uno por CUIT.
 *
 * Los topes son los del backend (utils/logoFactura.js), que es el que decide:
 * acá se repiten para avisar ANTES de subir, con el mismo texto, en vez de
 * hacer esperar la subida para enterarse de que no sirve.
 */
const LOGO_MAX_KB = 300;
const LOGO_MAX_LADO = 2000;
const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/*
 * Qué es el archivo según sus primeros bytes, como lo mira el backend. La
 * extensión y el tipo que informa el sistema operativo los puede cambiar
 * cualquiera renombrando el archivo.
 */
async function formatoPorFirma(file) {
  const b = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (b.length >= 8 && FIRMA_PNG.every((v, i) => b[i] === v)) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  const texto = new TextDecoder().decode(b).replace(/^﻿/, "").trimStart();
  return texto.startsWith("<") ? "svg" : null;
}

function medidas(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ ancho: img.naturalWidth, alto: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/* Por qué este archivo no sirve como logo, o null si sirve. */
async function problemaDelArchivo(file) {
  if (file.size > LOGO_MAX_KB * 1024) {
    return `El logo pesa ${Math.ceil(file.size / 1024)} KB y el máximo es ${LOGO_MAX_KB} KB. Exportalo más chico o como JPG.`;
  }
  const formato = await formatoPorFirma(file);
  if (formato === "svg") {
    return "Los logos en SVG no se aceptan: un SVG puede llevar código adentro. Exportalo como PNG (mejor con fondo transparente) o como JPG.";
  }
  if (!formato) {
    return "El logo tiene que ser una imagen PNG o JPG. Otros formatos (SVG, WebP, GIF, PDF) no se aceptan, aunque el archivo se llame .png.";
  }
  const m = await medidas(file);
  if (!m) return "El archivo no se puede leer como imagen: puede estar dañado. Volvé a exportarlo.";
  if (m.ancho > LOGO_MAX_LADO || m.alto > LOGO_MAX_LADO) {
    return `El logo mide ${m.ancho} × ${m.alto} píxeles y el máximo es ${LOGO_MAX_LADO} de cada lado. Exportalo más chico: para la factura, con 1000 píxeles de ancho alcanza.`;
  }
  return null;
}

/*
 * La imagen guardada, como una dirección local (blob:) mientras se muestra.
 *
 * Se baja con la sesión, igual que el resto de la API, y no con un <img> que
 * apunte al backend: así anda aunque la API viva en otro dominio. `version`
 * cambia cuando se reemplaza el logo, para que se vea el nuevo.
 */
function useLogoDelCuit(cuitId, version) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!cuitId || !version) { setUrl(null); return undefined; }
    let vivo = true;
    let creada = null;
    fetchCuitLogo(cuitId)
      .then((blob) => {
        if (!vivo) return;
        creada = URL.createObjectURL(blob);
        setUrl(creada);
      })
      .catch(() => { if (vivo) setUrl(null); });
    return () => {
      vivo = false;
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [cuitId, version]);
  return url;
}

const versionDe = (cuit) => (cuit?.tieneLogo ? cuit.logoActualizadoEn || "1" : null);

/* El logo chico, en la tarjeta del CUIT. */
export function LogoMiniatura({ cuit }) {
  const url = useLogoDelCuit(cuit.id, versionDe(cuit));
  if (!cuit.tieneLogo) return "—";
  if (!url) return <span className="text-ink-500">cargando…</span>;
  return <img src={url} alt={`Logo de ${cuit.nombre}`} className="inline-block h-5 max-w-[120px] object-contain align-middle" />;
}

/*
 * Subir, reemplazar y quitar el logo de un CUIT que ya existe.
 *
 * Se guarda apenas se elige el archivo, sin esperar al "Guardar cambios" del
 * formulario: son dos pedidos distintos, y atar uno al otro dejaría casos a
 * medias (datos guardados y logo no, o al revés). Lo que se ve en la vista
 * previa es lo que guardó el servidor, no el archivo elegido: el PNG se
 * rearma al guardarlo.
 *
 * La caja de la vista previa tiene la proporción del espacio del logo en la
 * factura (unos 9 × 1,6 cm), para que se vea cómo va a entrar.
 */
export function LogoEditor({ cuit, onCambio }) {
  const [estado, setEstado] = useState({ tieneLogo: !!cuit.tieneLogo, version: versionDe(cuit) });
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const input = useRef(null);
  const url = useLogoDelCuit(cuit.id, estado.version);

  useEffect(() => {
    setEstado({ tieneLogo: !!cuit.tieneLogo, version: versionDe(cuit) });
    setError("");
    setAviso("");
    // Sólo al cambiar de CUIT: el resto lo lleva este componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuit.id]);

  async function elegir(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // para poder volver a elegir el mismo archivo después de un error
    if (!file) return;
    setError("");
    setAviso("");
    const problema = await problemaDelArchivo(file);
    if (problema) return setError(problema);
    setTrabajando(true);
    try {
      const actualizado = await uploadCuitLogo(cuit.id, file);
      setAviso(estado.tieneLogo ? "Logo reemplazado." : "Logo guardado. Ya sale en las facturas de este CUIT.");
      setEstado({ tieneLogo: true, version: versionDe(actualizado) || String(Date.now()) });
      onCambio?.(actualizado);
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo subir el logo. Volvé a intentar.");
    } finally {
      setTrabajando(false);
    }
  }

  async function quitar() {
    if (!confirm("¿Quitar el logo? Las facturas de este CUIT van a llevar el nombre del negocio en su lugar.")) return;
    setError("");
    setAviso("");
    setTrabajando(true);
    try {
      const actualizado = await deleteCuitLogo(cuit.id);
      setEstado({ tieneLogo: false, version: null });
      setAviso("Logo quitado. Las facturas llevan el nombre del negocio.");
      onCambio?.(actualizado);
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo quitar el logo. Volvé a intentar.");
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div>
      <p className="label">Logo para la factura</p>
      <div className="flex aspect-[57/10] w-full items-center justify-center rounded-md border border-dashed border-line bg-white p-2">
        {estado.tieneLogo && url ? (
          <img src={url} alt={`Logo de ${cuit.nombre}`} className="h-full w-full object-contain" />
        ) : (
          <span className="px-2 text-center text-xs text-ink-500">
            {estado.tieneLogo ? "Cargando…" : "Sin logo: la factura lleva el nombre del negocio."}
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-brick-500" role="alert">{error}</p>}
      {aviso && <p className="mt-1 text-xs text-teal-600">{aviso}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          aria-label="Elegir la imagen del logo"
          onChange={elegir}
        />
        <button type="button" className="btn-ghost px-2 py-1.5 text-xs" onClick={() => input.current?.click()} disabled={trabajando}>
          {estado.tieneLogo ? <RefreshCw size={13} /> : <ImagePlus size={13} />}
          {trabajando ? "Guardando…" : estado.tieneLogo ? "Reemplazar" : "Subir logo"}
        </button>
        {estado.tieneLogo && (
          <button type="button" className="btn-ghost px-2 py-1.5 text-xs" onClick={quitar} disabled={trabajando}>
            <Trash2 size={13} /> Quitar
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-500">
        PNG (mejor con fondo transparente) o JPG, hasta {LOGO_MAX_KB} KB y {LOGO_MAX_LADO} píxeles por lado. Va arriba a la
        izquierda de la factura; un logo horizontal se ve más grande. Se guarda apenas lo elegís.
      </p>
    </div>
  );
}
