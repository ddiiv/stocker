-- ================================================================
-- Stocker — Schema para PostgreSQL 14+
--
-- Aplicar con psql desde una terminal:
--   psql "$DATABASE_URL" -f database/schema.postgres.sql
-- O contra Postgres local:
--   psql -h localhost -U postgres -d stocker -f database/schema.postgres.sql
--
-- Es idempotente: usa "CREATE TABLE IF NOT EXISTS" en todas las tablas.
-- ================================================================

-- ── 1. BUSINESSES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
    id             SERIAL PRIMARY KEY,
    "nombreNegocio"  VARCHAR(150) NOT NULL,
    "ownerNombre"    VARCHAR(100) NOT NULL,
    "ownerApellido"  VARCHAR(100) NOT NULL,
    "ownerTelefono"  VARCHAR(30),
    cuit           VARCHAR(20)  NOT NULL,
    telefono       VARCHAR(30),
    email          VARCHAR(150) NOT NULL,
    "passwordHash"   VARCHAR(255) NOT NULL,
    "createdAt"      TIMESTAMP DEFAULT NOW(),
    "updatedAt"      TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_businesses_cuit  UNIQUE (cuit),
    CONSTRAINT uq_businesses_email UNIQUE (email)
);

-- ── 2. BUSINESS_LOCATIONS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_locations (
    id          SERIAL PRIMARY KEY,
    "businessId"  INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    nombre      VARCHAR(150) NOT NULL,
    direccion   VARCHAR(255) NOT NULL,
    telefono    VARCHAR(30),
    activo      BOOLEAN DEFAULT TRUE,
    "createdAt"   TIMESTAMP DEFAULT NOW(),
    "updatedAt"   TIMESTAMP DEFAULT NOW()
);

-- ── 3. BUSINESS_CUITS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_cuits (
    id            SERIAL PRIMARY KEY,
    "businessId"    INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    nombre        VARCHAR(150) NOT NULL,
    cuit          VARCHAR(20)  NOT NULL,
    "condicionIva"  VARCHAR(60),
    domicilio     VARCHAR(255),
    "esPrincipal"   BOOLEAN DEFAULT FALSE,
    "createdAt"     TIMESTAMP DEFAULT NOW(),
    "updatedAt"     TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_bizcuits_biz_cuit UNIQUE ("businessId", cuit)
);

-- ── 4. BUSINESS_ARCA_CONFIGS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_arca_configs (
    id                    SERIAL PRIMARY KEY,
    "businessId"            INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    "businessCuitId"        INT NOT NULL REFERENCES business_cuits(id) ON DELETE NO ACTION,
    "puntoVenta"            INT,
    "condicionIva"          VARCHAR(60),
    ambiente              VARCHAR(20) DEFAULT 'homologacion',
    "delegacionVerificada"  BOOLEAN DEFAULT FALSE,
    "ultimaVerificacion"    TIMESTAMP,
    "ultimoError"           VARCHAR(500),
    "createdAt"             TIMESTAMP DEFAULT NOW(),
    "updatedAt"             TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_arcaconfig_cuit UNIQUE ("businessCuitId")
);

-- ── 5. VARIANT_TYPES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS variant_types (
    id          SERIAL PRIMARY KEY,
    "businessId"  INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    nombre      VARCHAR(80) NOT NULL,
    valores     TEXT NOT NULL DEFAULT '[]',
    "createdAt"   TIMESTAMP DEFAULT NOW(),
    "updatedAt"   TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_vartypes_biz_nombre UNIQUE ("businessId", nombre)
);

-- ── 6. ROLES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
    id          SERIAL PRIMARY KEY,
    "businessId"  INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    nombre      VARCHAR(80) NOT NULL,
    permisos    TEXT NOT NULL
                DEFAULT '{"stock":"ninguno","ventas":"ninguno","facturacion":"ninguno","empleados":"ninguno","dashboard":"ninguno","cotizaciones":"ninguno"}',
    "createdAt"   TIMESTAMP DEFAULT NOW(),
    "updatedAt"   TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_roles_biz_nombre UNIQUE ("businessId", nombre)
);

-- ── 7. EMPLOYEES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
    id              SERIAL PRIMARY KEY,
    "businessId"      INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    "locationId"      INT REFERENCES business_locations(id) ON DELETE SET NULL,
    "roleId"          INT REFERENCES roles(id) ON DELETE SET NULL,
    dni             VARCHAR(20)  NOT NULL,
    nombre          VARCHAR(100) NOT NULL,
    apellido        VARCHAR(100) NOT NULL,
    telefono        VARCHAR(30),
    email           VARCHAR(150) NOT NULL,
    "passwordHash"    VARCHAR(255),
    activo          BOOLEAN DEFAULT TRUE,
    "ultimaConexion"  TIMESTAMP,
    "createdAt"       TIMESTAMP DEFAULT NOW(),
    "updatedAt"       TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_employees_email UNIQUE ("businessId", email)
);

