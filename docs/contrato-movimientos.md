# Contrato de movimientos hacia Stocker — v1

> **Para los agentes de la tienda minorista (`isu`), Pedidos Mayoristas, Mercado Libre, Jumpseller
> y cualquier plataforma nueva.** Lo publica Stocker, que es el único que mueve stock y registra
> dinero. Responde los cuatro puntos que pedía `REDIS-COMPARTIDO.md` § «Antes de programar».
>
> **Versión del contrato: 1.** Va en cada mensaje (`contrato: 1`). Si algún día cambia de forma
> incompatible, sube a 2 y Stocker acepta las dos durante la transición.

---

## 0. Lo primero: no hay una cola común en la base 0

`REDIS-COMPARTIDO.md` pedía «el nombre exacto de la cola». La respuesta honesta es que **no hay
ninguna, y Stocker no va a consumir una**. El transporte de los movimientos es **HTTP a Stocker con
la credencial de la plataforma**, que es lo que ya funciona hoy. Dos razones, las dos duras:

**1. Una cola compartida pierde el aislamiento entre negocios.** Stocker es multi-negocio. Hoy el
`businessId` **no sale nunca del cuerpo del mensaje**: sale de la credencial, que está hasheada en
`integraciones_externas`, es una por negocio y por origen, y se revoca sola desde la pantalla. Una
cola en la base 0 tiene una sola contraseña para todas las plataformas: cualquiera que pueda escribir
ahí podría encolar un movimiento diciendo que es de otro negocio, y Stocker no tendría con qué
desmentirlo. Eso no es una mejora de transporte, es sacar la autorización del medio.

**2. Dos caminos para el mismo movimiento es como se descuenta dos veces.** La regla 5 de
`REDIS-COMPARTIDO.md` dice —y tiene razón— que el canal que puede reservar al vender lo sigue
haciendo. La ruta de la tienda es ésa: entra por HTTP y Stocker aparta el stock en el momento, en
orden de llegada. Si además publicara el mismo movimiento en una cola, el segundo camino no agrega
nada y sí agrega el riesgo de que las dos claves de idempotencia no coincidan por un guion.

Dos precisiones que una auditoría de este documento corrigió, porque la versión anterior decía de más:
**el portal mayorista no aparta nada** —deja una solicitud que una persona acepta o rechaza, y puede
aceptarse sin stock (§ 3.1)—, y **la tienda todavía no entra**: su cliente no habla este contrato
(§ 6). Así que hoy el argumento del doble camino vale para la ruta, no para un tráfico que ya exista.
No cambia la conclusión, porque la razón 1 sola alcanza, pero quien lea esto tiene que saber qué está
andando y qué no.

**Lo que sí hace falta, y es lo que este documento define, es que los cinco tipos de movimiento
tengan UNA forma igual para todos los canales.** Eso era el valor real de la propuesta y acá está.

**Redis sigue siendo útil, en el lugar donde ya está:** cada plataforma mantiene **su propia cola, en
su propia base, con su prefijo** (la tienda: base 1, prefijo `isu`), y su worker toma los trabajos y
llama a estas rutas. Es exactamente lo que `isu` hace hoy. La cola es el reintento de la plataforma,
no el camino de entrada de Stocker. Todas las reglas de `REDIS-COMPARTIDO.md` § 1 y § 2 valen igual.

**Lo único que cambia respecto de hoy: nada.** Ninguna plataforma tiene que tocar su integración por
este contrato. Lo que estaba andando sigue andando.

---

## 1. Cómo se entra

Toda ruta de acá va bajo `requireIntegracion('<origen>')`:

```
POST https://<stocker>/api/integraciones/<origen>/...
Authorization: Bearer <el token de la credencial>
Content-Type: application/json
```

- El token se emite en Stocker (pantalla **Integraciones**) o en el backoffice. Se muestra **una sola
  vez** y se guarda hasheado: si se pierde, se emite otro y el anterior deja de servir.
- Orígenes válidos hoy: `isuwaya` (Pedidos Mayoristas), `tienda` (minorista `isu`). Mercado Libre y
  Jumpseller no usan credencial porque hoy **Stocker los va a buscar**, no al revés (§ 6).
