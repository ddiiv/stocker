#!/usr/bin/env bash
#
# Suite de verificación de seguridad + regresión funcional.
#
# Cubre los puntos CRÍTICO y ALTA de la checklist de producción y comprueba
# que los flujos de negocio sigan funcionando después de los cambios.
#
# Uso:  API=http://localhost:3000 bash scripts/test-seguridad.sh
#
# Requiere que el backend esté corriendo y que exista el negocio demo
# (scripts/seed-demo-business.js).

API="${API:-http://localhost:3000}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

OK=0; FALLO=0
titulo() { printf "\n\033[1m%s\033[0m\n" "$1"; }
check() { # check <descripción> <esperado> <obtenido>
  if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %-52s %s\n" "$1" "$3"; OK=$((OK+1));
  else printf "  \033[31m✗\033[0m %-52s esperado=%s obtenido=%s\n" "$1" "$2" "$3"; FALLO=$((FALLO+1)); fi
}
contiene() { # contiene <descripción> <substring> <texto>
  case "$3" in
    *"$2"*) printf "  \033[32m✓\033[0m %s\n" "$1"; OK=$((OK+1));;
    *) printf "  \033[31m✗\033[0m %-52s no contiene «%s»\n" "$1" "$2"; FALLO=$((FALLO+1));;
  esac
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }
# Igual que `code`. Existe con otro nombre para dejar claro en el llamado que se
# usa con pedidos que llevan cuerpo.
codeP() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }
# Igual que `code` pero guardando el cuerpo. No sirve pasarle -o a `code`: ya
# trae el suyo apuntando a /dev/null, curl empareja cada -o con una URL y el
# segundo se descarta en silencio, dejando el archivo sin crear.
codeGuardando() { local salida="$1"; shift; curl -s -o "$salida" -w '%{http_code}' --max-time 30 "$@"; }
# Para comprobaciones que el entorno impide verificar en este momento (por
# ejemplo, un rate limit todavía activo de una corrida anterior). No cuenta
# como fallo, pero queda visible para que nadie lo lea como "pasó".
saltar() { printf "  \033[33m—\033[0m %-52s %s\n" "$1" "$2"; }

# Espera a que la ventana del rate limiter deje pasar el login del dueño.
login_duenio() {
  until [ "$(code -c "$TMP/duenio.txt" -X POST "$API/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"email":"demo@stocker.app","password":"Demo2026!!"}')" = "200" ]; do sleep 5; done
}

# Empleado de prueba con permisos acotados (sólo stock). Se crea acá y se
# borra al final, así el script se puede correr las veces que haga falta.
node -e "
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Business, Role, Employee, BusinessLocation } = require('./src/models');
(async () => {
  const b = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  if (!b) { console.error('Falta el negocio demo: corré scripts/seed-demo-business.js'); process.exit(1); }
  const loc = await BusinessLocation.findOne({ where: { businessId: b.id } });
  const [rol] = await Role.findOrCreate({
    where: { businessId: b.id, nombre: 'QA-Deposito' },
    defaults: { businessId: b.id, nombre: 'QA-Deposito', permisos: { stock:'editar', ventas:'ninguno', facturacion:'ninguno', empleados:'ninguno', dashboard:'ninguno', cotizaciones:'ninguno' } },
  });
  await Employee.destroy({ where: { email: 'qa.deposito@stocker.test' } });
  await Employee.create({
    businessId: b.id, roleId: rol.id, locationId: loc?.id || null,
    dni: '99999901', nombre: 'QA', apellido: 'Deposito',
    email: 'qa.deposito@stocker.test',
    passwordHash: await bcrypt.hash('QaTest2026!', 10), activo: true,
  });
  process.exit(0);
})();
" >/dev/null 2>&1 || { echo "No se pudo preparar el empleado de prueba."; exit 1; }

limpiar_qa() {
  node -e "
    require('dotenv').config();
    const { Employee, Role, Business, Subscription, Plan } = require('./src/models');
    (async () => {
      await Employee.destroy({ where: { email: 'qa.deposito@stocker.test' } });
      await Role.destroy({ where: { nombre: 'QA-Deposito' } });
      // El plan vuelve a Pro: la suite lo eleva a Enterprise sólo mientras corre.
      const b = await Business.findOne({ where: { email: 'demo@stocker.app' } });
      const pro = await Plan.findOne({ where: { codigo: 'pro' } });
      if (b && pro) await Subscription.update({ planId: pro.id }, { where: { businessId: b.id } });
      process.exit(0);
    })();
  " >/dev/null 2>&1
}
trap 'limpiar_qa; rm -rf "$TMP"' EXIT

