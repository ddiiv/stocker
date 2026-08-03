-- ================================================================
-- Stocker — Schema completo para SQL Server 2025
--
-- Cómo ejecutarlo desde la terminal Linux:
--   sqlcmd -S localhost -U sa -P 'TuPassword123!' -i schema.sql
--
-- O desde sqlcmd interactivo:
--   :r /ruta/al/schema.sql
-- ================================================================

-- Crear la base de datos si no existe
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'isumayorista')
BEGIN
    CREATE DATABASE isumayorista
    COLLATE Latin1_General_CI_AS;
    PRINT '✔ Base de datos isumayorista creada.'
END
ELSE
    PRINT '  Base de datos isumayorista ya existe — omitiendo creación.'
GO

USE isumayorista;
GO

-- ── 1. BUSINESSES (dueños de cuenta) ─────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'businesses')
BEGIN
    CREATE TABLE businesses (
        id             INT IDENTITY(1,1) PRIMARY KEY,
        nombreNegocio  NVARCHAR(150) NOT NULL,
        ownerNombre    NVARCHAR(100) NOT NULL,
        ownerApellido  NVARCHAR(100) NOT NULL,
        ownerTelefono  NVARCHAR(30),
        cuit           NVARCHAR(20)  NOT NULL,
        telefono       NVARCHAR(30),
        email          NVARCHAR(150) NOT NULL,
        passwordHash   NVARCHAR(255) NOT NULL,
        createdAt      DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt      DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_businesses_cuit  UNIQUE (cuit),
        CONSTRAINT uq_businesses_email UNIQUE (email)
    );
    PRINT '✔ Tabla businesses creada.'
END
GO

-- ── 2. BUSINESS_LOCATIONS (locales / sucursales) ──────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'business_locations')
BEGIN
    CREATE TABLE business_locations (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        businessId  INT NOT NULL,
        nombre      NVARCHAR(150) NOT NULL,
        direccion   NVARCHAR(255) NOT NULL,
        telefono    NVARCHAR(30),
        activo      BIT DEFAULT 1,
        createdAt   DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt   DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT fk_locations_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE
    );
    PRINT '✔ Tabla business_locations creada.'
END
GO

-- ── 3. ROLES (cargos personalizados) ──────────────────────────────
-- Los permisos se guardan como JSON en NVARCHAR(MAX)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'roles')
BEGIN
    CREATE TABLE roles (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        businessId  INT NOT NULL,
        nombre      NVARCHAR(80) NOT NULL,
        -- Ejemplo: {"stock":"editar","ventas":"ver","facturacion":"ninguno",...}
        permisos    NVARCHAR(MAX) NOT NULL
                    DEFAULT '{"stock":"ninguno","ventas":"ninguno","facturacion":"ninguno","empleados":"ninguno","dashboard":"ninguno","cotizaciones":"ninguno"}',
        createdAt   DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt   DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_roles_biz_nombre UNIQUE (businessId, nombre),
        CONSTRAINT fk_roles_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE
    );
    PRINT '✔ Tabla roles creada.'
END
GO

-- ── 3b. BUSINESS_CUITS (multi-CUIT por negocio, máx. 3) ──────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'business_cuits')
BEGIN
    CREATE TABLE business_cuits (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        businessId    INT NOT NULL,
        nombre        NVARCHAR(150) NOT NULL,
        cuit          NVARCHAR(20)  NOT NULL,
        condicionIva  NVARCHAR(60),
        domicilio     NVARCHAR(255),
        esPrincipal   BIT DEFAULT 0,
        createdAt     DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt     DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_bizcuits_biz_cuit UNIQUE (businessId, cuit),
        CONSTRAINT fk_bizcuits_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE
    );
    PRINT '✔ Tabla business_cuits creada.'
END
GO

-- ── 3b2. BUSINESS_ARCA_CONFIGS (config ARCA por CUIT del negocio) ─
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'business_arca_configs')
BEGIN
    CREATE TABLE business_arca_configs (
        id                    INT IDENTITY(1,1) PRIMARY KEY,
        businessId            INT NOT NULL,
        businessCuitId        INT NOT NULL,
        puntoVenta            INT,
        condicionIva          NVARCHAR(60),
        ambiente              NVARCHAR(20) DEFAULT 'homologacion',
        delegacionVerificada  BIT DEFAULT 0,
        ultimaVerificacion    DATETIME2,
        ultimoError           NVARCHAR(500),
        createdAt             DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt             DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_arcaconfig_cuit UNIQUE (businessCuitId),
        CONSTRAINT fk_arcaconfig_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE,
        CONSTRAINT fk_arcaconfig_cuit FOREIGN KEY (businessCuitId)
            REFERENCES business_cuits(id) ON DELETE NO ACTION
    );
    PRINT '✔ Tabla business_arca_configs creada.'
