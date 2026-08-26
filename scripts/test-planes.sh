#!/usr/bin/env bash
#
# Regresión de planes, topes y unicidad de identidad.
#
# Uso:  API=http://localhost:3000/api bash scripts/test-planes.sh
#
# Requiere el backend corriendo y el negocio demo. Crea una cuenta descartable
# y la borra al final.
API="${API:-http://localhost:3000/api}"
T=$(mktemp -d); trap 'rm -rf $T' EXIT
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(eval('('+d+')')$1)}catch(e){console.log('ERR:'+d.slice(0,160))}})"; }
ok=0; ko=0
chk() { if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %-48s %s\n" "$1" "$3"; ok=$((ok+1));
        else printf "  \033[31m✗\033[0m %-48s esperado=%s obtuvo=%s\n" "$1" "$2" "$3"; ko=$((ko+1)); fi; }
tit() { printf "\n\033[1m%s\033[0m\n" "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# El alta de cuentas está limitada a unos pocos intentos por ventana. Correr la
# suite dos veces seguidas agota esa cuota y devuelve 429: no es que la
# validación falle, es que el pedido ni siquiera llegó. Se marca como salteado
# para que nadie lo lea como "pasó" ni como una fuga.
chkAlta() { # chkAlta <descripción> <obtenido>
  if [ "$2" = "429" ]; then printf "  \033[33m—\033[0m %-48s %s\n" "$1" "límite de registro activo — reintentar en 15 min";
  else chk "$1" "409" "$2"; fi
}

until [ "$(code -c $T/o.txt -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@stocker.app","password":"Demo2026!!"}')" = "200" ]; do sleep 5; done
C() { curl -s -b $T/o.txt -H 'Content-Type: application/json' "$@"; }
CC() { curl -s -o /dev/null -w '%{http_code}' -b $T/o.txt -H 'Content-Type: application/json' "$@"; }

tit "1. CATÁLOGO DE PLANES"
P=$(curl -s $API/billing/planes)
chk "hay cuatro planes"          "4"     "$(echo "$P" | J .length)"
chk "Pro cuesta 97.800"          "97800" "$(echo "$P" | J ".find(x=>x.codigo==='pro').precioMensual")"
chk "Pro admite 2 CUITs"         "2"     "$(echo "$P" | J ".find(x=>x.codigo==='pro').maxCuits")"
chk "Enterprise se cotiza"       "true"  "$(echo "$P" | J ".find(x=>x.codigo==='enterprise').requiereCotizacion")"
chk "Enterprise sin tope"        "null"  "$(echo "$P" | J ".find(x=>x.codigo==='enterprise').maxEmpleados")"
chk "Superior cuesta 178.000"    "178000" "$(echo "$P" | J ".find(x=>x.codigo==='superior').precioMensual")"
chk "Superior: todo habilitado"  "true"  "$(echo "$P" | J ".find(x=>x.codigo==='superior').features.api")"

tit "1.b TOPES DE ALMACENAMIENTO Y CONSUMO"
chk "Inicial: 2.000 comprobantes/mes" "2000"  "$(echo "$P" | J ".find(x=>x.codigo==='inicial').maxComprobantes")"
chk "Inicial: 5.000 SKUs"             "5000"  "$(echo "$P" | J ".find(x=>x.codigo==='inicial').maxSkus")"
chk "Inicial: 2 locales"              "2"     "$(echo "$P" | J ".find(x=>x.codigo==='inicial').maxLocales")"
chk "Inicial SIN Mercado Libre"       "false" "$(echo "$P" | J ".find(x=>x.codigo==='inicial').features.ecommerce")"
chk "Pro: 5.000 comprobantes/mes"     "5000"  "$(echo "$P" | J ".find(x=>x.codigo==='pro').maxComprobantes")"
chk "Pro: 10.000 SKUs"                "10000" "$(echo "$P" | J ".find(x=>x.codigo==='pro').maxSkus")"
chk "Pro: 10 usuarios"                "10"    "$(echo "$P" | J ".find(x=>x.codigo==='pro').maxEmpleados")"
chk "Pro CON Mercado Libre"           "true"  "$(echo "$P" | J ".find(x=>x.codigo==='pro').features.ecommerce")"
chk "Superior: 10.000 comprobantes"   "10000" "$(echo "$P" | J ".find(x=>x.codigo==='superior').maxComprobantes")"
chk "Superior: 20.000 SKUs"           "20000" "$(echo "$P" | J ".find(x=>x.codigo==='superior').maxSkus")"
chk "Superior: 3 CUITs"               "3"     "$(echo "$P" | J ".find(x=>x.codigo==='superior').maxCuits")"
chk "Superior: 40 usuarios"           "40"    "$(echo "$P" | J ".find(x=>x.codigo==='superior').maxEmpleados")"
chk "Superior: 20 locales"            "20"    "$(echo "$P" | J ".find(x=>x.codigo==='superior').maxLocales")"

tit "2. ESTADO DE LA SUSCRIPCIÓN"
S=$(C $API/billing/suscripcion)
chk "arranca en prueba"          "trial" "$(echo "$S" | J .estado)"
chk "puede operar"               "false" "$(echo "$S" | J .soloLectura)"
chk "informa el uso de CUITs"    "true"  "$(echo "$S" | J '.uso.cuits.usado>=1')"
chk "informa el tope de usuarios" "10"   "$(echo "$S" | J .uso.empleados.tope)"
chk "mide los SKUs cargados"     "true" "$(echo "$S" | J '.uso.skus.usado>0')"
chk "tope de SKUs del Pro"       "10000" "$(echo "$S" | J .uso.skus.tope)"
chk "comprobantes: tope del Pro" "5000" "$(echo "$S" | J .uso.comprobantes.tope)"
chk "comprobantes se miden por mes" "mes" "$(echo "$S" | J .uso.comprobantes.periodo)"

tit "3. TOPES DEL PLAN"
USADOS=$(echo "$S" | J .uso.empleados.usado)
TOPE=$(echo "$S" | J .uso.empleados.tope)
CREADOS=()
i=0
while [ "$USADOS" -lt "$TOPE" ]; do
  i=$((i+1))
  ID=$(C -X POST $API/employees -d "{\"nombre\":\"Cupo\",\"apellido\":\"QA$i\",\"email\":\"cupo.qa$i@test.local\",\"dni\":\"9000000$i\",\"password\":\"CupoQa2026!\"}" | J .id)
  CREADOS+=("$ID")
  USADOS=$((USADOS+1))
done
chk "el empleado que pasa el tope se rechaza" "409" \
  "$(CC -X POST $API/employees -d '{"nombre":"Sobra","apellido":"QA","email":"sobra.qa@test.local","dni":"90000099","password":"CupoQa2026!"}')"
MSG=$(C -X POST $API/employees -d '{"nombre":"Sobra","apellido":"QA","email":"sobra.qa@test.local","dni":"90000099","password":"CupoQa2026!"}' | J .message)
chk "el mensaje ofrece subir de plan" "si" "$(node -e "console.log(/plan superior/.test(process.argv[1])?'si':'no')" "$MSG")"

tit "4. UN EMAIL, UNA SOLA PERSONA"
chkAlta "no se registra una cuenta con el mail del dueño" \
  "$(code -X POST $API/auth/register -H 'Content-Type: application/json' \
     -d '{"nombreNegocio":"Trucho","ownerNombre":"A","ownerApellido":"B","cuit":"20111111112","email":"demo@stocker.app","password":"Prueba2026!!"}')"
if [ "${#CREADOS[@]}" -gt 0 ]; then
  chkAlta "no se registra una cuenta con el mail de un empleado" \
    "$(code -X POST $API/auth/register -H 'Content-Type: application/json' \
       -d '{"nombreNegocio":"Trucho","ownerNombre":"A","ownerApellido":"B","cuit":"20111111112","email":"cupo.qa1@test.local","password":"Prueba2026!!"}')"
fi
chk "no se da de alta un empleado con el mail del dueño" "409" \
  "$(CC -X POST $API/employees -d '{"nombre":"X","apellido":"Y","email":"demo@stocker.app","dni":"90000098","password":"CupoQa2026!"}')"

tit "5. UN CUIT, UN SOLO NEGOCIO"
CUIT=$(C $API/business-cuits | J '[0].cuit')
chkAlta "no se registra otra cuenta con un CUIT ya usado" \
  "$(code -X POST $API/auth/register -H 'Content-Type: application/json' \
     -d "{\"nombreNegocio\":\"Trucho\",\"ownerNombre\":\"A\",\"ownerApellido\":\"B\",\"cuit\":\"$CUIT\",\"email\":\"otro.qa@test.local\",\"password\":\"Prueba2026!!\"}")"

tit "6. FUNCIONES SEGÚN EL PLAN"
# El demo está en Pro, que sí incluye cuentas corrientes; lo que no incluye es
# multi-depósito ni la API, que son del Superior en adelante.
CID=$(C -X POST $API/clients -d '{"nombre":"Plan","apellido":"QA"}' | J .id)
chk "el Pro habilita cuentas corrientes" "true" \
  "$(C -X PUT $API/clients/$CID/cuenta -d '{"cuentaHabilitada":true,"limiteCredito":1000}' | J .cuentaHabilitada)"
chk "la facturación está incluida"      "si" \
  "$(C $API/billing/suscripcion | J ".plan.features.facturacion?'si':'no'")"
chk "el Pro NO incluye multi-depósito"  "no" \
  "$(C $API/billing/suscripcion | J ".plan.features.multiDeposito?'si':'no'")"
chk "el Pro NO incluye la API"          "no" \
  "$(C $API/billing/suscripcion | J ".plan.features.api?'si':'no'")"

tit "6.b SUSCRIPCIÓN: RENOVACIÓN Y BAJA"
chk "se puede cancelar la renovación" "false" \
  "$(C -X POST $API/billing/renovacion -d '{"activa":false}' | J .renovacionAutomatica)"
chk "cancelar NO corta el servicio"   "false" \
  "$(C $API/billing/suscripcion | J .soloLectura)"
chk "se puede reactivar"              "true" \
  "$(C -X POST $API/billing/renovacion -d '{"activa":true}' | J .renovacionAutomatica)"

tit "6.c EGRESO DE STOCK: NO MÁS DE LO QUE HAY"
# Se elige una variante CON stock: con stock cero el egreso se rechaza por otra
# razón y el ajuste a cero también, porque la cantidad tiene que ser mayor a 0.
SEL=".data.flatMap(p=>p.productVariants).filter(v=>v.stock>0)[0]"
PROD=$(C "$API/products?limit=50")
VID=$(echo "$PROD" | J "$SEL.id")
STOCK=$(echo "$PROD" | J "$SEL.stock")
EXCESO=$((STOCK + 50))
chk "egreso mayor al stock se rechaza" "409" \
  "$(CC -X PATCH $API/products/variants/$VID/stock -d "{\"tipo\":\"egreso\",\"cantidad\":$EXCESO}")"
chk "el mensaje remite al ajuste" "si" \
  "$(C -X PATCH $API/products/variants/$VID/stock -d "{\"tipo\":\"egreso\",\"cantidad\":$EXCESO}" | J ".message.includes('ajuste')?'si':'no'")"
chk "el stock no se movió" "$STOCK" \
  "$(C "$API/products?limit=50" | J "$SEL.stock")"
chk "el ajuste sí puede fijar cualquier número" "200" \
  "$(CC -X PATCH $API/products/variants/$VID/stock -d "{\"tipo\":\"ajuste\",\"cantidad\":$STOCK,\"motivo\":\"QA planes\"}")"

tit "7. LIMPIEZA"
for id in "${CREADOS[@]}"; do CC -X DELETE $API/employees/$id > /dev/null; done
CC -X DELETE $API/clients/$CID > /dev/null
chk "quedó como estaba" "si" "$(C $API/billing/suscripcion | J ".uso.empleados.usado<=$TOPE?'si':'no'")"

printf "\n\033[1m─────────────────────────────\033[0m\n  \033[32mPasaron: %s\033[0m   \033[31mFallaron: %s\033[0m\n" "$ok" "$ko"
[ "$ko" -eq 0 ]