titulo "1. AUTENTICACIÓN Y COOKIE DE SESIÓN"
login_duenio
SETCOOKIE=$(curl -s -i -X POST "$API/api/auth/login" -H 'X-Forwarded-Proto: https' \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@stocker.app","password":"Demo2026!!"}' | grep -i '^set-cookie')
contiene "cookie httpOnly (no legible desde JS)"        "HttpOnly"          "$SETCOOKIE"
contiene "cookie Secure sobre https"                    "Secure"            "$SETCOOKIE"
contiene "cookie SameSite=Strict (anti-CSRF)"           "SameSite=Strict"   "$SETCOOKIE"
contiene "la cookie se llama stockerToken"              "stockerToken"      "$SETCOOKIE"
BODY=$(curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"demo@stocker.app","password":"Demo2026!!"}')
case "$BODY" in *'"token"'*) check "el token NO viaja en el body" "sin token" "trae token";;
  *) check "el token NO viaja en el body" "sin token" "sin token";; esac
check "sesión válida en /auth/me"        "200" "$(code -b "$TMP/duenio.txt" "$API/api/auth/me")"
check "sin cookie /auth/me rechaza"      "401" "$(code "$API/api/auth/me")"
check "password incorrecta rechaza"      "401" "$(code -X POST "$API/api/auth/login" \
    -H 'Content-Type: application/json' -d '{"email":"demo@stocker.app","password":"mala"}')"

titulo "2. AISLAMIENTO ENTRE NEGOCIOS (IDOR)"
login_duenio
# La variante 1 pertenece a otro negocio; el dueño demo no debe poder tocarla.
# El id del negocio demo sale de la sesión. Estaba escrito a mano y al recrear
# el demo cambia, así que las cuatro comprobaciones de aislamiento fallaban
# comparando contra un negocio que ya no existe.
NEGOCIO_ID=$(curl -s -b "$TMP/duenio.txt" "$API/api/auth/me" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).negocio.id)}catch{console.log('')}})")

# El stock es por local: la venta tiene que decir de cuál sale.
LOCAL_ID=$(curl -s -b "$TMP/duenio.txt" "$API/api/locations" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).sort((a,b)=>a.id-b.id)[0].id)}catch{console.log('')}})")

VENTA_AJENA=$(curl -s -b "$TMP/duenio.txt" -X POST "$API/api/sales" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"productVariantId\":1,\"cantidad\":1}],\"tipo\":\"venta\",\"estado\":\"pagado\",\"locationId\":$LOCAL_ID}")
contiene "no se puede vender producto de otro negocio"  "no encontrada" "$VENTA_AJENA"
check "no se puede leer variante ajena"     "404" "$(code -b "$TMP/duenio.txt" "$API/api/products/variants/1/movements")"
check "no se puede editar stock ajeno"      "404" "$(code -b "$TMP/duenio.txt" -X PATCH \
    "$API/api/products/variants/1/stock" -H 'Content-Type: application/json' \
    -d '{"tipo":"ingreso","cantidad":999}')"
check "no se puede borrar variante ajena"   "404" "$(code -b "$TMP/duenio.txt" -X DELETE "$API/api/products/variants/1")"

# La cuenta corriente pide un plan que la incluya. El negocio demo se eleva a
# Enterprise para que el chequeo de abajo llegue al controlador y no choque
# contra el control de plan (402).
#
# `limpiar_qa` lo devuelve a Pro al salir: dejarlo en Enterprise hacía que todo
# lo que se mirara después —el uso contra los topes, por ejemplo— apareciera sin
# límites, y eso se lee como un bug del sistema y no como resaca del test.
node -e "
require('dotenv').config();
const { Business, Subscription, Plan } = require('./src/models');
(async () => {
  const b = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const plan = await Plan.findOne({ where: { codigo: 'enterprise' } });
  if (b && plan) await Subscription.update({ planId: plan.id }, { where: { businessId: b.id } });
  process.exit(0);
})();
" > /dev/null 2>&1

