import { useEffect, useState } from "react";
import { Boxes, Plus, Trash2, Pencil, AlertTriangle, X } from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import SelectorArticulos from "../components/deposito/SelectorArticulos";
import { fetchPacks, crearPack, guardarPack, desarmarPack } from "../services/packService";
import { formatCurrency } from "../utils/formatters";
import { mensajeDeError } from "../utils/errores";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";

/*
 * Packs (combos).
 *
 * Un pack se vende como un artículo: tiene SKU propio, precio propio y se
 * publica en Mercado Libre como uno más. Pero no tiene stock propio. Adentro
 * lleva prendas que ya están en el estante, contadas una sola vez, y cuando el
 * pack se vende salen esas prendas.
 *
 * Toda la pantalla gira alrededor de esa idea, porque es la que se malentiende:
 * acá no se carga stock de packs. Se dice de qué está hecho, y cuántos hay sale
 * de la cuenta —lo que alcance para el componente más escaso—.
 *
 * Por eso "Se arman" no es un campo editable en ningún lado y el número aparece
 * siempre junto al detalle de por qué: con 7 remeras y un pack de 3, se arman 2
 * y sobra 1. Sin ese detalle, "2" parece un stock que alguien cargó mal.
 */
export default function PacksPage() {
  const { user } = useAuth();
  const puedeEditar = canEdit(user, "stock");

  const [packs, setPacks] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [editando, setEditando] = useState(null);   // variantId, o "nuevo"

  async function cargar() {
    setCargando(true); setError("");
    try {
      setPacks(await fetchPacks());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudieron cargar los packs."));
    }
    setCargando(false);
  }
  useEffect(() => { cargar(); }, []);

  async function desarmar(p) {
    const ok = window.confirm(
      `¿Desarmar “${p.titulo}” (${p.sku})?\n\n`
      + "Deja de descontar stock de sus componentes y vuelve a ser una variante común. "
      + "Si está publicado en Mercado Libre, esa publicación queda con el stock que tenga hoy "
      + "hasta que la revises.",
    );
    if (!ok) return;
    try {
      await desarmarPack(p.variantId);
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo desarmar el pack."));
    }
  }

  return (
    <div>
      <PageHeader
        title="Packs"
        subtitle="Combos con SKU propio. No llevan stock: se arman con lo que haya de sus componentes."
        actions={puedeEditar && (
          <button className="btn-primary" onClick={() => setEditando("nuevo")}>
            <Plus size={16} /> Nuevo pack
          </button>
        )}
      />
      <StockTabs />

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-brick-200 bg-brick-50 px-3 py-2 text-sm text-brick-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {editando && (
        <EditorPack
          pack={editando === "nuevo" ? null : packs.find((p) => p.variantId === editando)}
          onCerrar={() => setEditando(null)}
          onGuardado={async () => { setEditando(null); await cargar(); }}
        />
      )}

      <div className="mt-4 space-y-3">
        {cargando && <p className="text-sm text-ink-500">Cargando…</p>}

        {!cargando && packs.length === 0 && (
          <EmptyState
            icon={Boxes}
            title="Todavía no hay packs"
            description="Un pack junta varias prendas bajo un SKU nuevo. Al venderlo, el stock sale de las prendas que lleva adentro, no del pack."
            action={puedeEditar && (
              <button className="btn-primary" onClick={() => setEditando("nuevo")}>
                <Plus size={16} /> Crear el primero
              </button>
            )}
          />
        )}

        {!cargando && packs.map((p) => (
          <FilaPack
            key={p.variantId}
            pack={p}
            puedeEditar={puedeEditar}
            onEditar={() => setEditando(p.variantId)}
            onDesarmar={() => desarmar(p)}
          />
        ))}
      </div>
    </div>
  );
}