END
GO

-- ── 3c. VARIANT_TYPES (variantes maestras por negocio) ───────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'variant_types')
BEGIN
    CREATE TABLE variant_types (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        businessId  INT NOT NULL,
        nombre      NVARCHAR(80) NOT NULL,
        valores     NVARCHAR(MAX) NOT NULL DEFAULT '[]',
        createdAt   DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt   DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_vartypes_biz_nombre UNIQUE (businessId, nombre),
        CONSTRAINT fk_vartypes_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE
    );
    PRINT '✔ Tabla variant_types creada.'
END
GO

-- ── 4. EMPLOYEES ──────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'employees')
BEGIN
    CREATE TABLE employees (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        businessId      INT NOT NULL,
        locationId      INT,
        roleId          INT,
        dni             NVARCHAR(20)  NOT NULL,
        nombre          NVARCHAR(100) NOT NULL,
        apellido        NVARCHAR(100) NOT NULL,
        telefono        NVARCHAR(30),
        email           NVARCHAR(150) NOT NULL,
        passwordHash    NVARCHAR(255),
        activo          BIT DEFAULT 1,
        ultimaConexion  DATETIME2,
        createdAt       DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt       DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_employees_email UNIQUE (businessId, email),
        CONSTRAINT fk_employees_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE,
        CONSTRAINT fk_employees_location FOREIGN KEY (locationId)
            REFERENCES business_locations(id) ON DELETE NO ACTION,
        CONSTRAINT fk_employees_role FOREIGN KEY (roleId)
            REFERENCES roles(id) ON DELETE NO ACTION
    );
    PRINT '✔ Tabla employees creada.'
END
GO