titulo "2.b MASS ASSIGNMENT ENTRE NEGOCIOS (informe QA F-01/F-02)"
# El empleado de prueba tiene "empleados: editar", que es el permiso que hacía
# falta para la escalada original: editarse a sí mismo con otro businessId.
node -e "
require('dotenv').config();
const { Role } = require('./src/models');
(async () => {
  const r = await Role.findOne({ where: { nombre: 'QA-Deposito' } });
  const p = { ...r.permisos, empleados: 'editar' };
  await r.update({ permisos: p });
  process.exit(0);
})();
" >/dev/null 2>&1
curl -s -c "$TMP/qa2.txt" -X POST "$API/api/auth/employee-login" -H 'Content-Type: application/json'   -d '{"email":"qa.deposito@stocker.test","password":"QaTest2026!"}' -o /dev/null
EMPID=$(node -e "
require('dotenv').config();
const { Employee } = require('./src/models');
(async () => {
  const e = await Employee.findOne({ where: { email: 'qa.deposito@stocker.test' } });
  console.log(e ? e.id : '');
  process.exit(0);
})();
" 2>/dev/null | tail -1)
AJENO=$(node -e "
require('dotenv').config();
const { Op } = require('sequelize');
const { Business } = require('./src/models');
(async () => {
  const b = await Business.findOne({ where: { email: { [Op.ne]: 'demo@stocker.app' } } });
  console.log(b ? b.id : '');
  process.exit(0);
})();
" 2>/dev/null | tail -1)

if [ -n "$EMPID" ] && [ -n "$AJENO" ]; then
  curl -s -b "$TMP/qa2.txt" -X PUT "$API/api/employees/$EMPID" -H 'Content-Type: application/json' \
    -d "{\"nombre\":\"QA\",\"businessId\":$AJENO}" -o "$TMP/mass.json"
  QUEDO=$(node -e "
    require('dotenv').config();
    const { Employee } = require('./src/models');
    (async () => { const e = await Employee.findByPk($EMPID); console.log(e.businessId); process.exit(0); })();
  " 2>/dev/null | tail -1)
  check "businessId enviado por el cliente se ignora" "$NEGOCIO_ID" "$QUEDO"

  # Volver a loguear: si el businessId hubiera cambiado, la sesión sería de otro negocio.
  curl -s -c "$TMP/qa3.txt" -X POST "$API/api/auth/employee-login" -H 'Content-Type: application/json' \
    -d '{"email":"qa.deposito@stocker.test","password":"QaTest2026!"}' -o /dev/null
  NEG=$(curl -s -b "$TMP/qa3.txt" "$API/api/auth/me" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).negocio.id)}catch{console.log('')}})")
  check "tras re-loguear la sesión sigue en su negocio" "$NEGOCIO_ID" "$NEG"

  # Claves foráneas de otro negocio
  check "no acepta un cargo de otro negocio"  "400" "$(code -b "$TMP/qa2.txt" -X PUT "$API/api/employees/$EMPID" \
      -H 'Content-Type: application/json' -d '{"roleId":1}')"
  check "no acepta un local de otro negocio"  "400" "$(code -b "$TMP/qa2.txt" -X PUT "$API/api/employees/$EMPID" \
      -H 'Content-Type: application/json' -d '{"locationId":1}')"
fi

# Devolver el cargo a su estado original: el bloque de arriba le dio
# "empleados: editar" para poder reproducir la escalada, y la sección de RBAC
# que viene después verifica justamente que ese permiso esté denegado.
node -e "
require('dotenv').config();
const { Role } = require('./src/models');
(async () => {
  const r = await Role.findOne({ where: { nombre: 'QA-Deposito' } });
  if (r) await r.update({ permisos: { ...r.permisos, empleados: 'ninguno' } });
  process.exit(0);
})();
" >/dev/null 2>&1

