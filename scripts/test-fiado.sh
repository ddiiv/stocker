#!/usr/bin/env bash
#
# Regresión del flujo de venta fiada (cuenta corriente).
#
# Cubre las dos mitades: registrar la venta sin elegir medio de pago —porque
# todavía no se sabe con qué va a pagar el cliente— y cobrarla después con
# todas las combinaciones y recargos de siempre.
#
# Uso:  API=http://localhost:3000/api bash scripts/test-fiado.sh
#
# Requiere el backend corriendo y el negocio demo (scripts/seed-demo-business.js).
# Deja el negocio como lo encontró salvo por las ventas de prueba.
API="${API:-http://localhost:3000/api}"
T=$(mktemp -d); trap 'rm -rf $T' EXIT
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(eval('('+d+')')$1)}catch(e){console.log('ERR:'+d.slice(0,160))}})"; }
ok=0; ko=0
chk() { if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %-46s %s\n" "$1" "$3"; ok=$((ok+1));
        else printf "  \033[31m✗\033[0m %-46s esperado=%s obtuvo=%s\n" "$1" "$2" "$3"; ko=$((ko+1)); fi; }
tit() { printf "\n\033[1m%s\033[0m\n" "$1"; }

until [ "$(curl -s -o /dev/null -w '%{http_code}' -c $T/o.txt -X POST $API/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"demo@stocker.app","password":"Demo2026!!"}')" = "200" ]; do sleep 5; done
C() { curl -s -b $T/o.txt -H 'Content-Type: application/json' "$@"; }

# Variante con stock de sobra para no chocar con validaciones de inventario.
PROD=$(C "$API/products?limit=50")
SEL=".data.flatMap(p=>p.productVariants.map(v=>({...v,precio:p.precioMinorista}))).filter(v=>v.stock>=6)[0]"
VID=$(echo "$PROD" | J "$SEL.id")
SKU=$(echo "$PROD" | J "$SEL.sku")
PRECIO=$(echo "$PROD" | J "$SEL.precio")
stock() { C "$API/products/scan/$SKU" | J .stock; }
STOCK0=$(stock)
echo "variante=$VID sku=$SKU precio=$PRECIO stock=$STOCK0"

CID=$(C -X POST $API/clients -d '{"nombre":"Fiado","apellido":"QA"}' | J .id)
MEF=$(C "$API/payment-methods?activos=true" | J ".filter(m=>m.esEfectivo)[0].id")
MTR=$(C "$API/payment-methods?activos=true" | J ".filter(m=>!m.esEfectivo)[0].id")
echo "cliente=$CID efectivo=$MEF otro=$MTR"

fiar() { # fiar <clientId|null> <descontarStock>
  C -X POST $API/sales -d "{\"tipo\":\"venta\",\"condicionPago\":\"cuenta_corriente\",\"clientId\":$1,\"descontarStock\":$2,\"items\":[{\"productVariantId\":$VID,\"cantidad\":1}]}"
}

tit "1. QUÉ NO SE PUEDE FIAR"
chk "sin cliente no se fía" "si" "$(fiar null true | J ".message.includes('no se puede vender en cuenta corriente')?'si':'no'")"
C -X PUT $API/clients/$CID/cuenta -d '{"cuentaHabilitada":false,"limiteCredito":0}' -o /dev/null
chk "cuenta no habilitada rechaza" "si" "$(fiar $CID true | J ".message.includes('no tiene cuenta corriente habilitada')?'si':'no'")"
C -X PUT $API/clients/$CID/cuenta -d '{"cuentaHabilitada":true,"limiteCredito":1}' -o /dev/null
chk "se pasa del límite rechaza" "si" "$(fiar $CID true | J ".message.includes('Supera el límite')?'si':'no'")"

tit "2. VENTA FIADA (se lleva la mercadería)"
C -X PUT $API/clients/$CID/cuenta -d '{"cuentaHabilitada":true,"limiteCredito":9999999}' -o /dev/null
V1=$(fiar $CID true)
S1=$(echo "$V1" | J .id)
chk "queda pendiente"            "pendiente"        "$(echo "$V1" | J .estado)"
chk "condición cuenta corriente" "cuenta_corriente" "$(echo "$V1" | J .condicionPago)"
chk "sin medio de pago todavía"  "null"             "$(echo "$V1" | J .medioPago)"
chk "no figura plata cobrada"    "0"                "$(echo "$V1" | J '.totalCobrado|0')"
chk "saldo pendiente = total"    "$PRECIO"          "$(echo "$V1" | J '.saldoPendiente|0')"
chk "stock salió"                "$((STOCK0-1))"    "$(stock)"
chk "el cliente ahora debe"      "$PRECIO"          "$(C $API/clients/$CID/cuenta | J .cuenta.saldoCuenta)"
chk "la venta figura sin pagos"  "0"                "$(C $API/sales/$S1 | J .pagos.length)"