-- ── 4b. EMPLOYEE_SESSIONS (tracking de logins) ────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'employee_sessions')
BEGIN
    CREATE TABLE employee_sessions (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        employeeId  INT NOT NULL,
        ip          NVARCHAR(64),
        userAgent   NVARCHAR(500),
        loginAt     DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        lastSeenAt  DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT fk_empsess_employee FOREIGN KEY (employeeId)
            REFERENCES employees(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_empsess_employee_seen ON employee_sessions(employeeId, lastSeenAt DESC);
    PRINT '✔ Tabla employee_sessions creada.'
END
GO

-- ── 5. CLIENTS ────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'clients')
BEGIN
    CREATE TABLE clients (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        businessId  INT NOT NULL,
        nombre      NVARCHAR(100) NOT NULL,
        apellido    NVARCHAR(100),
        email       NVARCHAR(150),
        telefono    NVARCHAR(30),
        whatsapp    NVARCHAR(30),
        cuit        NVARCHAR(20),
        dni         NVARCHAR(20),
        direccion   NVARCHAR(255),
        tipo        NVARCHAR(20) DEFAULT 'minorista', -- minorista|mayorista|empresa
        notas       NVARCHAR(MAX),
        createdAt   DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt   DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT fk_clients_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_clients_biz  ON clients(businessId);
    CREATE INDEX idx_clients_cuit ON clients(cuit);
    PRINT '✔ Tabla clients creada.'
END
GO

-- ── 6. PRODUCTS (producto padre) ──────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'products')
BEGIN
    CREATE TABLE products (
        id                 INT IDENTITY(1,1) PRIMARY KEY,
        businessId         INT NOT NULL,
        sku                NVARCHAR(80)   NOT NULL,
        skuAgrupador       NVARCHAR(80)   NOT NULL,
        titulo             NVARCHAR(200)  NOT NULL,
        descripcion        NVARCHAR(MAX),
        precioMinorista    DECIMAL(12,2)  NOT NULL DEFAULT 0,
        precioMayorista    DECIMAL(12,2)  NOT NULL DEFAULT 0,
        costo              DECIMAL(12,2)  NOT NULL DEFAULT 0,
        -- JSON con máx 2 dimensiones, máx 20 valores c/u
        -- Ej: {"color":["Rojo","Azul"],"talle":["S","M","L"]}
        variantes          NVARCHAR(MAX)  NOT NULL DEFAULT '{}',
        modelo             NVARCHAR(80),
        categoria          NVARCHAR(80),
        genero             NVARCHAR(40),
        activo             BIT DEFAULT 1,
        fechaActualizacion DATETIME2 DEFAULT SYSDATETIME(),
        createdAt          DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt          DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_products_sku UNIQUE (sku),
        CONSTRAINT fk_products_business FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_products_biz   ON products(businessId);
    CREATE INDEX idx_products_agrup ON products(skuAgrupador);
    PRINT '✔ Tabla products creada.'
END
GO

-- ── 7. PRODUCT_VARIANTS (producto hijo / variante) ─────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'product_variants')
BEGIN
    CREATE TABLE product_variants (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        productId        INT NOT NULL,
        sku              NVARCHAR(100) NOT NULL,
        variante1Nombre  NVARCHAR(40),  -- ej: "color"
        variante1Valor   NVARCHAR(80),  -- ej: "Negro"
        variante2Nombre  NVARCHAR(40),  -- ej: "talle"
        variante2Valor   NVARCHAR(80),  -- ej: "M"
        stock            INT NOT NULL DEFAULT 0,
        stockMinimo      INT NOT NULL DEFAULT 5,
        activo           BIT DEFAULT 1,
        createdAt        DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt        DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_variants_sku UNIQUE (sku),
        CONSTRAINT fk_variants_product FOREIGN KEY (productId)
            REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_variants_product ON product_variants(productId);
    PRINT '✔ Tabla product_variants creada.'
END
GO

-- ── 8. STOCK_MOVEMENTS ────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'stock_movements')
BEGIN
    CREATE TABLE stock_movements (
        id                INT IDENTITY(1,1) PRIMARY KEY,
        productVariantId  INT NOT NULL,
        locationId        INT,
        employeeId        INT,
        saleItemId        INT,
        -- ingreso | egreso | ajuste | devolucion
        tipo              NVARCHAR(20) NOT NULL,
        cantidad          INT NOT NULL,
        stockAnterior     INT NOT NULL,
        stockNuevo        INT NOT NULL,
        motivo            NVARCHAR(255),
        fechaMovimiento   DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT fk_sm_variant  FOREIGN KEY (productVariantId)
            REFERENCES product_variants(id) ON DELETE CASCADE,
        CONSTRAINT fk_sm_location FOREIGN KEY (locationId)
            REFERENCES business_locations(id) ON DELETE NO ACTION,
        CONSTRAINT fk_sm_employee FOREIGN KEY (employeeId)
            REFERENCES employees(id) ON DELETE NO ACTION
    );
    CREATE INDEX idx_sm_variant  ON stock_movements(productVariantId);
    CREATE INDEX idx_sm_employee ON stock_movements(employeeId);
    CREATE INDEX idx_sm_fecha    ON stock_movements(fechaMovimiento);
    PRINT '✔ Tabla stock_movements creada.'
END
GO

-- ── 9. SALES (ventas y cotizaciones) ─────────────────────────────
-- Número formato: V-YYYY-MM-XXXXXX | COT-YYYY-MM-XXXXXX
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'sales')
BEGIN
    CREATE TABLE sales (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        businessId    INT NOT NULL,
        locationId    INT,
        employeeId    INT,
        clientId      INT,
        numero        NVARCHAR(25)   NOT NULL,
        tipo          NVARCHAR(15)   NOT NULL DEFAULT 'venta',    -- venta|cotizacion
        estado        NVARCHAR(15)   NOT NULL DEFAULT 'pendiente', -- pendiente|pagado|cancelado|vencida
        esMayorista   BIT DEFAULT 0,
        subtotal      DECIMAL(12,2)  DEFAULT 0,
        descuentoPct  DECIMAL(5,2)   DEFAULT 0,
        descuento     DECIMAL(12,2)  DEFAULT 0,
        total         DECIMAL(12,2)  DEFAULT 0,
        medioPago     NVARCHAR(60),
        notas         NVARCHAR(MAX),
        cotizacionId  INT,
        fecha         DATE NOT NULL,
        createdAt     DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt     DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_sales_biz_numero UNIQUE (businessId, numero),
        CONSTRAINT fk_sales_business  FOREIGN KEY (businessId)
            REFERENCES businesses(id) ON DELETE CASCADE,
        CONSTRAINT fk_sales_location  FOREIGN KEY (locationId)
            REFERENCES business_locations(id) ON DELETE NO ACTION,
        CONSTRAINT fk_sales_employee  FOREIGN KEY (employeeId)
            REFERENCES employees(id) ON DELETE NO ACTION,
        CONSTRAINT fk_sales_client    FOREIGN KEY (clientId)
            REFERENCES clients(id)   ON DELETE NO ACTION
    );
    CREATE INDEX idx_sales_biz    ON sales(businessId);
    CREATE INDEX idx_sales_client ON sales(clientId);
    CREATE INDEX idx_sales_fecha  ON sales(fecha);
    PRINT '✔ Tabla sales creada.'
END
GO