- **El negocio sale de la credencial.** Si el cuerpo trae un `businessId`, se ignora.

---

## 2. El sobre del mensaje

Igual para los cinco tipos:

```json
{
  "contrato": 1,
  "tipo": "venta",
  "id": "isu:ISU-1042",
  "ocurrioEn": "2026-10-02T14:31:05.000Z",
  "datos": { }
}
```

| Campo | Qué es |
|---|---|
| `contrato` | `1`. Si falta, Stocker asume 1. |
| `tipo` | `venta` · `cancelacion` · `devolucion` · `compra` · `cobro` |
| `id` | **El id del movimiento**: `<plataforma>:<su número>` — `ml:2000123456`, `isu:ISU-1042`, `may:P-311`. **El tope de 60 caracteres es del número de pedido, no del `id` entero**: el prefijo se saca antes de medir, así que `ml:` + 60 entra. Un `id` sin prefijo también entra y se usa tal cual. |
| `ocurrioEn` | Cuándo pasó **en la plataforma**, ISO 8601 con zona. No cuándo se mandó. Hoy Stocker lo acepta pero **no lo guarda**: la fecha que queda es la de recepción. Mandalo igual, para cuando se use. |
| `datos` | Lo propio del tipo (§ 3). |

**El `id` es la idempotencia, y es lo único que la garantiza.**

- Fijo y único: el mismo movimiento reenviado lleva **el mismo `id`**, siempre, para siempre.
- Si llega dos veces, Stocker lo procesa **una sola vez** y en la segunda contesta `200` con el
  estado que ya tenía. Nunca descuenta dos veces.
- Esto lo sostiene un **índice único en la base** sobre (negocio, plataforma, número de pedido), no
  sólo una consulta previa: dos reintentos que entran en el mismo instante no se ven entre sí, y el
  que pierde recibe `200` «ya lo tenía». Antes de la auditoría esta garantía era una carrera.
- No lo armes con la hora, un azar ni un contador del reintento: eso rompe la idempotencia justo en
  el caso que la necesita.
- **El prefijo se corta en el primer `:`**, y lo de atrás viaja entero. `ml:2000:123` es el pedido
  `2000:123` de Mercado Libre. Cortar en el último uniría dos pedidos distintos bajo la misma clave.
- Un `contrato` que este Stocker no entiende se **rechaza con 400**, no se interpreta. Un `tipo` que
  no es el de la ruta también: una devolución entrando por la ruta de ventas descontaría stock en
  lugar de devolverlo.
- La plataforma manda **cantidades**; Stocker calcula el stock. No mandes stock ya calculado.

> **Compatibilidad:** las rutas que ya existen (§ 3.1, § 3.2) aceptan **las dos formas**: el cuerpo
> plano de `datos` en la raíz, con el que la tienda y el portal mayorista ya integraron, y el sobre.
> Las dos caen en **la misma clave de idempotencia**, así que el mismo pedido mandado de las dos
> maneras es un solo pedido y se descuenta una sola vez (está probado: `scripts/test-tienda.cjs`).
> El sobre es la forma recomendada de acá en adelante; quien ya integró no tiene que cambiar nada.

---

## 3. Los cinco tipos

### 3.1 `venta` — existe hoy ✅

```
POST /api/integraciones/tienda/pedidos          (minorista)
POST /api/integraciones/isuwaya/pedidos         (mayorista: va a revisión del dueño)
```

```json
{
  "pedidoExterno": "ISU-1042",
  "items": [{ "sku": "REM-NEG-M", "cantidad": 2, "precioUnitario": 18000 }],
  "comprador": { "nombre": "…", "documento": "20123456789", "email": "…" },
  "total": 36000
}
```

- `pedidoExterno` es el `id` sin el prefijo de plataforma. Hasta 60 caracteres, obligatorio.
- Topes por pedido: **200 líneas**, **10.000 unidades por línea**. Existen para que un webhook mal
  armado no deje la transacción abierta trabando el stock mientras el mostrador espera.
