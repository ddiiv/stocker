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
    const { Employee, Role } = require('./src/models');
    (async () => {
      await Employee.destroy({ where: { email: 'qa.deposito@stocker.test' } });
      await Role.destroy({ where: { nombre: 'QA-Deposito' } });
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
VENTA_AJENA=$(curl -s -b "$TMP/duenio.txt" -X POST "$API/api/sales" -H 'Content-Type: application/json' \
  -d '{"items":[{"productVariantId":1,"cantidad":1}],"tipo":"venta","estado":"pagado"}')
contiene "no se puede vender producto de otro negocio"  "no encontrada" "$VENTA_AJENA"
check "no se puede leer variante ajena"     "404" "$(code -b "$TMP/duenio.txt" "$API/api/products/variants/1/movements")"
check "no se puede editar stock ajeno"      "404" "$(code -b "$TMP/duenio.txt" -X PATCH \
    "$API/api/products/variants/1/stock" -H 'Content-Type: application/json' \
    -d '{"tipo":"ingreso","cantidad":999}')"
check "no se puede borrar variante ajena"   "404" "$(code -b "$TMP/duenio.txt" -X DELETE "$API/api/products/variants/1")"

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

titulo "4. TOKEN FORJADO CON EL SECRETO VIEJO"
FORJADO=$(node -e "
  const jwt=require('jsonwebtoken');
  console.log(jwt.sign({type:'business',businessId:35},'dev-secret-change-me',{expiresIn:'7d'}));
")
check "token firmado con 'dev-secret-change-me' rechazado" "401" \
  "$(code -H "Authorization: Bearer $FORJADO" "$API/api/auth/me")"

titulo "5. CSRF EN EL OAUTH DE MERCADOLIBRE"
CB=$(curl -s -o /dev/null -w '%{redirect_url}' "$API/api/mercadolibre/callback?code=FALSO&state=35")
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
    -d "{\"items\":[{\"productVariantId\":$VARIANTE,\"cantidad\":1}],\"tipo\":\"venta\",\"estado\":\"pendiente\"}")
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
