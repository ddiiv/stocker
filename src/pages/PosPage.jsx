import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  ScanLine, Camera, Trash2, Plus, Minus, XCircle, ShoppingCart,
  Receipt, Loader2, UserCircle2, UserPlus, NotebookPen,
} from "lucide-react";
import { scanProduct } from "../services/productService";
import { createSale, printSaleTicket } from "../services/salesService";
import { fetchEmployees, fetchLocalesDeVenta } from "../services/employeeService";
import { fetchClients } from "../services/clientService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { camaraDisponible } from "../components/scanner/CameraScanner";
import ScannerVentaCamara from "../components/scanner/ScannerVentaCamara";
import { formatCurrency } from "../utils/formatters";
import { esMayorista as evaluarMayorista, describir as describirRegla } from "../utils/reglaMayorista";
import { PageHeader, Card } from "../components/ui/Layout";
import { useAuth } from "../context/AuthContext";
import { esAdministradorTotal } from "../utils/permissions";
import PaymentSplit, { lineasParaApi, calcularTotales } from "../components/sales/PaymentSplit";
import AvisoCredito from "../components/sales/AvisoCredito";
import ModalStockFaltante from "../components/sales/ModalStockFaltante";
import ClienteRapidoModal from "../components/clients/ClienteRapidoModal";
import { leerCarrito, guardarCarrito, borrarCarrito, LATIDO_MS } from "../utils/carritoPos";

