# ISU Mayorista — Sistema completo

Panel de gestión mayorista para indumentaria: stock con variantes,
ventas/cotizaciones, facturación ARCA, empleados por local y dashboard de métricas.

**Stack:** Node.js + Express + Sequelize + SQL Server 2025 (Linux) · React + Vite + Tailwind v4

---

## Estructura del proyecto

```
isumayorista/
  backend/          API REST (Node.js + Express + Sequelize/tedious)
  frontend/         Panel web (React + Vite)
  database/         schema.sql (T-SQL para SQL Server 2025)
  README.md         Este archivo
```

---

## Paso 1 — Instalar SQL Server 2025 en Linux (si no lo tenés)

```bash
# Ubuntu/Debian
curl -sSL https://packages.microsoft.com/keys/microsoft.asc | sudo gpg --dearmor -o /usr/share/keyrings/microsoft.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/22.04/mssql-server-2025 jammy main" | sudo tee /etc/apt/sources.list.d/mssql-server.list
sudo apt-get update
sudo apt-get install -y mssql-server

# Configurar (establecer contraseña del usuario 'sa')
sudo /opt/mssql/bin/mssql-conf setup

# Iniciar y habilitar el servicio
sudo systemctl start  mssql-server
sudo systemctl enable mssql-server
sudo systemctl status mssql-server
```

Instalar sqlcmd (herramienta de línea de comandos):
```bash
sudo apt-get install -y mssql-tools18 unixodbc-dev
echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> ~/.bashrc
source ~/.bashrc
```

Verificar que SQL Server responde:
```bash
sqlcmd -S localhost -U sa -P 'TuPassword123!' -Q "SELECT @@VERSION"
```

---

## Paso 2 — Crear la base de datos y las tablas

```bash
# Desde la carpeta raíz del proyecto:
sqlcmd -S localhost -U sa -P 'TuPassword123!' -i database/schema.sql
```

Deberías ver:
```
✔ Base de datos isumayorista creada.
✔ Tabla businesses creada.
✔ Tabla business_locations creada.
... (una línea por tabla)
✔ Schema ISU Mayorista instalado correctamente en SQL Server 2025.
```

---

## Paso 3 — Configurar y arrancar el backend

```bash
cd backend
npm install

# Copiar el archivo de variables de entorno
cp .env.example .env
```

Editá `.env` con tus datos reales:
```bash
nano .env          # o: vi .env
```

Valores mínimos que tenés que cambiar:
```
DB_SERVER=localhost
DB_USER=sa
DB_PASSWORD=TuPassword123!     # la que pusiste al configurar SQL Server
JWT_SECRET=una_frase_larga_y_segura_de_al_menos_32_caracteres
ARCA_MOCK=true                 # dejar en true hasta tener credenciales ARCA
```

Sincronizar los modelos Sequelize con la base (crea/actualiza tablas):
```bash
npm run db:sync
```

Arrancar el servidor:
```bash
npm run dev        # modo desarrollo (reinicia con nodemon al editar)
# o:
npm start          # modo producción
```

El backend queda escuchando en `http://localhost:3000`.
Podés verificarlo con:
```bash
curl http://localhost:3000/
# Debe devolver: {"message":"backisu API v2 ✔","status":"ok"}
```

---

## Paso 4 — Configurar y arrancar el frontend

```bash
cd frontend/isumayorista-admin
npm install

# Si el backend no corre en localhost:3000, crear .env.local:
echo "VITE_API_URL=http://localhost:3000/api" > .env.local

npm run dev        # desarrollo → http://localhost:5173
```

Para build de producción:
```bash
npm run build      # genera frontend/isumayorista-admin/dist/
```

---

## Paso 5 — Primer uso

1. Abrí `http://localhost:5173/registro`
2. Completá los datos del negocio (CUIT, nombre, email, contraseña)
3. El sistema te crea automáticamente 4 cargos base: Administrador, Vendedor, Depósito, Cajero
4. Entrás al dashboard y podés empezar a cargar locales, empleados y productos

---

## Comandos útiles de SQL Server en Linux

```bash
# Conectarse a SQL Server
sqlcmd -S localhost -U sa -P 'TuPassword123!'

# Desde sqlcmd: ver las tablas creadas
USE isumayorista;
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE';
GO

# Ver registros de una tabla
SELECT TOP 5 * FROM businesses;
GO

# Salir
EXIT

# Reiniciar SQL Server
sudo systemctl restart mssql-server

# Ver logs de SQL Server
sudo cat /var/opt/mssql/log/errorlog | tail -50

# Abrir puerto 1433 si usás firewall
sudo ufw allow 1433/tcp
```

---

## Flujo de negocio

| Paso | Módulo | Qué hace |
|------|--------|----------|
| 1 | Registro | Crea el negocio con CUIT y datos del dueño |
| 2 | Empleados → Locales | Agrega sucursales con dirección |
| 3 | Empleados → Cargos | Define roles con permisos por módulo |
| 4 | Empleados | Crea perfiles de empleados con cargo y local |
| 5 | Stock → Nuevo producto | Define título, SKU, precios y variantes (ej: color + talle) |
| 6 | Stock → Variante → Ajustar stock | Ingresa/egresa stock con registro de empleado |
| 7 | Ventas → Nueva venta | Busca productos, agrega variantes, selecciona cliente |
| 8 | — | Si totalUnidades ≥ 3 → precio mayorista automático |
| 9 | Ventas → Detalle → Marcar cobrada | Descuenta stock automáticamente |
| 10 | Ventas → Detalle → Generar factura | Pide CUIT del cliente, obtiene CAE (ARCA), genera PDF, envía por email y WhatsApp |

---

## Mayorista vs minorista

- **Minorista**: cuando el pedido tiene menos de 3 prendas en total
- **Mayorista**: cuando el pedido tiene 3 o más prendas (se aplica `precioMayorista`)
- La distinción queda registrada en la venta (`esMayorista = true`) y en la factura

---

## Facturación ARCA

Por defecto `ARCA_MOCK=true` (CAE simulado para desarrollo). Para activar la
integración real con el webservice WSFEv1 de ARCA:

1. Obtener certificado digital de ARCA
2. Poner `ARCA_MOCK=false` en `.env`
3. Completar `ARCA_WSDL`, `ARCA_CUIT`, `ARCA_CERT_PATH`, `ARCA_KEY_PATH`
4. Implementar `FECAESolicitar()` en `backend/src/services/arcaService.js`

---

## Variables de entorno completas

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `PORT` | Puerto del servidor | `3000` |
| `DB_SERVER` | Host SQL Server | `localhost` |
| `DB_PORT` | Puerto SQL Server | `1433` |
| `DB_NAME` | Nombre de la base | `isumayorista` |
| `DB_USER` | Usuario SQL Server | `sa` |
| `DB_PASSWORD` | Contraseña | `TuPassword123!` |
| `DB_ENCRYPT` | Encriptar conexión | `false` (local) / `true` (Azure) |
| `DB_TRUST_CERT` | Aceptar certificado autofirmado | `true` (local) |
| `JWT_SECRET` | Secreto para tokens | frase larga |
| `JWT_EXPIRES_IN` | Expiración del token | `7d` |
| `MAIL_HOST` | Servidor SMTP | `smtp.gmail.com` |
| `MAIL_USER` | Email remitente | `tu@gmail.com` |
| `MAIL_PASS` | App Password Gmail | — |
| `WHATSAPP_API_KEY` | API Key CallMeBot | — |
| `PDF_STORAGE_PATH` | Carpeta PDFs | `./storage/pdfs` |
| `ARCA_MOCK` | CAE simulado | `true` / `false` |