- `precioUnitario` es informativo: el precio que manda es el de Stocker (§ 5).
- **Minorista:** aparta el stock en el momento, en orden de llegada.
  **Mayorista:** queda como solicitud a aceptar o rechazar; puede aceptarse sin stock (stock
  fantasma) y el dueño decide si cobra o deja a cobrar.

### 3.2 `cancelacion` — existe hoy ✅

```
POST /api/integraciones/tienda/pedidos/:pedidoExterno/cancelar
{ "motivo": "El cliente canceló" }
```

Libera la reserva. Nombra la venta por **su** número de pedido, no por el id interno de Stocker.
Una cancelación que llega antes que su venta devuelve `404`: reintentala; cuando la venta esté, entra.

### 3.3 `devolucion` — **no existe todavía** ❌

Hoy la devolución se hace **dentro de Stocker**: `POST /invoices/:id/nota-credito`, que emite la nota
en ARCA y, según lo que elija quien la hace, devuelve el stock, saca el dinero de la caja del turno
abierto y baja la deuda de la cuenta corriente. Esos efectos son decisiones de quien atiende, no de
la plataforma, y por eso no hay una ruta externa que los dispare sola.

Forma prevista cuando se construya:

```
POST /api/integraciones/<origen>/devoluciones
{ "contrato": 1, "tipo": "devolucion", "id": "isu:ISU-1042-D1",
  "datos": { "ventaId": "isu:ISU-1042",
             "items": [{ "sku": "REM-NEG-M", "cantidad": 1 }],
             "motivo": "Talle equivocado" } }
```

`ventaId` es obligatorio: **una devolución nombra la venta original.** Si llega antes que la venta,
Stocker la guarda y la aplica después. La devolución **no** emite la nota de crédito sola: deja el
movimiento para que el dueño lo confirme, porque la nota quema un CAE y eso no se deshace.

### 3.4 `compra` — **no corresponde a una plataforma de venta** ⛔

La compra es mercadería que entra: la carga el negocio en Stocker, con su proveedor, su remito y su
costo. Ninguna de las plataformas de venta la genera, y no hay ruta externa ni se planea una. Si lo
que hace falta es dar de alta mercadería desde otro lado, eso es un tema aparte y se habla antes de
escribirlo.

### 3.5 `cobro` — **parcial** ⚠️

Hoy el dinero de la venta online entra **con la venta** (campo `total`). No hay ruta para un cobro
como movimiento propio.

Forma prevista cuando se construya:

```
POST /api/integraciones/<origen>/cobros
{ "contrato": 1, "tipo": "cobro", "id": "isu:ISU-1042-C1",
  "datos": { "ventaId": "isu:ISU-1042", "importe": 36000,
             "medio": "mercadopago", "operacion": "1234567890" } }
```

`operacion` es el número de la pasarela: es lo que permite conciliar contra el resumen y lo que hace
que un reintento del webhook de pago no cobre dos veces.

---

## 4. Qué pasa si no hay stock o el SKU no existe

Esto es lo que más importa acertar, porque los dos casos **no son el mismo** y confundirlos esconde
ventas:

| Caso | Estado | HTTP | Qué hace Stocker |
|---|---|---|---|
| Entró bien, todo apartado | `aceptado` | `201` | Descuenta todo. |
| **El SKU no existe en Stocker** | `parcial` | `201` | Aparta lo que sí conoce y **deja escrito qué SKU no estaba**. No es un rechazo: la venta ocurrió, y no descontar lo conocido haría la diferencia de inventario más grande. |
| Un SKU es de producto de feria | `parcial` | `201` | Lo avisa. Significa que se publicó online un SKU de evento, que no lleva stock. |
| **No alcanza el stock** | `rechazado` | `409` | **No descuenta nada**, ni la parte que alcanzaba. Medio pedido descontado deja a quien vende sin saber qué salió. |
| Ya lo tenía | el que tuviera | `200` | Nada. Contesta el estado anterior. |
| Cuerpo inválido (sin SKU, cantidad no entera, pasa los topes) | — | `400` | Nada. El mensaje dice qué línea y por qué. |
| `contrato` que no entendemos | — | `400` | Nada. No lo interpreta con otra versión. |
| `tipo` que no es el de la ruta | — | `400` | Nada. Es el error más caro: se corta acá. |
| Credencial que no sirve | — | `401` | Nada. No distingue «no existe» de «revocada». |
| **Lo tengo pero no lo resolví** | `pendiente` | `202` | **Nada apartado todavía.** Pasa si el procesamiento no llegó a correr. No lo reenvíes como si se hubiera perdido: ya está guardado y Stocker lo resuelve solo (como máximo 15 minutos después). Lo que NO podés es decirle al cliente que está reservado. |
| **Demasiados pedidos seguidos** | — | `429` | Nada. Ver abajo: este es el único que hay que reintentar con espera creciente. |

