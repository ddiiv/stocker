# Deploy en Railway

Cuatro servicios en el mismo proyecto y environment:

| Servicio | Carpeta | Dominio público | Arranque |
|---|---|---|---|
| `backend` | `back/stocker` | **no** | `node index.js` |
| `app` | `front/stocker` | sí | `npm start` |
| `backoffice` | `front/backoffice` | sí | `npm start` |
| `landing` | `front/landing` | sí | `npm start` |

El backend **no lleva dominio público**. Los tres frontends le hablan por la red
privada (`backend.railway.internal`) y hacen de proxy en `/api`. Así el único
camino a la API pasa por un servicio propio, y las cookies de sesión comparten
origen con quien las usa — que es lo que permite `SameSite=Strict` sin
excepciones.

La red privada de Railway resuelve sólo por IPv6, y su DNS interno tarda unos
segundos en levantar cuando arranca un contenedor. Por eso el backend escucha en
`::` y los proxies reintentan.

---

## Variables del backend

### Obligatorias

```bash
NODE_ENV=production
JWT_SECRET=                  # 64+ caracteres aleatorios. Rotarlo cierra todas las sesiones.
DATABASE_URL=                # la que inyecta el Postgres de Railway
```

### Dominios — de acá sale el CORS

```bash
FRONTEND_DOMAIN=app.tudominio.com
BACKOFFICE_DOMAIN=admin.tudominio.com
LANDING_DOMAIN=tudominio.com
```

Son **exactos**. Antes se aceptaba cualquier subdominio de `railway.app` y
`vercel.app` por patrón, o sea que cualquiera que levantara un sitio ahí podía
hacerle pedidos con credenciales a esta API. Ya no: lo que no está en estas
variables no entra.

### Cuántos proxies hay delante

```bash
TRUST_PROXY_HOPS=2
```

**Ponelo antes que `BACKOFFICE_IPS`, o la lista te deja afuera.**

Express usa este número para elegir cuál de las direcciones de `X-Forwarded-For`
es el cliente: descarta las N de la derecha y toma la siguiente. El armado de
este proyecto tiene dos saltos —edge de Railway → servicio del front → backend—
así que **2** es el valor correcto.

**Nunca pongas `true` ni un número más alto que la cantidad real de proxies.**
Cualquiera puede mandar un `X-Forwarded-For` inventado; el edge le agrega la IP
verdadera detrás. Con el número exacto, la dirección falsa queda a la izquierda
de la real y se descarta sola. Con un número alto, se la lee a ella. Medido
sobre la cadena `1.2.3.4(falsa), 152.233.23.193(real), 100.64.0.7(edge)`:

| `trust proxy` | `req.ip` | Resultado |
|---|---|---|
| 1 | `100.64.0.7` | lee un proxy — la lista nunca coincide |
| **2** | `152.233.23.193` | **correcto** |
| 3 | `1.2.3.4` | ✖ lee lo que inventó el atacante |
| `true` | `1.2.3.4` | ✖ lee lo que inventó el atacante |

Equivocarse **para abajo** rompe cosas pero no abre nada: la lista de IPs no
coincide y todos los usuarios comparten un contador de límites. Equivocarse
**para arriba** deja saltear la lista y los límites con una cabecera inventada.
Por eso el código recorta cualquier valor mayor a 4 y lo avisa en el arranque:
un tipeo no puede convertir la cabecera del cliente en la fuente de la verdad.

Lo que hace que esto sea seguro de entrada es que **el backend no tiene dominio
público**. Sólo lo alcanzan los servicios del front por la red privada, así que
los saltos de la derecha —los que se descartan— son siempre los nuestros.

Para comprobarlo, desde tu navegador:

```
https://TU-BACKOFFICE/api/mi-ip
```

Si devuelve tu IP pública, el número está bien. Si devuelve algo que empieza en
`fd`, `10.`, `100.64.` o `192.168.`, está leyendo un salto interno: subí el
número. El backend además lo avisa en los logs cuando rechaza una IP que parece
interna, porque desde afuera eso se ve igual que "mi IP no está autorizada" y se
pierde mucho tiempo ahí.

