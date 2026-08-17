#!/usr/bin/env bash
#
# Regresión de las defensas de borde.
#
#   1. Bloqueo por intentos fallidos de contraseña (fuerza bruta).
#   2. Ráfagas de peticiones (el patrón de una PC con un script suelto).
#   3. Filtros de forma: rutas de escaneo, bytes nulos, cuerpos gigantes.
#   4. CORS a orígenes exactos.
#   5. Restricción por IP del backoffice.
#
# Uso:  API=http://localhost:3000 bash scripts/test-defensas.sh
#
# Ojo: gasta cupo de los limitadores a propósito. Correrla dos veces seguidas
# puede dar saltados por bloqueo todavía activo — no son fallas.
API="${API:-http://localhost:3000}"
T=$(mktemp -d); trap 'limpiar; rm -rf $T' EXIT

ok=0; ko=0
chk() { if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %-50s %s\n" "$1" "$3"; ok=$((ok+1));
        else printf "  \033[31m✗\033[0m %-50s esperado=%s obtuvo=%s\n" "$1" "$2" "$3"; ko=$((ko+1)); fi; }
saltar() { printf "  \033[33m—\033[0m %-50s %s\n" "$1" "$2"; }
tit() { printf "\n\033[1m%s\033[0m\n" "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(eval('('+d+')')$1)}catch(e){console.log('ERR')}})"; }

# Los intentos quedan registrados en la base; se borran los de este script para
# no dejar a nadie bloqueado ni ensuciar el historial real.
limpiar() {
  node -e "
    require('dotenv').config();
    const { Op } = require('sequelize');
    const { AuthAttempt } = require('./src/models');
    (async () => {
      await AuthAttempt.destroy({ where: { identificador: { [Op.like]: '%@defensas.test' } } });
      process.exit(0);
    })();
  " >/dev/null 2>&1
}
limpiar

# ── 1. Fuerza bruta ──────────────────────────────────────────────
tit "1. BLOQUEO POR INTENTOS FALLIDOS"
CUENTA="fuerza.bruta@defensas.test"

# El limitador de peticiones corta a los 5 por minuto, antes de que se junten
# los fallos que necesita el bloqueo. Se prueba el bloqueo directamente contra
# el servicio, que es la pieza que decide.
RES=$(node scripts/test-defensas-bloqueo.cjs "$CUENTA" 2>/dev/null | tail -1)

chk "sin fallos previos, pasa"          "libre"      "$(echo "$RES" | J .antes)"
chk "con 4 fallos todavía pasa"        "libre"      "$(echo "$RES" | J .conCuatro)"
chk "al 5º fallo se bloquea"            "bloqueado"  "$(echo "$RES" | J .conCinco)"
chk "el bloqueo arranca en 15 min"      "15"         "$(echo "$RES" | J .minutos)"
chk "el mensaje no revela si existe"    "false"      "$(echo "$RES" | J .filtraCuenta)"
chk "otra cuenta no arrastra el bloqueo" "libre"     "$(echo "$RES" | J .otraLibre)"
chk "entrar bien limpia el contador"    "libre"      "$(echo "$RES" | J .trasEntrar)"

tit "1.b EL LOGIN REAL RESPONDE 429 CUANDO CORRESPONDE"
# 6 intentos seguidos: el limitador de peticiones tiene que cortar.
ULTIMO=""
for i in 1 2 3 4 5 6 7; do
  ULTIMO=$(code -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$CUENTA\",\"password\":\"incorrecta$i\"}")
done
chk "los intentos seguidos terminan en 429" "429" "$ULTIMO"

# ── 2. Ráfagas ───────────────────────────────────────────────────
tit "2. RÁFAGA DE PETICIONES"
# 80 pedidos lo más rápido posible: el tope de ráfaga es 60 cada 2 segundos.
for i in $(seq 1 80); do
  curl -s -o /dev/null "$API/" &
done
wait
RAFAGA=$(code "$API/")
chk "una ráfaga se frena" "429" "$RAFAGA"

echo "  … esperando que se libere la ventana de ráfaga"
sleep 3
chk "y se libera sola en segundos" "200" "$(code "$API/")"

# ── 3. Filtros de forma ──────────────────────────────────────────
tit "3. FILTROS DE FORMA"
chk "ruta de escaneo /.env"         "404" "$(code "$API/.env")"
chk "ruta de escaneo /wp-login.php" "404" "$(code "$API/wp-login.php")"
chk "ruta de escaneo /phpmyadmin"   "404" "$(code "$API/phpmyadmin/index.php")"