> **Esta tabla es de la ruta de la tienda** (`/integraciones/tienda/pedidos`). La del portal
> mayorista (`/integraciones/isuwaya/pedidos`) **no da 409 nunca**: ahí el pedido no se resuelve
> contra el stock sino contra una persona, así que contesta 201 la primera vez, 200 el reenvío, y el
> resultado se pregunta después por resoluciones (§ 5 b).

```json
{ "pedidoExterno": "ISU-1042", "estado": "parcial",
  "motivo": "No están en Stocker: REM-XXX-M.", "repetido": false }
```

- **`motivo` es texto para una persona, no un código.** Lo lee alguien mirando la lista y necesita
  saber qué prenda faltó. Mostralo tal cual; no lo parsees.
- **Reintentá sobre cualquier cosa que no sea 2xx.** Un `409` sí: el stock puede volver. Un `400` no
  tiene sentido reintentarlo sin arreglar el cuerpo primero.
- **El `429` se reintenta con espera creciente, nunca al toque.** Stocker tiene dos límites por IP:
  **60 pedidos cada 2 segundos** y **600 por minuto**, y los comparte todo lo que salga de tu
  servicio. El caso donde esto aparece es el que más importa: tu worker vaciando una cola de
  doscientos pedidos después de que Stocker estuvo caído por un deploy. Si en el `429` reintentás sin
  esperar, te quedás afuera solo. Esperá 1s, 2s, 4s, 8s (hasta un techo de un minuto) y **no mandes
  más de ~10 por segundo sostenidos**. Los pedidos no se pierden: están en tu base hasta que Stocker
  conteste 2xx.
- `parcial` **no** es un error. Si tu plataforma lo trata como fallo y reintenta, el `200` del segundo
  intento te va a decir que ya estaba.

---

## 5. Cómo se entera cada plataforma del resultado

Tres caminos, y cada uno existe por una razón distinta:

**a) En el momento, por el código HTTP.** Para la venta y la cancelación alcanza: la respuesta ya
trae `estado` y `motivo`. Es lo que usa la tienda al cobrar.

**b) Preguntando, para lo que se resuelve después.** El pedido mayorista lo acepta o lo rechaza una
persona, horas más tarde:

```
GET /api/integraciones/isuwaya/pedidos/resoluciones?desde=<cursor>&limite=100
```

Devuelve los aceptados —con el número de venta de Stocker— y los rechazados con su motivo, más el
cursor para la próxima vuelta. **Pregunta la plataforma en vez de avisar Stocker** porque la
plataforma ya tiene reloj y reintentos escritos, y porque si se cae no se pierde nada: cuando vuelve,
pregunta desde donde quedó. Un webhook perdido, en cambio, se pierde callado.

**c) El aviso de stock, para refrescar la vidriera.** Cada movimiento de stock emite, dentro de la
transacción que lo hizo:

```
NOTIFY stock_cambio, '<businessId>:<variantId>'
```

Llega al `commit`; un `rollback` se lo lleva, así que no avisa cambios que no pasaron. Es **sólo un
aviso para invalidar caché**: la cantidad se pregunta siempre a Stocker.

«Cada movimiento» incluye **apartar y liberar una reserva**, y eso hay que decirlo porque hasta la
auditoría no era cierto: lo publicable es `stock - reservado`, así que un pedido online que aparta una
prenda cambia lo que la vidriera tiene que decir sin tocar `stock`. Mercado Libre se enteraba de eso y
la tienda no, que es justo el canal que mira este aviso.