### Acceso al backoffice

```bash
BACKOFFICE_IPS=2800:2141:e000::/48
```

Direcciones sueltas o CIDR, separadas por coma, IPv4 e IPv6.

**Sin esta variable el panel queda abierto a internet.** Se eligió así para no
dejar a nadie afuera de su propio panel en el primer deploy, pero el arranque lo
grita en los logs y la pantalla de Seguridad lo muestra en rojo.

Para saber qué IP cargar, abrí `https://TU-BACKOFFICE/api/mi-ip` desde el
navegador con el que vas a entrar.

**Cargá un prefijo, no una dirección suelta.** Una IPv6 doméstica completa
(`/128`) cambia cada vez que el router renegocia, y cada cambio te deja afuera.
El prefijo que te asigna el proveedor es estable: de
`2800:2141:e000:88f:8118:6819:ae53:3b89` conviene cargar
`2800:2141:e000::/48`, que cubre todo el bloque.

**Si navegás con VPN, esto no sirve como está.** Un nodo de salida de VPN es un
pool compartido: la dirección rota entre visitas, y el prefijo que la abarca
abarca también a todos los demás clientes de esa VPN. Allowlistear ese rango no
es "sólo yo", son miles de desconocidos. Para saber si te está pasando, mirá el
reverse DNS de la IP que te devuelve `/api/mi-ip`: si resuelve a un proveedor de
hosting o CDN en vez de a tu ISP, estás saliendo por una VPN.

Tres salidas, de mejor a peor:

1. Apagá la VPN para entrar al panel y allowlisteá la IP real de tu conexión.
2. Si querés seguir con VPN, conseguí una IP dedicada y allowlisteá ésa.
3. Dejá `BACKOFFICE_IPS` vacía y apoyate en el segundo factor y el bloqueo por
   intentos. Es una capa menos, pero es honesto: mejor eso que una lista que
   parece cerrada y deja pasar a un pool entero.

Aun sin VPN, una IP doméstica se puede mover. Si se te corta el acceso, es lo
primero a revisar — y es la razón de que el segundo factor siga siendo
obligatorio: la IP es una capa, no la única.

`/api/mi-ip` además te dice si la IP con la que estás entrando pasaría la lista
actual, así podés verificar el valor antes de quedarte afuera.

`BACKOFFICE_IPS` se lee en el **backend**, que es donde corre el control.
Cargarla en el servicio del backoffice no hace nada.

Cuando una IP queda afuera, la API responde **404 y no 403**. Un 403 le confirma
a quien está escaneando que el backoffice está en esa URL y que sólo le falta
estar en la lista.

### Cobro de suscripciones

```bash
MP_ACCESS_TOKEN=             # Access Token de producción de tu app de Mercado Pago
MP_WEBHOOK_URL=https://<app-publica>/api/billing/webhook/mercadopago
MP_WEBHOOK_SECRET=           # Webhooks → clave secreta, en la misma pantalla
MP_BACK_URL=https://<app-publica>/cuenta/suscripcion
```

Las dos URLs tienen que ser el **dominio público de la app**, el que abre el
cliente en el navegador. Con `localhost` no falla nada visible: el pago se
genera, el cliente paga, y el aviso se manda a una dirección que no existe — la
plata entra y la cuenta queda sin activar. Por eso el arranque y la pantalla de
Cobros lo marcan como error y no como detalle.

Un token que empiece con `TEST-` funciona igual y no mueve plata real: sirve
para probar el flujo entero. La pantalla de **Cobros** del backoffice avisa en
qué modo estás.

Sin `MP_WEBHOOK_URL` los pagos no se acreditan solos y hay que aprobarlos a
mano. Igual existe el botón «Ya pagué», que le pregunta directamente a Mercado
Pago — es la red de contención cuando un aviso no llega.

### Transferencia bancaria