# Un byte nulo dentro de un texto no sale de ningún cliente legítimo.
chk "byte nulo en el cuerpo" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/login" \
     -H 'Content-Type: application/json' --data-binary $'{"email":"a\\u0000b","password":"x"}')"

# Escribir con un content-type de formulario: un form de otro sitio no puede
# mandar application/json sin pasar por CORS.
chk "content-type de formulario en escritura" "400" \
  "$(code -X POST "$API/api/auth/login" -H 'Content-Type: application/x-www-form-urlencoded' -d 'email=a@b.c&password=x')"

# Cuerpo por encima del megabyte.
node -e "console.log(JSON.stringify({email:'a@b.c',password:'x'.repeat(1500000)}))" > "$T/gordo.json"
chk "cuerpo de más de 1 MB" "413" \
  "$(code -X POST "$API/api/auth/login" -H 'Content-Type: application/json' --data-binary "@$T/gordo.json")"

URLLARGA="$API/api/products?q=$(node -e "console.log('a'.repeat(3000))")"
chk "URL desmedida" "400" "$(code "$URLLARGA")"

# ── 4. CORS ──────────────────────────────────────────────────────
tit "4. CORS A ORÍGENES EXACTOS"
permite() { # permite <origen> → si el navegador recibiría permiso
  curl -s -I -X OPTIONS "$API/api/auth/me" \
    -H "Origin: $1" -H 'Access-Control-Request-Method: GET' \
    | grep -qi 'access-control-allow-origin' && echo si || echo no
}
chk "localhost permitido en desarrollo" "si" "$(permite http://localhost:5173)"
chk "un railway.app cualquiera NO"      "no" "$(permite https://sitio-de-un-tercero.up.railway.app)"
chk "un vercel.app cualquiera NO"       "no" "$(permite https://cualquier-cosa.vercel.app)"
chk "un dominio ajeno NO"               "no" "$(permite https://evil.example.com)"

# ── 5. Backoffice por IP ─────────────────────────────────────────
tit "5. RESTRICCIÓN POR IP DEL BACKOFFICE"
if [ -n "$BACKOFFICE_IPS" ]; then
  saltar "restricción por IP" "BACKOFFICE_IPS está cargada: se prueba en el entorno real"
else
  # Sin la variable el panel queda abierto: es el comportamiento elegido para
  # no dejar a nadie afuera en el primer deploy, y el arranque lo avisa.
  chk "sin la variable, el login responde" "401" \
    "$(code -X POST "$API/api/backoffice/login" -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"a","codigo":"000000"}')"
  saltar "con la variable rechaza por IP" "se verifica abajo con el middleware directo"
fi

# El middleware se prueba directo: montar y desmontar la variable en el proceso
# que ya está corriendo no es posible desde afuera.
MW=$(node -e "
process.env.BACKOFFICE_IPS = '200.45.12.0/24, 2803:9800::/32';
process.env.NODE_ENV = 'production';
const { restringirBackoffice } = require('./src/middleware/ipAllowlist');
const probar = (ip) => new Promise((r) => {
  const req = { ip, originalUrl: '/api/backoffice/resumen' };
  const res = { status: (c) => ({ json: () => r(c) }) };
  restringirBackoffice(req, res, () => r(200));
});
(async () => {
  console.log(JSON.stringify({
    dentro:  await probar('200.45.12.34'),
    fuera:   await probar('8.8.8.8'),
    v6:      await probar('2803:9800:1111:2222::5'),
    local:   await probar('127.0.0.1'),
  }));
  process.exit(0);
})();
" 2>/dev/null | tail -1)

chk "IP en el rango entra"                    "200" "$(echo "$MW" | J .dentro)"
chk "IP de afuera recibe 404, no 403"         "404" "$(echo "$MW" | J .fuera)"
chk "IPv6 dentro del prefijo entra"           "200" "$(echo "$MW" | J .v6)"
chk "localhost NO entra en producción"        "404" "$(echo "$MW" | J .local)"

printf "\n\033[1m─────────────────────────────\033[0m\n  \033[32mPasaron: %s\033[0m   \033[31mFallaron: %s\033[0m\n" "$ok" "$ko"
[ "$ko" -eq 0 ]