```
GET /api/integraciones/tienda/catalogo          — todo, con precios y publicable
GET /api/integraciones/tienda/stock?skus=A,B,C  — lo del carrito
```

El `stock` devuelve `desconocidos` aparte: **un SKU que Stocker no conoce no vuelve como 0.** Cero
significa «no queda»; desconocido significa «no existe», y mostrar «sin stock» cuando el SKU está mal
escondería el error para siempre.

**Los precios mandan desde Stocker,** por SKU de variante: `precioMinorista` y `precioMayorista`,
cada uno con su nombre. Nunca un `precio` a secas: en la ruta del portal mayorista `precio` ya
significa el mayorista, y dos rutas con el mismo campo diciendo cosas distintas se descubre cobrando
mal. **La plataforma no guarda el precio ni el stock como dato propio.**

---

## 6. Cómo está cada canal hoy

| Canal | venta | cancelación | devolución | compra | cobro |
|---|---|---|---|---|---|
| Tienda `isu` | ⚠️ la ruta está, **el cliente de la tienda no entra todavía** | ⚠️ ídem | ❌ | ⛔ | hoy viaja con la venta |
| Pedidos Mayoristas | ✅ HTTP, a revisión — **no aparta stock** | desde la pantalla de Stocker | ❌ | ⛔ | en Stocker |
| Mercado Libre | Stocker los va a buscar | — | en Stocker | ⛔ | en Stocker |
| Jumpseller | Stocker los va a buscar | — | en Stocker | ⛔ | en Stocker |

**Lo que le falta a la tienda para entrar.** La ruta de Stocker está y probada; el cliente de `isu`
no coincide con ella en cinco puntos, y mientras siga así **todo checkout termina en un 400**:

1. Manda el número de pedido en `pedido` y esta ruta lo lee en `pedidoExterno` (§ 3.1). Es el que
   corta: `encolar` rechaza antes de tocar la base.
2. Valida la respuesta con un esquema que pide `id`, `pagoPendiente`, `estadoEnvio`, `despachadoEn`,
   `canceladoEn` y `faltantes`; esta ruta devuelve `{ pedidoExterno, estado, motivo, repetido }`.
3. Manda `pagoPendiente`, `pagoDetalle` y `envio`, y **esta ruta los ignora**: el tipo de envío y el
   corte del día no llegan, así que el pedido entraría invisible para Envíos del Día.
4. Llama a `/pedidos/:n`, `/pedidos/:n/pagado`, `/pedidos/:n/envio` y `/clientes`, que no existen.
5. Lee el catálogo y el stock con otros nombres (`generado`, `precio`, `cantidad`) que los que esta
   ruta devuelve (`generadoEn`, `precioMinorista`/`precioMayorista`, § 5).

Arreglar sólo el punto 1 sería peor que no arreglar nada: el pedido entraría y el envío se perdería
callado. Van los cinco juntos, y después se saca el ⚠️ de la tabla.

**Mercado Libre y Jumpseller son el caso donde una cola sí tendría sentido**, y vale decirlo: la
venta pasa del lado de ellos y Stocker se entera cuando importa pedidos o cuando corre el barrido de
15 minutos. Ahí una cola cambiaría una espera por un aviso. Pero el que publicaría en esa cola es el
servicio de integración, que **corre adentro del backend de Stocker** (mismo proceso, base 0, prefijo
propio): es Stocker hablándose a sí mismo, no un bus entre plataformas, y no cambia nada de § 0.

---

## 7. Lo que ninguna plataforma hace

- **No toca el stock.** Ni lo calcula, ni lo guarda como dato propio, ni lo corrige.
- **No decide el precio.**
- **No emite comprobantes fiscales.** La factura y la nota de crédito las emite Stocker contra ARCA,
  y una nota quema un CAE que no se deshace.
- **No manda el `businessId`.** Sale de la credencial.
- **No pierde un movimiento por un reintento.** Vive en la base de la plataforma hasta que Stocker
  contesta 2xx. Redis es el mensajero, no el registro.