```bash
BANCO_TITULAR=
BANCO_CUIT=
BANCO_CBU=
BANCO_ALIAS=
```

Sin esto, la pantalla de pago del cliente cae al contacto por mail.

### Mail

```bash
MAIL_USER=
MAIL_PASS=                   # contraseña de aplicación, no la de la cuenta
MAIL_FROM="Stocker" <no-reply@tudominio.com>
BACKOFFICE_EMAIL=stockerbackofficenoreply@gmail.com
```

`BACKOFFICE_EMAIL` recibe los pedidos de baja de cuenta. Es una variable para
poder mudarla al dominio propio sin tocar código.

### ARCA

```bash
ARCA_STOCKER_CUIT=
ARCA_CERT_B64=
ARCA_KEY_B64=
```

Los `.pem` van en base64 en la variable, nunca como archivo en el repo:
`storage/` está en `.gitignore` justamente por eso.

---

## Variables de los frontends

Cada front necesita saber a dónde reenviar `/api`. La forma más corta y la que
no depende de que nada resuelva:

```bash
API_INTERNAL_URL=http://<servicio-backend>.railway.internal:3000
```

La alternativa es `BACKEND_DOMAIN` + `BACKEND_PORT`, que se arman solos si
apuntan al servicio del backend.

**Cuidado con las referencias anidadas de Railway.** Una variable compartida que
a su vez referencia a otro servicio —`shared.BACKEND_DOMAIN` definida como
`${{svc.RAILWAY_PRIVATE_DOMAIN}}`, y el servicio usando `${{shared.BACKEND_DOMAIN}}`—
son dos niveles de indirección y puede llegar vacía. Cuando pasa, el front no
tiene a dónde reenviar. Antes caía a `localhost:3000` en silencio y el síntoma
era un `ECONNREFUSED` que no decía nada sobre la causa; ahora el servicio no
arranca y el log dice qué miró y qué encontró.

Si tenés dudas, referenciá el servicio directo en vez de pasar por `shared`:

```bash
BACKEND_DOMAIN=${{stockerback.RAILWAY_PRIVATE_DOMAIN}}
BACKEND_PORT=${{stockerback.PORT}}
```

El backoffice acepta además `BACKOFFICE_PORT` si querés fijar el suyo, y la
página pública `LANDING_PORT`.

### La página pública necesita el proxy

Antes se servía como archivo suelto, y por eso lo que se cambiaba en el
backoffice no se veía nunca: la página no tenía a quién preguntarle. Ahora tiene
su propio `server.js` que reenvía `/api/public` al backend, así que los precios y
el contacto se leen en cada visita y los cambios aparecen sin volver a publicar
nada.

Sólo reenvía `/api/public`, que es la única parte de la API sin sesión.
Reenviar todo `/api` convertiría a un sitio público en otra puerta hacia el login
y el backoffice, sin ninguna razón.

Si el backend no responde, la página muestra los valores escritos en el HTML.
Pueden estar viejos, pero se ve completa — una página comercial que dice
"cargando…" es peor que una desactualizada.

`LANDING_DOMAIN` en el **backend** habilita además el acceso «Ver la página»
desde el backoffice. Sin esa variable el enlace no aparece, en vez de apuntar a
un dominio escrito a mano que quede viejo.

---

## Alta del superusuario

Una sola vez, desde la consola del servicio backend en Railway:

```bash
node scripts/crear-superuser.js "Nombre Apellido" mail@dominio.com
```

Pide la contraseña sin eco, muestra la clave del segundo factor, espera a que la
cargues en Google Authenticator y la activa contra el código. Al terminar ya
podés entrar.

No hay endpoint que cree superusuarios: si existiera, sería el camino más corto
para tomar la plataforma entera.

---

## Qué protege qué

Vale separarlo, porque no todo lo que suena a seguridad hace lo mismo.