# El resto de los controladores hacía update(req.body) directo, así que
# aceptaban un businessId del cliente igual que empleados. Se prueba con el
# dueño porque el objetivo no es el permiso sino el campo: aunque tenga
# derecho a editar el registro, no lo tiene a moverlo de negocio.
if [ -n "$AJENO" ]; then
  NUEVO=$(curl -s -b "$TMP/duenio.txt" -X POST "$API/api/clients" -H 'Content-Type: application/json' \
    -d "{\"nombre\":\"QA MassAssign\",\"businessId\":$AJENO}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log(r.id+'|'+r.businessId)}catch{console.log('|')}})")
  check "alta de cliente: ignora el businessId del cliente" "$NEGOCIO_ID" "${NUEVO#*|}"

  CLI_ID="${NUEVO%%|*}"
  if [ -n "$CLI_ID" ]; then
    QUEDO=$(curl -s -b "$TMP/duenio.txt" -X PUT "$API/api/clients/$CLI_ID" -H 'Content-Type: application/json' \
      -d "{\"nombre\":\"QA MassAssign\",\"businessId\":$AJENO}" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).businessId)}catch{console.log('')}})")
    check "edición de cliente: ignora el businessId del cliente" "$NEGOCIO_ID" "$QUEDO"

    # El saldo sólo se mueve con cargos y pagos, que dejan rastro en el
    # extracto. Si se pudiera escribir a mano, el límite de crédito no valdría.
    SALDO=$(curl -s -b "$TMP/duenio.txt" -X PUT "$API/api/clients/$CLI_ID/cuenta" -H 'Content-Type: application/json' \
      -d '{"cuentaHabilitada":true,"limiteCredito":1000,"saldoCuenta":-99999}' \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).saldoCuenta)}catch{console.log('')}})")
    check "cuenta corriente: el saldo no se puede escribir a mano" "0" "$SALDO"

    curl -s -b "$TMP/duenio.txt" -X DELETE "$API/api/clients/$CLI_ID" -o /dev/null
  fi
fi

titulo "2.c RECUPERACIÓN DE CONTRASEÑA: SIN ENUMERACIÓN (F-06)"
# El limitador permite 5 pedidos cada 15 minutos, y esta comparación gasta dos.
# Hay que mirar el código de LAS DOS: si sólo se controla la primera, una
# corrida anterior que dejó el contador en 4 hace que la segunda vuelva 429 y
# la comparación reporte "distintas" — un falso negativo que parece una fuga.
R1=$(codeGuardando "$TMP/r1.json" -X POST "$API/api/auth/forgot-password" -H 'Content-Type: application/json' \
  -d '{"email":"demo@stocker.app","cuit":"20345678901"}')
R2=$(codeGuardando "$TMP/r2.json" -X POST "$API/api/auth/forgot-password" -H 'Content-Type: application/json' \
  -d '{"email":"no-existe@ningunlado.test","cuit":"20345678901"}')
if [ "$R1" = "429" ] || [ "$R2" = "429" ]; then
  saltar "enumeración en recuperación" "rate limit activo — reintentar en 15 min"
else
  if cmp -s "$TMP/r1.json" "$TMP/r2.json"; then
    check "cuenta real e inexistente responden igual" "iguales" "iguales"
  else
    check "cuenta real e inexistente responden igual" "iguales" "distintas"
  fi
  contiene "la respuesta no filtra el email registrado" "coinciden" "$(cat "$TMP/r1.json")"
fi

titulo "3. CONTROL DE ACCESO POR ROL (RBAC)"
curl -s -c "$TMP/qa.txt" -X POST "$API/api/auth/employee-login" -H 'Content-Type: application/json' \
  -d '{"email":"qa.deposito@stocker.test","password":"QaTest2026!"}' -o /dev/null
# Empleado con stock=editar y todo lo demás en ninguno.
check "empleado depósito: /arca/debug bloqueado"   "403" "$(code -b "$TMP/qa.txt" "$API/api/arca/debug")"
check "empleado depósito: /whatsapp/test bloqueado" "403" "$(code -b "$TMP/qa.txt" "$API/api/whatsapp/test")"
check "empleado depósito: facturación bloqueada"   "403" "$(code -b "$TMP/qa.txt" "$API/api/invoices")"
check "empleado depósito: ventas bloqueadas"       "403" "$(code -b "$TMP/qa.txt" "$API/api/sales")"
check "empleado depósito: clientes bloqueados"     "403" "$(code -b "$TMP/qa.txt" "$API/api/clients")"
check "empleado depósito: empleados bloqueado"     "403" "$(code -b "$TMP/qa.txt" "$API/api/employees")"
check "empleado depósito: dashboard bloqueado"     "403" "$(code -b "$TMP/qa.txt" "$API/api/dashboard")"
check "empleado depósito: SÍ ve stock"             "200" "$(code -b "$TMP/qa.txt" "$API/api/products")"
check "empleado depósito: SÍ ve locales"           "200" "$(code -b "$TMP/qa.txt" "$API/api/locations")"

# ── Funciones de stock agregadas después: ver vs. editar ──
#
# Se prueban con un vendedor (stock=ver), que es el caso que importa: leer el
# stock de todos los locales lo tiene que poder hacer cualquier empleado, y
# ninguna de las escrituras.
curl -s -c "$TMP/vend.txt" -X POST "$API/api/auth/employee-login" -H 'Content-Type: application/json' \
  -d '{"email":"camila@boutiquealmendra.demo","password":"Vendedor2026!"}' -o /dev/null