-- ── 10. SALE_ITEMS ────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'sale_items')
BEGIN
    CREATE TABLE sale_items (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        saleId           INT NOT NULL,
        productVariantId INT,
        titulo           NVARCHAR(200) NOT NULL,
        sku              NVARCHAR(100) NOT NULL,
        skuAgrupador     NVARCHAR(80),
        variante1Nombre  NVARCHAR(40),
        variante1Valor   NVARCHAR(80),
        variante2Nombre  NVARCHAR(40),
        variante2Valor   NVARCHAR(80),
        cantidad         INT           NOT NULL,
        precioUnitario   DECIMAL(12,2) NOT NULL,
        subtotal         DECIMAL(12,2) NOT NULL,
        esMayorista      BIT DEFAULT 0,
        CONSTRAINT fk_saleitems_sale FOREIGN KEY (saleId)
            REFERENCES sales(id) ON DELETE CASCADE,
        CONSTRAINT fk_saleitems_variant FOREIGN KEY (productVariantId)
            REFERENCES product_variants(id) ON DELETE NO ACTION
    );
    PRINT '✔ Tabla sale_items creada.'
END
GO

-- ── 11. INVOICES (facturas ARCA) ──────────────────────────────────
-- Número formato: YYYY-MM-XXXXXX (correlativo mensual por negocio)
-- fechaEmision guarda fecha y hora completa de la emisión
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'invoices')
BEGIN
    CREATE TABLE invoices (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        businessId       INT NOT NULL,
        saleId           INT NOT NULL,
        clientId         INT,
        employeeId       INT,
        numero           NVARCHAR(25)  NOT NULL,
        tipo             NVARCHAR(5)   NOT NULL DEFAULT 'B',  -- A|B|C
        clienteNombre    NVARCHAR(200) NOT NULL,
        clienteCuit      NVARCHAR(20),
        clienteEmail     NVARCHAR(150),
        clienteDireccion NVARCHAR(255),
        subtotal         DECIMAL(12,2) NOT NULL,
        iva              DECIMAL(12,2) DEFAULT 0,
        total            DECIMAL(12,2) NOT NULL,
        esMayorista      BIT DEFAULT 0,
        cae              NVARCHAR(20),
        caeVencimiento   DATE,
        arcaRespuesta    NVARCHAR(MAX), -- JSON respuesta ARCA
        businessCuitId   INT,           -- CUIT emisor (business_cuits.id)
        emisorCuit       NVARCHAR(20),  -- snapshot del CUIT emisor
        emisorNombre     NVARCHAR(150), -- snapshot del nombre emisor
        pdfPath          NVARCHAR(255),
        fechaEmision     DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        estado           NVARCHAR(15) DEFAULT 'emitida', -- emitida|anulada|error
        notas            NVARCHAR(MAX),
        createdAt        DATETIME2 DEFAULT SYSDATETIME(),
        updatedAt        DATETIME2 DEFAULT SYSDATETIME(),
        CONSTRAINT uq_invoices_biz_numero UNIQUE (businessId, numero),
        CONSTRAINT uq_invoices_sale   UNIQUE (saleId),
        CONSTRAINT fk_invoices_business  FOREIGN KEY (businessId)
            REFERENCES businesses(id)  ON DELETE CASCADE,
        CONSTRAINT fk_invoices_sale      FOREIGN KEY (saleId)
            REFERENCES sales(id)        ON DELETE NO ACTION,
        CONSTRAINT fk_invoices_client    FOREIGN KEY (clientId)
            REFERENCES clients(id)      ON DELETE NO ACTION,
        CONSTRAINT fk_invoices_employee  FOREIGN KEY (employeeId)
            REFERENCES employees(id)    ON DELETE NO ACTION
    );
    CREATE INDEX idx_invoices_biz   ON invoices(businessId);
    CREATE INDEX idx_invoices_fecha ON invoices(fechaEmision);
    PRINT '✔ Tabla invoices creada.'
END
GO

-- ── 12. INVOICE_ITEMS ─────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'invoice_items')
BEGIN
    CREATE TABLE invoice_items (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        invoiceId        INT NOT NULL,
        titulo           NVARCHAR(200) NOT NULL,
        sku              NVARCHAR(100) NOT NULL,
        skuAgrupador     NVARCHAR(80),
        variante1Nombre  NVARCHAR(40),
        variante1Valor   NVARCHAR(80),
        variante2Nombre  NVARCHAR(40),
        variante2Valor   NVARCHAR(80),
        cantidad         INT           NOT NULL,
        esMayorista      BIT DEFAULT 0,
        precioUnitario   DECIMAL(12,2) NOT NULL,
        subtotal         DECIMAL(12,2) NOT NULL,
        CONSTRAINT fk_invoiceitems_invoice FOREIGN KEY (invoiceId)
            REFERENCES invoices(id) ON DELETE CASCADE
    );
    PRINT '✔ Tabla invoice_items creada.'
END
GO

PRINT ''
PRINT '✔ Schema Stocker instalado correctamente en SQL Server 2025.'
PRINT '  Tablas: businesses, business_locations, roles, employees, clients,'
PRINT '          products, product_variants, stock_movements,'
PRINT '          sales, sale_items, invoices, invoice_items'
GO