function FilaPack({ pack, puedeEditar, onEditar, onDesarmar }) {
  /*
   * Un componente desactivado deja el pack en cero sin que se note en ningún
   * otro lado: la publicación baja a cero y desde acá parecería falta de stock.
   * Se dice con todas las letras.
   */
  const caidos = (pack.componentes || []).filter((c) => c.activo === false);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-semibold text-ink-900">{pack.titulo}</p>
          <p className="mt-0.5 text-xs text-ink-500">
            <span className="font-mono">{pack.sku}</span>
            {pack.etiqueta ? ` · ${pack.etiqueta}` : ""}
            {" · "}{formatCurrency(pack.precioMinorista)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="font-display text-xl font-semibold text-ink-950">{pack.armables}</p>
            <p className="text-[11px] uppercase tracking-wide text-ink-500">se arman</p>
          </div>
          {puedeEditar && (
            <>
              <button className="btn-ghost px-2 py-1" onClick={onEditar} title="Cambiar la composición">
                <Pencil size={15} />
              </button>
              <button className="btn-ghost px-2 py-1 text-brick-500" onClick={onDesarmar} title="Desarmar">
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <p className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-500">Lleva adentro</p>
        <ul className="space-y-1 text-sm">
          {(pack.componentes || []).map((c) => (
            <li key={c.componenteVariantId} className="flex items-center gap-2">
              <span className="font-display font-semibold text-ink-900">{c.cantidad}×</span>
              <span className="text-ink-800">{c.titulo}</span>
              {c.etiqueta && <span className="text-ink-500">{c.etiqueta}</span>}
              <span className="font-mono text-xs text-ink-500">{c.sku}</span>
              {c.activo === false && (
                <span className="rounded bg-brick-100 px-1.5 py-0.5 text-[11px] text-brick-700">
                  desactivado
                </span>
              )}
            </li>
          ))}
        </ul>

        {caidos.length > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-brick-700">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Mientras siga desactivado no se puede armar ninguno, aunque haya stock del resto.
          </p>
        )}

        {/*
          * Dónde se arman importa: un pack se arma en UN local. Si las prendas
          * están repartidas entre dos sucursales no hay pack, aunque la suma
          * alcance, y sin este desglose ese cero no se entiende.
          */}
        {pack.porLocal?.length > 0 ? (
          <p className="mt-2 text-xs text-ink-500">
            {pack.porLocal.map((l) => `${l.local}: ${l.armables}`).join(" · ")}
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-500">
            No se arma ninguno: en ningún local alcanza para completarlo. Un pack se arma
            entero en un mismo local, no se junta entre sucursales.
          </p>
        )}
      </div>
    </Card>
  );
}

/*
 * Alta y edición.
 *
 * El alta manda todo junto —producto, variante y composición— en una sola
 * llamada: si se hiciera en pasos y fallara el último, quedaría un producto
 * vacío en el listado de stock que nadie sabría de dónde salió.
 */
function EditorPack({ pack, onCerrar, onGuardado }) {
  const esNuevo = !pack;
  const [sku, setSku] = useState(pack?.sku || "");
  const [titulo, setTitulo] = useState(pack?.titulo || "");
  const [precio, setPrecio] = useState(pack?.precioMinorista ?? "");
  const [items, setItems] = useState(
    (pack?.componentes || []).map((c) => ({
      productVariantId: c.componenteVariantId,
      sku: c.sku,
      titulo: c.titulo,
      variante: c.etiqueta,
      cantidad: c.cantidad,
    })),
  );
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const unidades = items.reduce((s, i) => s + (Number(i.cantidad) || 0), 0);
  const validos = items.filter((i) => Number(i.cantidad) > 0);

  async function guardar() {
    setError("");
    if (validos.length === 0) {
      setError("Un pack tiene que llevar al menos un artículo con cantidad mayor a cero.");
      return;
    }
    setGuardando(true);
    try {
      const componentes = validos.map((i) => ({
        componenteVariantId: i.productVariantId,
        cantidad: Number(i.cantidad),
      }));
      if (esNuevo) {
        await crearPack({
          sku: sku.trim(), titulo: titulo.trim(),
          precioMinorista: Number(precio), componentes,
        });
      } else {
        await guardarPack(pack.variantId, componentes);
      }
      await onGuardado();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo guardar el pack."));
    }
    setGuardando(false);
  }

  return (
    <Card className="mt-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-base font-semibold text-ink-900">
            {esNuevo ? "Nuevo pack" : `Composición de ${pack.titulo}`}
          </p>
          <p className="mt-0.5 text-sm text-ink-600">
            {esNuevo
              ? "El pack va en su propio producto: no se cuelga de uno existente, porque sus variantes son colores y talles y un pack no tiene ninguno de los dos."
              : "Se reemplaza entera. Lo que quede acá es lo que se descuenta en cada venta."}
          </p>
        </div>
        <button className="btn-ghost px-2 py-1" onClick={onCerrar}><X size={16} /></button>
      </div>

      {esNuevo && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-700">SKU del pack</span>
            <input className="input font-mono" value={sku} maxLength={100}
              onChange={(e) => setSku(e.target.value)} placeholder="PACK-BABYTEE-3" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-700">Nombre</span>
            <input className="input" value={titulo} maxLength={120}
              onChange={(e) => setTitulo(e.target.value)} placeholder="Pack x3 Baby Tee" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-700">Precio de venta</span>
            <input className="input" type="number" min="0" step="0.01" value={precio}
              onChange={(e) => setPrecio(e.target.value)} placeholder="21000" />
          </label>
        </div>
      )}

      <p className="mb-1.5 text-xs font-medium text-ink-700">Qué lleva adentro</p>
      {/*
        * `sinPacks` saca del buscador los packs ya armados: un pack adentro de
        * otro se rechaza igual del lado del servidor, y ofrecerlo para después
        * rebotarlo es hacerle perder el viaje a quien está cargando.
        */}
      <SelectorArticulos
        items={items}
        onChange={setItems}
        etiquetaCantidad="Por pack"
        params={{ sinPacks: 1 }}
      />

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-sm text-brick-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />{error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-xs text-ink-600">
          {unidades > 0
            ? <>Cada pack saca <strong className="text-ink-900">{unidades}</strong> unidad{unidades === 1 ? "" : "es"} del estante.</>
            : "Todavía no lleva nada."}
        </p>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onCerrar} disabled={guardando}>Cancelar</button>
          <button className="btn-primary" onClick={guardar} disabled={guardando}>
            {guardando ? "Guardando…" : esNuevo ? "Crear pack" : "Guardar composición"}
          </button>
        </div>
      </div>
    </Card>
  );
}