**Contra adivinar contraseñas.** Dos capas que miran cosas distintas. El
limitador de peticiones corta a los 5 intentos por minuto, o sea el ataque
rápido. El bloqueo por fallos cuenta **fallos**, no pedidos: 5 contra una misma
cuenta o 30 desde una misma IP en 15 minutos, con la duración escalando de 15
minutos a 6 horas según la insistencia del día. Eso es lo que agarra al ataque
lento — cuatro intentos por minuto durante una noche no toca nunca el limitador
y prueba miles de contraseñas.

El tope por IP es holgado a propósito: una IP no es una persona. Un local con
veinte empleados detrás de un router comparte una sola dirección, y con un tope
bajo el primero que se equivoca deja al resto sin poder entrar.

**Contra ráfagas.** El limitador general mira un minuto entero, así que 600
pedidos en dos segundos lo pasan y saturan igual. El de ráfaga mira ventanas de
dos segundos: 60 pedidos por IP. Es la diferencia entre "usa mucho el sistema" y
"algo se soltó". Un cajero escaneando llega a diez o quince por segundo en el
peor caso, muy por debajo.

**Contra inyección.** Acá conviene ser preciso: **no hay ningún detector de
"código malicioso", y no lo hay a propósito.** Buscar palabras como `SELECT`,
`UNION` o `<script>` en lo que manda el usuario suena a defensa y es sobre todo
un generador de fallas raras — un producto llamado "Camisa O'Brien", una nota
que dice "poner \<b\>oferta\</b\>" o un apellido con comillas quedarían
rechazados sin explicación, mientras el atacante que sabe lo que hace pasa igual
con cualquier codificación.

Lo que realmente frena la inyección es estructural y ya está:

- Sequelize parametriza todas las consultas. Un valor con comillas viaja como
  valor y nunca como parte de la sentencia.
- Los controladores copian del body sólo campos de una lista blanca, así que no
  se puede escribir una columna que no corresponde.
- React escapa lo que renderiza, así que un `<script>` guardado en la base se
  muestra como texto.

Lo que sí hay en el borde son controles sin ambigüedad, que no tienen falsos
positivos porque nunca aparecen en tráfico legítimo: bytes nulos, URLs de más de
2 KB, más de 40 parámetros, `Content-Type` que no sea JSON ni multipart al
escribir, cuerpos de más de 1 MB, y las rutas que sólo piden los escáneres
(`/.env`, `/wp-login.php`, `/phpmyadmin`). Esas últimas devuelven 404 seco:
no protegen de un atacante decidido, pero sacan del log el ruido que tapa los
intentos que sí importan.

**Cabeceras.** La API devuelve JSON, así que su CSP puede ser cerrada del todo
(`default-src 'none'`): si algún día un navegador termina renderizando una
respuesta por un error de content-type, no va a ejecutar nada.

### Lo que Railway no da

Railway no tiene WAF ni reglas de IP en el edge, así que **todo esto corre en la
aplicación**. Consecuencias honestas:

- Una inundación grande llega igual al contenedor y le consume CPU antes de que
  el limitador la rechace. Para eso hace falta algo delante — Cloudflare gratis
  ya alcanza.
- La IP del cliente llega en `X-Forwarded-For`, que la pone el edge de Railway.
  Es confiable mientras haya **exactamente un proxy** delante y `trust proxy`
  esté en `1`. Si algún día agregás otro proxy hay que ajustar ese número o la
  lista de IPs pasa a ser decorativa.
- Los contadores viven en la base y no en memoria, para que con más de una
  réplica el tope real sea el configurado y no su múltiplo.

---

## Verificación

```bash
bash scripts/test-defensas.sh
```

26 comprobaciones: bloqueo por fallos, ráfagas, filtros de forma, CORS y la
restricción por IP. Las otras tres suites son `test-seguridad.sh`,
`test-planes.sh` y `test-fiado.sh`.

Al arrancar, el backend imprime el estado de cada defensa. El modo más común de
fallar en esto es silencioso — la variable quedó sin cargar, el panel siguió
abierto, nadie se enteró — y verlo en cada deploy es la forma más barata de que
no pase inadvertido.