export default function PosPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // El dueño elige vendedor y local; el empleado vende siempre como él mismo
  // y en su local. El backend lo impone igual, esto sólo evita mostrar
  // controles que no van a tener efecto.
  const puedeElegirVendedor = esAdministradorTotal(user);

  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [metodos, setMetodos] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  /*
   * El buscador de clientes pregunta al servidor, no filtra en memoria.
   *
   * Antes se traía el padrón COMPLETO al montar la pantalla y se filtraba acá.
   * Con cuarenta clientes no se nota; con veinte mil son varios megabytes de
   * JSON que el servidor arma, la red mueve y la máquina del mostrador retiene
   * — cada vez que alguien entra al punto de venta, que ahora es a cada rato
   * porque el carrito sobrevive a la navegación.
   *
   * Y era gasto puro: la lista no se muestra hasta escribir dos letras, así
   * que ese padrón entero no se usaba para nada hasta que había una búsqueda.
   *
   * `clientes` pasa a ser el resultado de la última búsqueda, nada más.
   */
  const [clientes, setClientes] = useState([]);
  const [buscandoClientes, setBuscandoClientes] = useState(false);
  /*
   * El cliente elegido se guarda entero, no por id.
   *
   * Su nombre y su cuenta corriente se muestran en pantalla, y si sólo se
   * guardara el id habría que ir a buscarlo a una lista que ya no está
   * completa. Son trescientos bytes.
   */
  const [clienteSel, setClienteSel] = useState(null);
  const [buscarCliente, setBuscarCliente] = useState("");
  const clientId = clienteSel?.id || "";
  // "contado" se cobra ahora; "cuenta_corriente" se fía y se cobra después.
  const [condicionPago, setCondicionPago] = useState("contado");
  // Fiar no obliga a entregar: se puede dejar la mercadería señada en el local.
  const [seLoLleva, setSeLoLleva] = useState(true);
  const [cobrando, setCobrando] = useState(false);
  const [ultimaVenta, setUltimaVenta] = useState(null);
  const [faltaTurno, setFaltaTurno] = useState(false);
  /*
   * Lo que el servidor dijo que falta.
   *
   * Se guarda tal cual vino y no se recalcula acá: el servidor mira el stock
   * con la fila trabada, y es el único que sabe lo que va a haber cuando
   * escriba. La pantalla puede tener un número viejo de hace treinta segundos.
   */
  const [faltantesServidor, setFaltantesServidor] = useState(null);
  // Lo que hubo que dar de alta, para avisarlo en la pantalla de venta cerrada.
  const [altaStock, setAltaStock] = useState(null);
  // Aviso de que el carrito se recuperó de la vez anterior.
  const [avisoCarrito, setAvisoCarrito] = useState(null);
  // Alta de cliente sin salir del cobro. Va montado acá adentro a propósito:
  // navegar a Clientes desmonta el punto de venta y arranca el reloj del carrito.
  const [altaCliente, setAltaCliente] = useState(false);
  const [resaltado, setResaltado] = useState(null);
  const inputRef = useRef(null);

  /*
   * Escanear con la cámara del teléfono.
   *
   * El mostrador tiene lector USB, pero el resto del negocio no: una feria, un
   * local chico, o el día que el lector se rompe. Se resuelve con lo que
   * siempre hay a mano, que es un teléfono, y es el mismo escaneo que ya se usa
   * para stock.
   *
   * `escaneando` frena la cámara mientras la lectura anterior está yendo al
   * servidor: sin eso, apuntar tres segundos a la misma etiqueta encola varios
   * pedidos y las unidades entran desordenadas.
   */
  const [camaraAbierta, setCamaraAbierta] = useState(false);
  const [escaneando, setEscaneando] = useState(false);
  const hayCamara = camaraDisponible();
  const resaltadoTimer = useRef(null);

  useEffect(() => () => clearTimeout(resaltadoTimer.current), []);

  useEffect(() => {
    // Un empleado no tiene permiso de ver el padrón de empleados ni la lista
    // de locales para elegir, así que esas dos sólo se piden si va a usarlas.
    if (puedeElegirVendedor) {
      fetchEmployees().then(setEmployees).catch(() => {});
      fetchLocalesDeVenta().then((ls) => {
        setLocations(ls);
        // Un solo local no es una decisión: se elige solo y el dueño no tiene
        // que tocar un desplegable de una sola opción en cada venta.
        if (ls.length === 1) setLocationId(String(ls[0].id));
      }).catch(() => {});
    }
    fetchPaymentMethods({ soloActivos: true })
      .then((m) => {
        setMetodos(m);
        // Arranca con una sola línea: el medio por defecto cubre todo.
        if (m.length) setPagos([{ paymentMethodId: m[0].id, monto: 0, ajusteManual: "" }]);
      })
      .catch(() => {});
    inputRef.current?.focus();
  }, [puedeElegirVendedor]);

  /*
   * De qué local sale la mercadería.
   *
   * El dueño lo elige; el empleado tiene el suyo. Es el que decide qué stock
   * mirar: el total del negocio no sirve, porque las unidades pueden estar en
   * la otra sucursal.
   */
  const localEfectivo = puedeElegirVendedor ? locationId : (user?.local?.id || "");

  // Cambiar de local cambia el stock disponible de todo lo que ya está en el
  // carrito, así que hay que volver a preguntarlo.
  useEffect(() => {
    if (!localEfectivo || items.length === 0) return;
    let cancelado = false;
    (async () => {
      const frescos = await Promise.all(items.map(async (i) => {
        try {
          const p = await scanProduct(i.sku, localEfectivo);
          return { ...i, stock: p.stock, enLocal: p.enLocal };
        } catch { return i; }
      }));
      if (!cancelado) setItems(frescos);
    })();
    return () => { cancelado = true; };
    // Sólo al cambiar de local: agregar `items` volvería a pedir todo en cada
    // escaneo, que ya trae su propio stock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localEfectivo]);

  /*
   * ── El carrito, entre pantallas ──────────────────────────────────
   *
   * Esta página se desmonta entera al ir a otra sección, así que el carrito se
   * guarda afuera (ver utils/carritoPos). Acá sólo se decide QUÉ se guarda y
   * CUÁNDO.
   *
   * Qué: las líneas y las decisiones que ya tomó la persona —cliente,
   * condición, si se la lleva, local y vendedor—. Los medios de pago NO: son
   * importes a medio repartir contra un total que puede haber cambiado, y
   * restaurarlos daría una suma que no cuadra sin que se entienda por qué.
   */
  const carritoActual = useCallback(() => ({
    items, clienteSel, condicionPago, seLoLleva,
    locationId, employeeId,
  }), [items, clienteSel, condicionPago, seLoLleva, locationId, employeeId]);

  // Guardado inicial: sólo después de restaurar, para no pisar lo guardado con
  // el carrito vacío del primer render.
  const restaurado = useRef(false);

  useEffect(() => {
    const guardado = leerCarrito(user);
    restaurado.current = true;
    if (!guardado) return;

    const c = guardado.carrito;
    setItems(c.items || []);
    /*
     * Se restaura el cliente entero. Antes se guardaba sólo el id y el nombre
     * salía de la lista completa; sin esa lista, el carrito recuperado
     * mostraría "Cliente" a secas.
     */
    setClienteSel(c.clienteSel || null);
    setCondicionPago(c.condicionPago || "contado");
    setSeLoLleva(c.seLoLleva !== false);
    if (c.locationId) setLocationId(c.locationId);
    if (c.employeeId) setEmployeeId(c.employeeId);
    setAvisoCarrito({ minutos: guardado.minutos, revisando: true });

    /*
     * Lo guardado se vuelve a preguntar antes de mostrarlo como bueno.
     *
     * Entre que se guardó y ahora pudo haberse vendido en otra caja o
     * cambiado un precio. Mostrar el precio de hace cuatro minutos y cobrar
     * otro es la clase de diferencia que el cliente descubre en el ticket.
     */
    const local = c.locationId || user?.local?.id || null;
    (async () => {
      const frescos = await Promise.all((c.items || []).map(async (i) => {
        try {
          const fresco = await scanProduct(i.sku, local);
          return { ...i, ...fresco, cantidad: i.cantidad, _precioViejo: i.precioMinorista };
        } catch {
          return i;
        }
      }));
      const cambiaron = frescos.filter(
        (i) => i._precioViejo !== undefined && Number(i._precioViejo) !== Number(i.precioMinorista),
      );
      setItems(frescos.map(({ _precioViejo, ...i }) => i));
      setAvisoCarrito({ minutos: guardado.minutos, revisando: false, cambiaron: cambiaron.length });
    })();
    // Sólo al montar: restaurar es una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cada cambio se guarda, y guardar además corre el reloj de los 5 minutos.
  useEffect(() => {
    if (!restaurado.current) return;
    if (items.length) guardarCarrito(user, carritoActual());
    else borrarCarrito();
  }, [user, carritoActual, items.length]);

  /*
   * El latido, y el guardado al salir.
   *
   * El latido dice "la pantalla sigue abierta": sin él, un carrito con el POS
   * a la vista se vencería a los cinco minutos de la última prenda escaneada.
   * El guardado del `return` marca el momento exacto en que se sale, que es
   * cuando arranca de verdad la cuenta.
   */
  useEffect(() => {
    if (!items.length) return undefined;
    const id = setInterval(() => guardarCarrito(user, carritoActual()), LATIDO_MS);
    return () => {
      clearInterval(id);
      guardarCarrito(user, carritoActual());
    };
  }, [user, carritoActual, items.length]);

  function vaciarCarrito() {
    setItems([]);
    setFaltantesServidor(null);
    setAvisoCarrito(null);
    borrarCarrito();
  }

  /*
   * Se pregunta al dejar de escribir, no en cada tecla.
   *
   * Dos letras es el mismo umbral con el que ya se mostraba la lista: no
   * cambia lo que ve la cajera, sólo de dónde salen los nombres.
   */
  useEffect(() => {
    const q = buscarCliente.trim();
    if (q.length < 2) { setClientes([]); return undefined; }
    let vigente = true;
    setBuscandoClientes(true);
    const id = setTimeout(() => {
      fetchClients(q, { limit: 8 })
        .then((c) => { if (vigente) setClientes(c.data || c); })
        .catch(() => { if (vigente) setClientes([]); })
        .finally(() => { if (vigente) setBuscandoClientes(false); });
    }, 300);
    return () => { vigente = false; clearTimeout(id); };
  }, [buscarCliente]);

  const totalUnidades = items.reduce((s, i) => s + i.cantidad, 0);

  /*
   * Mayorista o minorista, según la regla DEL LOCAL.
   *
   * Antes era `>= 3` escrito acá, otra vez en Nueva venta y una tercera en el
   * servidor. Tres copias sin saber una de otra: cambiar una hacía que la
   * pantalla mostrara un precio y la caja cobrara otro. Ahora la regla vive en
   * el local y la evalúa la misma función que usa el servidor.
   *
   * El umbral por monto se mide EN LISTA —el precio depende del total y el
   * total del precio— así que primero se suma todo a minorista.
   */
  const localRegla = locations.find((l) => String(l.id) === String(localEfectivo)) || null;
  const totalEnLista = items.reduce((s, i) => s + (Number(i.precioMinorista) || 0) * i.cantidad, 0);
  const esMayorista = evaluarMayorista(localRegla, totalUnidades, totalEnLista);
  const precioDe = (i) => (esMayorista ? i.precioMayorista : i.precioMinorista);
  const total = items.reduce((s, i) => s + precioDe(i) * i.cantidad, 0);

  const esFiado = condicionPago === "cuenta_corriente";
  const clienteElegido = clienteSel;

  // El backend rechaza el cobro si los importes no suman el total. Chequearlo
  // acá evita mandar una venta que ya se sabe que va a fallar.
  const sumaPagos = pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  const pagosCuadran = pagos.length === 1 || Math.abs(total - sumaPagos) < 0.02;
  // Fiando no hay medios de pago que cuadrar todavía, pero sí hace falta un
  // cliente: sin saber quién debe, la deuda no existe.
  /*
   * El dueño necesita haber elegido local; el empleado, tenerlo asignado.
   *
   * Es de dónde sale la mercadería: sin eso el backend rechaza la venta, y es
   * mejor que el botón no se habilite a que el rechazo llegue con el carrito
   * cargado y el cliente esperando.
   */
  const hayLocal = puedeElegirVendedor ? Boolean(locationId) : Boolean(user?.local?.id);

  /*
   * Líneas sin stock en este local.
   *
   * `enLocal` puede venir en null (todavía no se preguntó, o no hay local
   * elegido): eso no es "sin stock", es "no se sabe", y no tiene que disparar
   * la cotización.
   */
  const faltantes = items.filter(
    (i) => i.enLocal !== null && i.enLocal !== undefined && i.cantidad > Number(i.enLocal)
  );
  /*
   * Faltar stock ya no cambia lo que se está haciendo.
   *
   * Antes, si faltaba, la operación se convertía sola en cotización: la venta
   * no se cobraba y quedaba un presupuesto para convertir más tarde. Eso se
   * terminó — el POS sólo hace ventas. Cuando falta, se pregunta si dar de
   * alta la diferencia, y esa pregunta la dispara el servidor, no esta cuenta.
   *
   * `faltantes` sigue existiendo pero sólo para pintar el aviso en la línea:
   * es una ayuda visual, no una decisión.
   */
  const puedeCobrar = items.length > 0 && !cobrando && hayLocal
    && (esFiado ? Boolean(clientId) : (metodos.length > 0 && pagosCuadran));

  // El botón muestra lo que hay que pedirle al cliente, recargo incluido.
  // Fiando no se cobra nada ahora: lo que se anota es el neto de mercadería.
  const { totalCobro } = calcularTotales(pagos, metodos, total);
  const totalBoton = esFiado ? total : totalCobro;

  async function procesarCodigo(codigo) {
    setError("");
    setEscaneando(true);
    try {
      const p = await scanProduct(codigo, localEfectivo || null);
      setItems((prev) => {
        const existente = prev.find((i) => i.id === p.id);
        if (existente) {
          // Producto repetido: sumamos una unidad en vez de duplicar la línea.
          return prev.map((i) => (i.id === p.id ? { ...i, cantidad: i.cantidad + 1 } : i));
        }
        return [...prev, { ...p, cantidad: 1 }];
      });
      // Escaneando rápido no se alcanza a leer la tabla: resaltar la línea que
      // acaba de cambiar es lo que permite confirmar que sumó al producto
      // correcto y no creó una línea nueva.
      setResaltado(p.id);
      clearTimeout(resaltadoTimer.current);
      resaltadoTimer.current = setTimeout(() => setResaltado(null), 1200);
      beep(880, 70);
    } catch (e) {
      setError(e.response?.data?.message || `No se encontró el código ${codigo}`);
      beep(220, 200);
    } finally {
      setEscaneando(false);
    }
  }

  // Siempre activo salvo mientras se está cobrando, para que un escaneo
  // accidental no altere una venta que ya se está registrando.
  /*
   * El teclado deja de escucharse con la cámara abierta: los dos lectores
   * apuntan a la misma función y una lectura entraría dos veces.
   */
  const { scannerActivo, lecturas } = useBarcodeScanner({
    onScan: procesarCodigo, activo: !cobrando && !camaraAbierta,
  });

  function submitManual(e) {
    e.preventDefault();
    const codigo = inputRef.current?.value?.trim();
    if (!codigo) return;
    procesarCodigo(codigo);
    inputRef.current.value = "";
  }

  function cambiarCantidad(id, delta) {
    setItems((prev) => prev
      .map((i) => (i.id === id ? { ...i, cantidad: i.cantidad + delta } : i))
      .filter((i) => i.cantidad > 0));
  }

  function quitar(id) { setItems((prev) => prev.filter((i) => i.id !== id)); }

  /*
   * Registrar la venta.
   *
   * `confirmarAltaStock` viaja sólo cuando la persona ya vio el modal y dijo
   * que sí. El servidor no hace nada con las cantidades que mandemos: recalcula
   * él lo que falta con las filas trabadas y da de alta esa diferencia. Acá
   * viaja un sí, y nada más.
   */
  async function cobrar({ confirmarAltaStock = false } = {}) {
    if (!items.length) return;
    setCobrando(true); setError("");
    try {
      const venta = await createSale({
        tipo: "venta",
        confirmarAltaStock,
        fecha: new Date().toISOString().slice(0, 10),
        // Sin cliente elegido la venta es a consumidor final. Fiando el
        // backend la rechaza, porque la deuda necesita dueño.
        clientId: clientId ? Number(clientId) : null,
        locationId: locationId || null,
        employeeId: employeeId || null,
        condicionPago,
        ...(esFiado
          ? { descontarStock: seLoLleva }
          : { estado: "pagado", pagos: lineasParaApi(pagos, metodos, total) }),
        items: items.map((i) => ({ productVariantId: i.id, cantidad: i.cantidad })),
      });
      setUltimaVenta(venta);
      // Lo que hubo que dar de alta. Se muestra en la pantalla de venta
      // cerrada: es el único momento en que la persona lo va a leer.
      setAltaStock(venta.altaStock || null);
      setFaltantesServidor(null);
      setItems([]);
      setClienteSel(null);
      setBuscarCliente("");
      setCondicionPago("contado");
      setSeLoLleva(true);
      setAvisoCarrito(null);
      // El carrito se resolvió: lo guardado ya no sirve para nada.
      borrarCarrito();
      if (metodos.length) setPagos([{ paymentMethodId: metodos[0].id, monto: 0, ajusteManual: "" }]);
      inputRef.current?.focus();
    } catch (e) {
      const msg = e.response?.data?.message || "No se pudo registrar la venta";
      // Sin turno abierto el backend responde 409: se ofrece el atajo para
      // abrirlo en vez de dejar al cajero adivinando qué falta.
      setFaltaTurno(e.response?.status === 409 && /turno de caja/i.test(msg));
      /*
       * Falta stock declarado.
       *
       * En vez de dejar el error en rojo y a la cajera sin salida, se abre el
       * modal con la lista y la pregunta. El carrito no se toca: si dice que
       * no, sigue todo como estaba.
       *
       * Se abre sólo si el servidor mandó la lista. Un SIN_STOCK sin faltantes
       * sería un contrato roto, y mostrar un modal vacío es peor que el error.
       */
      const d = e.response?.data;
      if (d?.codigo === "SIN_STOCK" && d.faltantes?.length) {
        setFaltantesServidor({
          faltantes: d.faltantes,
          puedeConfirmar: d.puedeConfirmar !== false,
          local: d.local || null,
        });
        setError("");
      } else {
        setError(msg);
      }
    } finally {
      setCobrando(false);
    }
  }

  // ── Pantalla de venta cerrada ───────────────────────────────────
  if (ultimaVenta) {
    const ventaFiada = ultimaVenta.condicionPago === "cuenta_corriente";
    return (
      <div>
        <PageHeader
          title={ventaFiada ? "Venta fiada" : "Venta registrada"}
          subtitle={`Comprobante ${ultimaVenta.numero}`}
        />
        <Card className="mx-auto max-w-md text-center">
          {/* Lo cobrado, no el neto: con recargo son importes distintos y el
              cajero necesita ver el que le pidió al cliente. Fiando no entró
              nada, así que se muestra lo que quedó anotado como deuda. */}
          <p className={`font-display text-4xl font-semibold ${ventaFiada ? "text-brass-700" : "text-teal-600"}`}>
            {formatCurrency(ventaFiada ? ultimaVenta.total : (ultimaVenta.totalCobrado || ultimaVenta.total))}
          </p>
          {ventaFiada ? (
            <p className="mt-1 text-sm text-ink-600">
              Queda en la cuenta de {ultimaVenta.cliente?.nombre} {ultimaVenta.cliente?.apellido || ""}.
              El medio de pago se elige al cobrarla.
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-600">{ultimaVenta.medioPago}</p>
          )}
          {Number(ultimaVenta.recargoPagos) !== 0 && (
            <p className="mt-1 text-xs text-ink-500">
              Mercadería {formatCurrency(ultimaVenta.total)}
              {Number(ultimaVenta.recargoPagos) > 0 ? " + recargo " : " − descuento "}
              {formatCurrency(Math.abs(Number(ultimaVenta.recargoPagos)))}
            </p>
          )}
          {/* Lo que se dio de alta al confirmar. Se muestra acá y no antes
              porque es el resultado, no una advertencia: el stock ya entró y
              ya salió con la venta. Sirve para que quede claro qué se tocó. */}
          {altaStock && (
            <div className="mt-4 rounded-md border border-brass-300 bg-brass-50 px-3 py-2 text-left text-xs text-brass-800">
              <p className="font-medium">{altaStock.mensaje}</p>
              <ul className="mt-1 space-y-0.5">
                {(altaStock.altas || []).map((a) => (
                  <li key={a.sku}>
                    <span className="font-mono">{a.sku}</span> — se dieron de alta {a.unidades}
                  </li>
                ))}
              </ul>
              <Link to="/stock/movimientos" className="mt-1 inline-block font-medium underline">
                Ver el movimiento en el libro de stock
              </Link>
            </div>
          )}

          <div className="mt-6 flex flex-col gap-2">
            <button className="btn-accent justify-center" onClick={() => printSaleTicket(ultimaVenta)}>
              <Receipt size={15} /> Imprimir ticket
            </button>
            <button className="btn-ghost justify-center" onClick={() => { setUltimaVenta(null); inputRef.current?.focus(); }}>
              <ScanLine size={15} /> Nueva venta
            </button>
            <button className="btn-ghost justify-center text-xs" onClick={() => navigate(`/ventas/${encodeURIComponent(ultimaVenta.numero)}`)}>
              Ver detalle de la venta
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Punto de venta" subtitle="Escaneá los productos y cobrá" />

      {/* Que el carrito reaparezca sin decir nada es peor que perderlo: la
          cajera no sabe si es de ella, de hace un minuto o de hace una hora, y
          termina cobrando algo que no armó. */}
      {avisoCarrito && items.length > 0 && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-line bg-paper-50 px-3 py-2 text-xs text-ink-600">
          <p>
            Recuperamos el carrito que tenías armado
            {avisoCarrito.minutos > 0 ? ` hace ${avisoCarrito.minutos} minuto${avisoCarrito.minutos === 1 ? "" : "s"}` : " recién"}.
            {avisoCarrito.revisando
              ? " Revisando precios y stock…"
              : avisoCarrito.cambiaron > 0
                ? ` Ojo: ${avisoCarrito.cambiaron} ${avisoCarrito.cambiaron === 1 ? "producto cambió" : "productos cambiaron"} de precio y ya está actualizado.`
                : " Precios y stock al día."}
          </p>
          <button type="button" className="shrink-0 font-medium underline" onClick={() => setAvisoCarrito(null)}>
            Ok
          </button>
        </div>
      )}

      {/*
        * La pregunta por el stock que falta.
        *
        * La abre el servidor, no esta pantalla: acá el stock que se ve puede
        * ser de hace medio minuto. Cancelar no toca el carrito — la salida
        * natural es ir a contar y volver.
        */}
      {/*
        * Alta de cliente, sin moverse de acá.
        *
        * El carrito no se toca: este modal se monta dentro del punto de venta,
        * así que no hay desmontaje ni navegación. Al guardar, el cliente queda
        * elegido en la venta que se está cobrando.
        */}
      <ClienteRapidoModal
        open={altaCliente}
        onClose={() => setAltaCliente(false)}
        onCreado={(c) => {
          setClienteSel(c);
          setBuscarCliente("");
        }}
      />

      <ModalStockFaltante
        open={Boolean(faltantesServidor)}
        onClose={() => setFaltantesServidor(null)}
        faltantes={faltantesServidor?.faltantes || []}
        puedeConfirmar={faltantesServidor?.puedeConfirmar !== false}
        local={faltantesServidor?.local}
        confirmando={cobrando}
        accion={esFiado ? "fiar" : "cobrar"}
        onConfirmar={() => cobrar({ confirmarAltaStock: true })}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Carrito */}
        <div className="lg:col-span-2">
          <Card className="mb-4">
            <form onSubmit={submitManual}>
              <div className={`flex items-center gap-2 rounded-md border-2 border-dashed px-3 py-3 transition-colors ${
                scannerActivo ? "border-teal-400 bg-teal-50" : "border-line bg-paper-100/60"
              }`}>
                {/* Late sólo cuando hay lecturas reales: un ícono animado
                    permanente no distingue "funciona" de "no hay lector". */}
                <ScanLine size={20} className={`shrink-0 ${scannerActivo ? "animate-pulse text-teal-600" : "text-ink-400"}`} />
                <input
                  ref={inputRef}
                  data-scanner="true"
                  className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-ink-400"
                  placeholder="Escaneá un producto o escribí el código…"
                  autoComplete="off"
                />
                {lecturas > 0 && (
                  <span className="shrink-0 text-xs tabular-nums text-ink-500">{lecturas} lect.</span>
                )}
                {/*
                  * Sólo si el navegador puede abrir la cámara. Un botón que al
                  * tocarlo avisa que no se puede es peor que no tenerlo: en el
                  * mostrador se toca igual y se pierde el tiempo ahí.
                  *
                  * `type="button"` porque está adentro del formulario del
                  * código: sin eso, tocarlo lo envía y busca el código vacío.
                  */}
                {hayCamara && (
                  <button
                    type="button"
                    onClick={() => setCamaraAbierta(true)}
                    className="btn-ghost shrink-0 gap-1.5 px-2.5 py-1.5 text-xs"
                    title="Escanear con la cámara del teléfono"
                  >
                    <Camera size={15} />
                    <span className="hidden sm:inline">Cámara</span>
                  </button>
                )}
              </div>
            </form>
            {error && (
              <div className="mt-2 text-sm text-brick-500">
                <p className="flex items-center gap-1.5"><XCircle size={14} /> {error}</p>
                {faltaTurno && (
                  <Link to="/caja" className="ml-5 mt-1 inline-block font-medium underline">
                    Abrir mi turno de caja
                  </Link>
                )}
              </div>
            )}
          </Card>

          <Card className="p-0">
            {items.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <ShoppingCart size={32} className="mx-auto text-ink-300" />
                <p className="mt-3 text-sm text-ink-600">Escaneá el primer producto para empezar.</p>
              </div>
            ) : (
              <div className="max-h-[440px] overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((i) => (
                      <tr
                        key={i.id}
                        className={`border-b border-line last:border-0 transition-colors ${
                          resaltado === i.id ? "bg-teal-50" : ""
                        }`}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-ink-900">
                            {i.titulo}
                            {/* Un artículo de evento se cobra a otro precio y no
                                descuenta stock: decirlo en la línea evita que
                                alguien lo confunda con el del local. */}
                            {i.esFeria && (
                              <span className="ml-1 rounded bg-brass-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brass-800">
                                Evento
                              </span>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-500">
                            <span className="tag-chip">{i.sku}</span>
                            {[i.variante1Valor, i.variante2Valor].filter(Boolean).length > 0 && (
                              <span className="ml-1">{[i.variante1Valor, i.variante2Valor].filter(Boolean).join(" · ")}</span>
                            )}
                            {/* El stock del local, que es de donde sale: el total
                                del negocio haría creer que hay unidades acá. */}
                            {i.enLocal !== null && i.enLocal !== undefined && i.cantidad > Number(i.enLocal) && (
                              <span className="ml-2 text-brick-500">
                                Sin stock acá: {i.enLocal}
                                {Number(i.stock) > Number(i.enLocal) ? ` · ${i.stock} en otros locales` : ""}
                              </span>
                            )}
                          </p>
                        </td>
                        <td className="px-2 py-3 text-right text-xs text-ink-600 whitespace-nowrap">
                          {formatCurrency(precioDe(i))} c/u
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button className="btn-ghost px-1.5 py-1" onClick={() => cambiarCantidad(i.id, -1)}><Minus size={13} /></button>
                            <span className="w-8 text-center font-display font-semibold">{i.cantidad}</span>
                            <button className="btn-ghost px-1.5 py-1" onClick={() => cambiarCantidad(i.id, 1)}><Plus size={13} /></button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-display font-semibold text-ink-900 whitespace-nowrap">
                          {formatCurrency(precioDe(i) * i.cantidad)}
                        </td>
                        <td className="px-2 py-3">
                          <button className="btn-ghost px-1.5 py-1 text-brick-500" onClick={() => quitar(i.id)}><Trash2 size={13} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Totales y cobro */}
        <div className="space-y-4">
          <Card>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-600">{totalUnidades} {totalUnidades === 1 ? "unidad" : "unidades"}</span>
              {/* La regla vive en el local y cambia entre sucursales, así que
                  el cartel dice cuál se está aplicando. Sin eso, el cajero ve
                  que el precio cambió y no sabe si está bien. */}
              {esMayorista
                ? (
                  <span className="rounded bg-brass-50 px-2 py-0.5 text-xs font-medium text-brass-700"
                    title={describirRegla(localRegla)}>
                    Precio mayorista
                  </span>
                )
                : localRegla && (
                  <span className="text-xs text-ink-500">{describirRegla(localRegla)}</span>
                )}
            </div>
            <p className="mt-2 font-display text-4xl font-semibold text-ink-950">{formatCurrency(total)}</p>
          </Card>

          <Card>
            <label className="label">Condición</label>
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-md bg-paper-100 p-1">
              {[
                { valor: "contado", texto: "Cobra ahora" },
                { valor: "cuenta_corriente", texto: "Fiado" },
              ].map((op) => (
                <button
                  key={op.valor}
                  type="button"
                  onClick={() => setCondicionPago(op.valor)}
                  className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                    condicionPago === op.valor
                      ? "bg-paper-50 text-ink-950 shadow-sm"
                      : "text-ink-600 hover:text-ink-900"
                  }`}
                >
                  {op.texto}
                </button>
              ))}
            </div>

            {/*
              Fiando no se elige medio de pago: todavía no se sabe con qué va a
              pagar el cliente. Se elige al cobrar la venta, con las mismas
              combinaciones y recargos de siempre.
            */}
            {esFiado ? (
              <div className="space-y-3">
                <AvisoCredito cliente={clienteElegido} monto={total} />

                <label className="flex items-start gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox" className="mt-0.5"
                    checked={seLoLleva}
                    onChange={(e) => setSeLoLleva(e.target.checked)}
                  />
                  <span>
                    Se lleva la mercadería ahora
                    <span className="block text-xs text-ink-500">
                      Descuenta el stock al registrar la venta. Destildalo si queda
                      señada en el local: el stock sale recién al cobrarla.
                    </span>
                  </span>
                </label>

                <p className="flex items-start gap-1.5 text-xs text-ink-500">
                  <NotebookPen size={13} className="mt-0.5 shrink-0" />
                  El medio de pago se elige al cobrarla, desde el detalle de la venta
                  o desde la cuenta corriente del cliente.
                </p>
              </div>
            ) : metodos.length === 0 ? (
              <p className="text-xs text-ink-500">
                No hay medios de pago cargados. Pedile al dueño que configure al menos uno.
              </p>
            ) : (
              <PaymentSplit metodos={metodos} total={total} lineas={pagos} onChange={setPagos} />
            )}
          </Card>

          <Card className={esFiado && !clientId ? "border-brick-300" : ""}>
            <label className="label">
              Cliente {esFiado && <span className="text-brick-500">· obligatorio para fiar</span>}
            </label>
            {clientId ? (
              <div className="flex items-center justify-between rounded-md border border-line bg-paper-100 px-3 py-2">
                <span className="text-sm text-ink-900">
                  {`${clienteSel?.nombre || ""} ${clienteSel?.apellido || ""}`.trim() || "Cliente"}
                </span>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setClienteSel(null); setBuscarCliente(""); }}>
                  Quitar
                </button>
              </div>
            ) : (
              <>
                <input
                  className="input"
                  placeholder="Buscar cliente por nombre…"
                  value={buscarCliente}
                  onChange={(e) => setBuscarCliente(e.target.value)}
                />
                {buscarCliente.trim().length >= 2 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-line">
                    {clientes.map((c) => (
                      <button
                        key={c.id} type="button"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-paper-100"
                        onClick={() => { setClienteSel(c); setBuscarCliente(""); }}
                      >
                        {c.nombre} {c.apellido || ""}
                      </button>
                    ))}
                    {/* Buscar y no encontrar es JUSTO el momento de ofrecer
                        darlo de alta: es cuando el cajero ya sabe que no está.
                        Se distingue de "todavía estoy buscando", que si dijera
                        lo mismo haría dar de alta un cliente que ya existe. */}
                    {clientes.length === 0 && (
                      <p className="px-3 py-2 text-xs text-ink-500">
                        {buscandoClientes ? "Buscando…" : "No hay ningún cliente con ese nombre."}
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  className="btn-ghost mt-2 w-full justify-center border border-dashed border-line text-xs"
                  onClick={() => setAltaCliente(true)}
                >
                  <UserPlus size={13} /> Registrar un cliente nuevo
                </button>

                <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">
                  <UserCircle2 size={13} />
                  {esFiado
                    ? "No se puede fiar sin saber quién debe."
                    : "Sin elegir cliente se registra como consumidor final."}
                </p>
              </>
            )}
          </Card>

          {/* El empleado vende siempre como él mismo y en su local: el backend
              ignora lo que llegue en el request, así que no se muestran los
              desplegables para no sugerir una elección que no existe. */}
          {puedeElegirVendedor ? (
            <Card>
              <label className="label">Vendedor</label>
              <select className="input mb-3" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Sin asignar</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.nombre} {e.apellido || ""}</option>)}
              </select>
              {/* El local no es opcional: es de dónde sale la mercadería. Sin
                  elegirlo el stock se descontaría de otro local y quedarían dos
                  inventarios mal. Con un solo local se elige solo. */}
              <label className="label">Local <span className="text-brick-500">*</span></label>
              <select className={`input ${!locationId ? "border-brick-500" : ""}`}
                value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">Elegí el local…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
              {!locationId && (
                <p className="mt-1 text-xs text-brick-500">El stock se descuenta de este local.</p>
              )}
            </Card>
          ) : (
            <Card className="bg-paper-100">
              <p className="text-xs uppercase tracking-wide text-ink-600">Vendedor</p>
              <p className="font-medium text-ink-900">{user?.nombre} {user?.apellido || ""}</p>
              {user?.local?.nombre ? (
                <>
                  <p className="mt-2 text-xs uppercase tracking-wide text-ink-600">Local</p>
                  <p className="font-medium text-ink-900">{user.local.nombre}</p>
                  <p className="mt-2 text-xs text-ink-500">
                    Se registran automáticamente con tu sesión. El stock sale de este local.
                  </p>
                </>
              ) : (
                // Sin local asignado el backend rechaza la venta; conviene
                // avisarlo acá y no cuando ya cargó todo el carrito.
                <p className="mt-2 rounded-md bg-brick-50 px-2 py-1.5 text-xs text-brick-600">
                  No tenés un local asignado, así que no vas a poder vender.
                  Pedile al dueño que te asigne uno desde Empleados.
                </p>
              )}
            </Card>
          )}

          {/* Aviso, no freno: la venta se puede cobrar igual y al hacerlo el
              servidor va a preguntar si dar de alta la diferencia. Decirlo
              antes evita que el modal aparezca de la nada. */}
          {faltantes.length > 0 && items.length > 0 && (
            <div className="rounded-md border border-brass-300 bg-brass-50 px-3 py-2 text-xs text-brass-800">
              <p className="font-medium">Falta stock cargado de {faltantes.map((i) => i.sku).join(", ")}.</p>
              <p className="mt-1">
                Al cobrar se te va a preguntar si querés darlo de alta. La venta no se frena.
              </p>
            </div>
          )}

          <button
            className="btn-accent w-full justify-center py-3 text-base"
            disabled={!puedeCobrar}
            onClick={() => cobrar()}
          >
            {cobrando
              ? <><Loader2 size={16} className="animate-spin" /> Registrando…</>
              : esFiado
                ? <><NotebookPen size={16} /> Fiar {formatCurrency(totalBoton)}</>
                : <>Cobrar {formatCurrency(totalBoton)}</>}
          </button>
          {items.length > 0 && (
            <button className="btn-ghost w-full justify-center text-xs text-brick-500" onClick={vaciarCarrito}>
              Vaciar carrito
            </button>
          )}
        </div>
      </div>

      {/*
        * Se monta sólo cuando está abierta, y no oculta con CSS: la cámara del
        * teléfono se apaga al desmontarse el componente. Escondida seguiría
        * prendida, con su luz y su consumo, y el empleado creyendo que la
        * cerró.
        */}
      {camaraAbierta && (
        <ScannerVentaCamara
          onScan={procesarCodigo}
          onCerrar={() => setCamaraAbierta(false)}
          items={items}
          onCantidad={cambiarCantidad}
          precioDe={precioDe}
          formatCurrency={formatCurrency}
          total={total}
          error={error}
          procesando={escaneando}
          resaltado={resaltado}
        />
      )}
    </div>
  );
}

function beep(frecuencia, duracionMs) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = frecuencia;
    gain.gain.value = 0.08;
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, duracionMs);
  } catch { /* audio bloqueado, no es crítico */ }
}
