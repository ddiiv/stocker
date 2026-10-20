#!/usr/bin/env bash
# Las pruebas que corren solas sobre una base Postgres recién creada (la usa .github/workflows/ci.yml).
# Necesita DATABASE_URL, JWT_SECRET, PORT y API. Levanta el backend de nuevo antes de cada prueba:
# los limitadores viven en memoria, y 45 pruebas seguidas entrando como el mismo dueño los disparan.
# Afuera quedan las que dependen de credenciales o datos que el demo no trae:
# test-2fa, test-arca-delegacion (pide el certificado real de ARCA), test-arca-delegaciones, test-defensas-bloqueo, test-envios-dia (choca con el limitador),
# test-jumpseller-sync, test-logo-factura, test-ml-sync, test-ml-webhook, test-nota-credito,
# test-numeracion, test-tienda.
set -uo pipefail
cd "$(dirname "$0")/.."

PID=
levantar() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null
  touch backend.log
  local antes; antes=$(grep -c "Stocker API escuchando" backend.log)
  node index.js >> backend.log 2>&1 & PID=$!
  for _ in $(seq 1 60); do
    # El "escuchando" de ESTE arranque (sale después de crear las tablas), no que el puerto conteste.
    [ "$(grep -c "Stocker API escuchando" backend.log)" -gt "$antes" ] && return 0
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  echo "el backend no arrancó"; tail -30 backend.log; exit 1
}
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null' EXIT

levantar  # el primer arranque crea las tablas
node scripts/seed-demo-business.js > /dev/null || { echo "no se pudo cargar el negocio demo"; exit 1; }
# Lo online se abastece de dos locales (lo piden la cola online, los packs y el pago de la tienda).
node -e '
  const { BusinessLocation, Business } = require("./src/models");
  (async () => {
    const b = await Business.findOne({ where: { email: "demo@stocker.app" } });
    await BusinessLocation.update({ abasteceOnline: true }, { where: { businessId: b.id, nombre: ["Online / Envíos", "Depósito Central"] } });
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });'

PRUEBAS=(
  2fa-confianza aislamiento alta-stock arca-emision baja-sku arca-idempotencia arca-ptosventa avisos-venta
  cambio-plan carga clientes-cuit cobro-cuit cola-online configuracion-cuenta curvas enlaces-legales
  etiquetas factura-cliente factura-impresa factura-qr factura-transparencia feria inactividad integraciones-backoffice listas-producto
  legales mayorista ml-postventa ml-token packs pagos-caja planes plataformas precios rellenos reposicion
  reservas serializar-cuenta series sesiones sesiones-tabla sku solicitud-mayorista stock-local
  tareas-periodicas tienda-feed tienda-pago venta-local
)

fallaron=()
for p in "${PRUEBAS[@]}"; do
  levantar
  if timeout 180 node "scripts/test-$p.cjs" > "/tmp/test-$p.log" 2>&1; then
    echo "✓ $p"
  else
    echo "✗ $p"; fallaron+=("$p")
    grep -a -v '^\[debug\]' "/tmp/test-$p.log" | grep -a -A3 '✗\|ERROR' | head -20
  fi
done

echo "Pasaron $(( ${#PRUEBAS[@]} - ${#fallaron[@]} )) de ${#PRUEBAS[@]}"
[ ${#fallaron[@]} -eq 0 ]