VAR_ID=$(curl -s -b "$TMP/vend.txt" "$API/api/stock/por-local?limit=1&soloConStock=true" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).data[0].variantId)}catch{console.log('')}})")

if [ -n "$VAR_ID" ]; then
  check "vendedor: ve el stock por local"     "200" "$(code -b "$TMP/vend.txt" "$API/api/stock/por-local")"
  check "vendedor: ve productos por local"    "200" "$(code -b "$TMP/vend.txt" "$API/api/stock/por-local/productos")"
  check "vendedor: ve movimientos de stock"   "200" "$(code -b "$TMP/vend.txt" "$API/api/stock/movimientos")"
  check "vendedor: ve ingresos del día"       "200" "$(code -b "$TMP/vend.txt" "$API/api/stock/ingresos")"
  check "vendedor: ve la regla de SKU"        "200" "$(code -b "$TMP/vend.txt" "$API/api/sku/regla")"
  check "vendedor: puede generar etiquetas"   "200" "$(codeP -b "$TMP/vend.txt" -X POST "$API/api/products/etiquetas" -H 'Content-Type: application/json' -d "{\"items\":[{\"variantId\":$VAR_ID,\"cantidad\":1}]}")"

  check "vendedor NO transfiere stock"        "403" "$(codeP -b "$TMP/vend.txt" -X POST "$API/api/stock/transferir" -H 'Content-Type: application/json' -d "{\"variantId\":$VAR_ID,\"desde\":1,\"hacia\":2,\"cantidad\":1}")"
  check "vendedor NO hace ajuste masivo"      "403" "$(codeP -b "$TMP/vend.txt" -X POST "$API/api/stock/ajuste-masivo" -H 'Content-Type: application/json' -d "{\"items\":[{\"variantId\":$VAR_ID,\"delta\":5}]}")"
  check "vendedor NO cambia precios"          "403" "$(codeP -b "$TMP/vend.txt" -X POST "$API/api/products/precios-masivo" -H 'Content-Type: application/json' -d "{\"items\":[{\"variantId\":$VAR_ID,\"precioMinorista\":1}]}")"
  check "vendedor NO guarda la regla de SKU"  "403" "$(codeP -b "$TMP/vend.txt" -X PUT "$API/api/sku/regla" -H 'Content-Type: application/json' -d '{"regla":{"caracteres":4}}')"
  check "vendedor NO edita una variante"      "403" "$(codeP -b "$TMP/vend.txt" -X PUT "$API/api/products/variants/$VAR_ID" -H 'Content-Type: application/json' -d '{"precioMinorista":1}')"
  check "vendedor NO importa Excel"           "403" "$(codeP -b "$TMP/vend.txt" -X POST "$API/api/products/import")"
  check "vendedor NO escanea para ajustar"    "403" "$(codeP -b "$TMP/vend.txt" -X POST "$API/api/products/scan/stock" -H 'Content-Type: application/json' -d '{"codigo":"X","modo":"agregar","cantidad":1}')"
fi