-- ── 8. EMPLOYEE_SESSIONS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_sessions (
    id          SERIAL PRIMARY KEY,
    "employeeId"  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    ip          VARCHAR(64),
    "userAgent"   VARCHAR(500),
    "loginAt"     TIMESTAMP NOT NULL DEFAULT NOW(),
    "lastSeenAt"  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_empsess_employee_seen
    ON employee_sessions ("employeeId", "lastSeenAt" DESC);

-- ── 9. CLIENTS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
    id          SERIAL PRIMARY KEY,
    "businessId"  INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    nombre      VARCHAR(100) NOT NULL,
    apellido    VARCHAR(100),
    email       VARCHAR(150),
    telefono    VARCHAR(30),
    whatsapp    VARCHAR(30),
    cuit        VARCHAR(20),
    dni         VARCHAR(20),
    direccion   VARCHAR(255),
    tipo        VARCHAR(20) DEFAULT 'minorista',
    notas       TEXT,
    "createdAt"   TIMESTAMP DEFAULT NOW(),
    "updatedAt"   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_biz  ON clients ("businessId");
CREATE INDEX IF NOT EXISTS idx_clients_cuit ON clients (cuit);

-- ── 10. PRODUCTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id                 SERIAL PRIMARY KEY,
    "businessId"         INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    sku                VARCHAR(80)   NOT NULL,
    "skuAgrupador"       VARCHAR(80)   NOT NULL,
    titulo             VARCHAR(200)  NOT NULL,
    descripcion        TEXT,
    "precioMinorista"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    "precioMayorista"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    costo              DECIMAL(12,2) NOT NULL DEFAULT 0,
    variantes          TEXT NOT NULL DEFAULT '{}',
    modelo             VARCHAR(80),
    categoria          VARCHAR(80),
    genero             VARCHAR(40),
    activo             BOOLEAN DEFAULT TRUE,
    "fechaActualizacion" TIMESTAMP DEFAULT NOW(),
    "createdAt"          TIMESTAMP DEFAULT NOW(),
    "updatedAt"          TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_products_sku UNIQUE (sku)
);
CREATE INDEX IF NOT EXISTS idx_products_biz   ON products ("businessId");
CREATE INDEX IF NOT EXISTS idx_products_agrup ON products ("skuAgrupador");

-- ── 11. PRODUCT_VARIANTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_variants (
    id               SERIAL PRIMARY KEY,
    "productId"        INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku              VARCHAR(100) NOT NULL,
    "variante1Nombre"  VARCHAR(40),
    "variante1Valor"   VARCHAR(80),
    "variante2Nombre"  VARCHAR(40),
    "variante2Valor"   VARCHAR(80),
    stock            INT NOT NULL DEFAULT 0,
    "stockMinimo"      INT NOT NULL DEFAULT 5,
    activo           BOOLEAN DEFAULT TRUE,
    "createdAt"        TIMESTAMP DEFAULT NOW(),
    "updatedAt"        TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_variants_sku UNIQUE (sku)
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants ("productId");

-- ── 12. STOCK_MOVEMENTS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
    id                SERIAL PRIMARY KEY,
    "productVariantId"  INT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    "locationId"        INT REFERENCES business_locations(id) ON DELETE SET NULL,
    "employeeId"        INT REFERENCES employees(id) ON DELETE SET NULL,
    "saleItemId"        INT,
    tipo              VARCHAR(20) NOT NULL,
    cantidad          INT NOT NULL,
    "stockAnterior"     INT NOT NULL,
    "stockNuevo"        INT NOT NULL,
    motivo            VARCHAR(255),
    "fechaMovimiento"   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sm_variant  ON stock_movements ("productVariantId");
CREATE INDEX IF NOT EXISTS idx_sm_employee ON stock_movements ("employeeId");
CREATE INDEX IF NOT EXISTS idx_sm_fecha    ON stock_movements ("fechaMovimiento");

-- ── 13. SALES ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
    id            SERIAL PRIMARY KEY,
    "businessId"    INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    "locationId"    INT REFERENCES business_locations(id) ON DELETE SET NULL,
    "employeeId"    INT REFERENCES employees(id) ON DELETE NO ACTION,
    "clientId"      INT REFERENCES clients(id) ON DELETE SET NULL,
    numero        VARCHAR(25)   NOT NULL,
    tipo          VARCHAR(15)   NOT NULL DEFAULT 'venta',
    estado        VARCHAR(15)   NOT NULL DEFAULT 'pendiente',
    "esMayorista"   BOOLEAN DEFAULT FALSE,
    subtotal      DECIMAL(12,2) DEFAULT 0,
    "descuentoPct"  DECIMAL(5,2)  DEFAULT 0,
    descuento     DECIMAL(12,2) DEFAULT 0,
    total         DECIMAL(12,2) DEFAULT 0,
    "medioPago"     VARCHAR(60),
    notas         TEXT,
    "cotizacionId"  INT,
    fecha         DATE NOT NULL,
    "createdAt"     TIMESTAMP DEFAULT NOW(),
    "updatedAt"     TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_sales_biz_numero UNIQUE ("businessId", numero)
);
CREATE INDEX IF NOT EXISTS idx_sales_biz    ON sales ("businessId");
CREATE INDEX IF NOT EXISTS idx_sales_client ON sales ("clientId");
CREATE INDEX IF NOT EXISTS idx_sales_fecha  ON sales (fecha);

