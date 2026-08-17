# Deploy en Railway

Cuatro servicios en el mismo proyecto y environment:

| Servicio | Carpeta | Dominio público | Arranque |
|---|---|---|---|
| `backend` | `back/stocker` | **no** | `node index.js` |
| `app` | `front/stocker` | sí | `npm start` |
| `backoffice` | `front/backoffice` | sí | `npm start` |
| `landing` | `front/landing` | sí | estático |

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

### Acceso al backoffice

```bash
BACKOFFICE_IPS=200.45.12.34, 2803:9800:1234::/48
```

Direcciones sueltas o CIDR, separadas por coma, IPv4 e IPv6.

**Sin esta variable el panel queda abierto a internet.** Se eligió así para no
dejar a nadie afuera de su propio panel en el primer deploy, pero el arranque lo
grita en los logs y la pantalla de Seguridad lo muestra en rojo.

Para saber qué IP cargar: entrá al panel sin la variable y mirá los logs, o
`curl ifconfig.me`. Una IP doméstica cambia — si se te corta el acceso, es lo
primero a revisar. Por eso el segundo factor sigue siendo obligatorio: la IP es
una capa, no la única.

Cuando una IP queda afuera, la API responde **404 y no 403**. Un 403 le confirma
a quien está escaneando que el backoffice está en esa URL y que sólo le falta
estar en la lista.

### Cobro de suscripciones

```bash
MP_ACCESS_TOKEN=             # Access Token de producción de tu app de Mercado Pago
MP_WEBHOOK_URL=https://TU-APP/api/billing/webhook/mercadopago
MP_WEBHOOK_SECRET=           # Webhooks → clave secreta, en la misma pantalla
MP_BACK_URL=https://TU-APP/cuenta/suscripcion
```

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

Los tres iguales, cambiando el puerto:

```bash
BACKEND_DOMAIN=backend.railway.internal
BACKEND_PORT=3000
```

`BACKEND_PORT` es la misma variable que usa el backend para elegir su puerto,
así que los dos coinciden solos. Es lo que evita el desencuentro clásico de
"escucha en un puerto y le hablo a otro".

El backoffice acepta además `BACKOFFICE_PORT` si querés fijar el suyo.

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