titulo "4. TOKEN FORJADO CON EL SECRETO VIEJO"
FORJADO=$(NEGOCIO_ID="$NEGOCIO_ID" node -e "
  const jwt=require('jsonwebtoken');
  console.log(jwt.sign({type:'business',businessId:Number(process.env.NEGOCIO_ID)||1},'dev-secret-change-me',{expiresIn:'7d'}));
")
check "token firmado con 'dev-secret-change-me' rechazado" "401" \
  "$(code -H "Authorization: Bearer $FORJADO" "$API/api/auth/me")"

titulo "5. CSRF EN EL OAUTH DE MERCADOLIBRE"
CB=$(curl -s -o /dev/null -w '%{redirect_url}' "$API/api/mercadolibre/callback?code=FALSO&state=$NEGOCIO_ID")
contiene "state crudo (businessId) rechazado"      "ml_error" "$CB"
CB2=$(curl -s -o /dev/null -w '%{redirect_url}' "$API/api/mercadolibre/callback?code=FALSO&state=2")
contiene "state de otro negocio rechazado"         "ml_error" "$CB2"

titulo "6. INYECCIÓN SQL"
login_duenio
for PAYLOAD in "' OR '1'='1" "'; DROP TABLE products;--" "1' UNION SELECT NULL--"; do
  ENC=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PAYLOAD")
  check "búsqueda con «${PAYLOAD:0:18}...» no rompe" "200" \
    "$(code -b "$TMP/duenio.txt" "$API/api/products?search=$ENC")"
done
check "la tabla products sigue existiendo"  "200" "$(code -b "$TMP/duenio.txt" "$API/api/products")"

titulo "7. RATE LIMITING (fuerza bruta)"
BLOQUEADO=no
for i in 1 2 3 4 5 6 7; do
  C=$(code -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
      -d '{"email":"bruteforce@test.local","password":"x'"$i"'"}')
  [ "$C" = "429" ] && BLOQUEADO=si && break
done
check "el login se bloquea por fuerza bruta" "si" "$BLOQUEADO"
check "otro usuario NO queda bloqueado"      "401" "$(code -X POST "$API/api/auth/login" \
    -H 'Content-Type: application/json' -d '{"email":"otro.distinto@test.local","password":"x"}')"

titulo "8. FLUJOS DE NEGOCIO (regresión)"
login_duenio
check "listar productos"        "200" "$(code -b "$TMP/duenio.txt" "$API/api/products")"
check "listar ventas"           "200" "$(code -b "$TMP/duenio.txt" "$API/api/sales")"
check "listar clientes"         "200" "$(code -b "$TMP/duenio.txt" "$API/api/clients")"
check "listar facturas"         "200" "$(code -b "$TMP/duenio.txt" "$API/api/invoices")"
check "dashboard"               "200" "$(code -b "$TMP/duenio.txt" "$API/api/dashboard?rangeDays=30")"
check "métricas por producto"   "200" "$(code -b "$TMP/duenio.txt" "$API/api/metrics/products")"
check "métricas en el tiempo"   "200" "$(code -b "$TMP/duenio.txt" "$API/api/metrics/timeline?granularidad=mes")"
check "empleados"               "200" "$(code -b "$TMP/duenio.txt" "$API/api/employees")"
check "CUITs del negocio"       "200" "$(code -b "$TMP/duenio.txt" "$API/api/business-cuits")"
check "estado de MercadoLibre"  "200" "$(code -b "$TMP/duenio.txt" "$API/api/mercadolibre/status")"

# Venta legítima de punta a punta, con su propio producto.
VARIANTE=$(curl -s -b "$TMP/duenio.txt" "$API/api/products" | node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const p=JSON.parse(d); const lista=p.data||p;
    const prod=lista.find(x=>x.productVariants?.length);
    console.log(prod ? prod.productVariants[0].id : '');
  });")
if [ -n "$VARIANTE" ]; then
  VENTA=$(curl -s -b "$TMP/duenio.txt" -X POST "$API/api/sales" -H 'Content-Type: application/json' \
    -d "{\"items\":[{\"productVariantId\":$VARIANTE,\"cantidad\":1}],\"tipo\":\"venta\",\"estado\":\"pendiente\",\"locationId\":$LOCAL_ID}")
  contiene "venta legítima con producto propio"  '"id"' "$VENTA"
  VENTA_ID=$(echo "$VENTA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch{console.log('')}})")
  [ -n "$VENTA_ID" ] && check "ticket PDF de la venta" "200" "$(code -b "$TMP/duenio.txt" "$API/api/sales/$VENTA_ID/ticket")"
  # Deja la base como estaba.
  [ -n "$VENTA_ID" ] && node -e "
    require('dotenv').config();
    const { Sale, SaleItem } = require('./src/models');
    (async()=>{ await SaleItem.destroy({where:{saleId:$VENTA_ID}}); await Sale.destroy({where:{id:$VENTA_ID}}); process.exit(0); })();
  " >/dev/null 2>&1
fi

titulo "9. LOGOUT"
login_duenio
curl -s -b "$TMP/duenio.txt" -c "$TMP/duenio.txt" -X POST "$API/api/auth/logout" -o /dev/null
check "tras logout la sesión no sirve" "401" "$(code -b "$TMP/duenio.txt" "$API/api/auth/me")"

printf "\n\033[1m─────────────────────────────────────────\033[0m\n"
printf "  \033[32mPasaron: %d\033[0m   \033[31mFallaron: %d\033[0m\n" "$OK" "$FALLO"
printf "\033[1m─────────────────────────────────────────\033[0m\n"
[ "$FALLO" -eq 0 ]