-- ── 14. SALE_ITEMS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_items (
    id               SERIAL PRIMARY KEY,
    "saleId"           INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    "productVariantId" INT REFERENCES product_variants(id) ON DELETE SET NULL,
    titulo           VARCHAR(200) NOT NULL,
    sku              VARCHAR(100) NOT NULL,
    "skuAgrupador"     VARCHAR(80),
    "variante1Nombre"  VARCHAR(40),
    "variante1Valor"   VARCHAR(80),
    "variante2Nombre"  VARCHAR(40),
    "variante2Valor"   VARCHAR(80),
    cantidad         INT           NOT NULL,
    "precioUnitario"   DECIMAL(12,2) NOT NULL,
    subtotal         DECIMAL(12,2) NOT NULL,
    "esMayorista"      BOOLEAN DEFAULT FALSE
);

-- ── 15. INVOICES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
    id               SERIAL PRIMARY KEY,
    "businessId"       INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    "saleId"           INT NOT NULL REFERENCES sales(id) ON DELETE NO ACTION,
    "clientId"         INT REFERENCES clients(id) ON DELETE SET NULL,
    "employeeId"       INT REFERENCES employees(id) ON DELETE NO ACTION,
    numero           VARCHAR(25)  NOT NULL,
    tipo             VARCHAR(5)   NOT NULL DEFAULT 'B',
    "clienteNombre"    VARCHAR(200) NOT NULL,
    "clienteCuit"      VARCHAR(20),
    "clienteEmail"     VARCHAR(150),
    "clienteDireccion" VARCHAR(255),
    subtotal         DECIMAL(12,2) NOT NULL,
    iva              DECIMAL(12,2) DEFAULT 0,
    total            DECIMAL(12,2) NOT NULL,
    "esMayorista"      BOOLEAN DEFAULT FALSE,
    cae              VARCHAR(20),
    "caeVencimiento"   DATE,
    "arcaRespuesta"    TEXT,
    "businessCuitId"   INT REFERENCES business_cuits(id) ON DELETE NO ACTION,
    "emisorCuit"       VARCHAR(20),
    "emisorNombre"     VARCHAR(150),
    "pdfPath"          VARCHAR(255),
    "fechaEmision"     TIMESTAMP NOT NULL DEFAULT NOW(),
    estado           VARCHAR(15) DEFAULT 'emitida',
    notas            TEXT,
    "createdAt"        TIMESTAMP DEFAULT NOW(),
    "updatedAt"        TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_invoices_biz_numero UNIQUE ("businessId", numero),
    CONSTRAINT uq_invoices_sale       UNIQUE ("saleId")
);
CREATE INDEX IF NOT EXISTS idx_invoices_biz   ON invoices ("businessId");
CREATE INDEX IF NOT EXISTS idx_invoices_fecha ON invoices ("fechaEmision");

-- ── 15b. PASSWORD_RESET_CODES ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_codes (
    id            SERIAL PRIMARY KEY,
    "businessId"    INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    code          VARCHAR(10) NOT NULL,
    "attemptsLeft"  INT NOT NULL DEFAULT 4,
    "expiresAt"     TIMESTAMP NOT NULL,
    "usedAt"        TIMESTAMP,
    "alertSentAt"   TIMESTAMP,
    "createdAt"     TIMESTAMP DEFAULT NOW(),
    "updatedAt"     TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prc_biz
    ON password_reset_codes ("businessId", "expiresAt" DESC);

-- ── 16. INVOICE_ITEMS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_items (
    id               SERIAL PRIMARY KEY,
    "invoiceId"        INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    titulo           VARCHAR(200) NOT NULL,
    sku              VARCHAR(100) NOT NULL,
    "skuAgrupador"     VARCHAR(80),
    "variante1Nombre"  VARCHAR(40),
    "variante1Valor"   VARCHAR(80),
    "variante2Nombre"  VARCHAR(40),
    "variante2Valor"   VARCHAR(80),
    cantidad         INT           NOT NULL,
    "esMayorista"      BOOLEAN DEFAULT FALSE,
    "precioUnitario"   DECIMAL(12,2) NOT NULL,
    subtotal         DECIMAL(12,2) NOT NULL
);

-- ── FIN ───────────────────────────────────────────────────────────
-- Tablas creadas: businesses, business_locations, business_cuits,
--                 business_arca_configs, variant_types, roles,
--                 employees, employee_sessions, clients, products,
--                 product_variants, stock_movements, sales, sale_items,
--                 invoices, invoice_items