tit "3. VENTA FIADA SEÑADA (no se la lleva)"
V2=$(fiar $CID false)
S2=$(echo "$V2" | J .id)
chk "stock NO salió"        "$((STOCK0-1))" "$(stock)"
chk "marcada sin descontar" "false"         "$(echo "$V2" | J .stockDescontado)"
chk "deuda acumulada"       "$((PRECIO*2))" "$(C $API/clients/$CID/cuenta | J .cuenta.saldoCuenta)"

tit "4. COBRO CON COMBINACIÓN DE MEDIOS"
MITAD=$(node -e "console.log(Math.round($PRECIO/2*100)/100)")
RESTO=$(node -e "console.log(Math.round(($PRECIO-$MITAD)*100)/100)")
COB=$(C -X POST $API/sales/$S1/cobrar -d "{\"pagos\":[{\"paymentMethodId\":$MEF,\"monto\":$MITAD},{\"paymentMethodId\":$MTR,\"monto\":$RESTO}]}")
chk "la venta queda pagada"   "pagado" "$(echo "$COB" | J .estado)"
chk "sin saldo pendiente"     "0"      "$(echo "$COB" | J '.saldoPendiente|0')"
chk "guardó las dos líneas"   "2"      "$(echo "$COB" | J .pagos.length)"
chk "combinado no lleva ajuste" "0"    "$(echo "$COB" | J '.recargoPagos|0')"
chk "queda debiendo sólo la 2ª" "$PRECIO" "$(C $API/clients/$CID/cuenta | J .cuenta.saldoCuenta)"
chk "no volvió a descontar stock" "$((STOCK0-1))" "$(stock)"

tit "5. COBRO DE LA SEÑADA: RECIÉN AHÍ SALE EL STOCK"
COB2=$(C -X POST $API/sales/$S2/cobrar -d "{\"pagos\":[{\"paymentMethodId\":$MTR,\"monto\":$PRECIO,\"ajustePct\":5}]}")
ESPERADO=$(node -e "console.log(Math.round($PRECIO*1.05*100)/100)")
chk "pagada"                    "pagado"      "$(echo "$COB2" | J .estado)"
chk "aplicó el recargo del 5%"  "$ESPERADO"   "$(echo "$COB2" | J '.totalCobrado|0')"
chk "el total de venta no cambia" "$PRECIO"   "$(echo "$COB2" | J '.total|0')"
chk "ahora sí salió el stock"   "$((STOCK0-2))" "$(stock)"
chk "cliente sin deuda"         "0"           "$(C $API/clients/$CID/cuenta | J .cuenta.saldoCuenta)"

tit "6. REGLAS DEL COBRO"
chk "no se cobra dos veces" "409" "$(curl -s -o /dev/null -w '%{http_code}' -b $T/o.txt -X POST $API/sales/$S1/cobrar -H 'Content-Type: application/json' -d "{\"pagos\":[{\"paymentMethodId\":$MEF,\"monto\":$PRECIO}]}")"
chk "no se marca pagada a mano" "400" "$(curl -s -o /dev/null -w '%{http_code}' -b $T/o.txt -X PATCH $API/sales/$S2/estado -H 'Content-Type: application/json' -d '{"estado":"pagado"}')"
chk "los pagos deben cuadrar" "400" "$(curl -s -o /dev/null -w '%{http_code}' -b $T/o.txt -X POST $API/sales/$(fiar $CID true | J .id)/cobrar -H 'Content-Type: application/json' -d "{\"pagos\":[{\"paymentMethodId\":$MEF,\"monto\":1}]}")"

tit "7. PAGO A CUENTA: SE IMPUTA A LAS VENTAS MÁS VIEJAS"
V3=$(fiar $CID true); S3=$(echo "$V3" | J .id)
DEUDA=$(C $API/clients/$CID/cuenta | J .cuenta.saldoCuenta)
PAGO=$(C -X POST $API/clients/$CID/cuenta/pagos -d "{\"monto\":$DEUDA,\"paymentMethodId\":$MEF}")
chk "saldo en cero"             "0"       "$(echo "$PAGO" | J .saldo)"
chk "saldó las ventas abiertas" "si"      "$(echo "$PAGO" | J ".ventasSaldadas.length>=2?'si':'no'")"
chk "la venta quedó pagada"     "pagado"  "$(C $API/sales/$S3 | J .estado)"

tit "8. VENTA AL CONTADO (no se rompió)"
VC=$(C -X POST $API/sales -d "{\"tipo\":\"venta\",\"estado\":\"pagado\",\"items\":[{\"productVariantId\":$VID,\"cantidad\":1}],\"pagos\":[{\"paymentMethodId\":$MEF,\"monto\":$PRECIO}]}")
chk "pagada en el acto"   "pagado"   "$(echo "$VC" | J .estado)"
chk "condición contado"   "contado"  "$(echo "$VC" | J .condicionPago)"
chk "stock descontado"    "true"     "$(echo "$VC" | J .stockDescontado)"
chk "sin saldo pendiente" "0"        "$(echo "$VC" | J '.saldoPendiente|0')"

printf "\n\033[1m─────────────────────────────\033[0m\n  \033[32mPasaron: %s\033[0m   \033[31mFallaron: %s\033[0m\n" "$ok" "$ko"
echo "cliente de prueba: $CID"
