-- ==========================================================
-- SCRIPT DE CREACIÓN DE BASE DE DATOS - FACTSV
-- Base de Datos: factsv
-- Motor: PostgreSQL
-- ==========================================================

-- 1. Tabla de Emisores (Tus empresas / sucursales)
CREATE TABLE IF NOT EXISTS emisores (
    id SERIAL PRIMARY KEY,
    nit VARCHAR(14) NOT NULL UNIQUE,
    nrc VARCHAR(10),
    nombre_comercial VARCHAR(150),
    razon_social VARCHAR(150),
    cod_actividad VARCHAR(6),
    desc_actividad VARCHAR(150),
    cod_establecimiento_mh VARCHAR(4) DEFAULT '0000',
    cod_punto_venta_mh VARCHAR(4) DEFAULT '0000',
    direccion JSONB,
    telefono VARCHAR(20),
    correo VARCHAR(100),
    password VARCHAR(255), -- Contraseña para ingresar al sistema
    pwd_mh VARCHAR(255), -- Contraseña API MH
    pwd_firmador VARCHAR(255), -- Contraseña de la llave privada
    dtes_visibles JSONB DEFAULT '["01", "03", "11", "04", "05", "06", "07", "08", "09", "14", "15"]', -- DTEs habilitados para el emisor
    ambiente VARCHAR(2) DEFAULT '00', -- Ambiente '00' (Pruebas) o '01' (Producción)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabla de Clientes (Receptores)
CREATE TABLE IF NOT EXISTS clientes (
    id SERIAL PRIMARY KEY,
    emisor_id INTEGER REFERENCES emisores(id),
    tipo_documento VARCHAR(2) NOT NULL, -- 13 (DUI), 36 (NIT), etc.
    num_documento VARCHAR(20) NOT NULL,
    nrc VARCHAR(10),
    nombre VARCHAR(200) NOT NULL,
    nombre_comercial VARCHAR(150),
    cod_actividad VARCHAR(6),
    desc_actividad VARCHAR(150),
    correo VARCHAR(100),
    telefono VARCHAR(20),
    direccion JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(emisor_id, num_documento)
);

-- 3. Tabla de Catálogos (Valores del MH)
CREATE TABLE IF NOT EXISTS catalogos_mh (
    id SERIAL PRIMARY KEY,
    tipo_catalogo VARCHAR(50) NOT NULL, -- ej. 'TIPO_DTE', 'MUNICIPIOS', 'TRIBUTOS'
    codigo VARCHAR(10) NOT NULL,
    valor VARCHAR(255) NOT NULL,
    activo BOOLEAN DEFAULT TRUE,
    UNIQUE(tipo_catalogo, codigo)
);

-- 4. Tabla de Documentos Emitidos (DTEs)
CREATE TABLE IF NOT EXISTS dtes_emitidos (
    id SERIAL PRIMARY KEY,
    emisor_id INTEGER REFERENCES emisores(id) NOT NULL,
    cliente_id INTEGER REFERENCES clientes(id),
    tipo_dte VARCHAR(2) NOT NULL, -- '01', '03', etc.
    codigo_generacion UUID NOT NULL UNIQUE,
    numero_control VARCHAR(31) NOT NULL UNIQUE,
    sello_recepcion_mh VARCHAR(40),
    estado VARCHAR(20) DEFAULT 'PROCESANDO', -- PROCESADO, RECHAZADO, CONTINGENCIA
    fecha_emision DATE NOT NULL,
    hora_emision TIME NOT NULL,
    monto_total_operacion DECIMAL(12, 2) NOT NULL,
    total_pagar DECIMAL(12, 2) NOT NULL,
    json_enviado JSONB, -- Documento completo firmado que se mandó
    respuesta_mh JSONB, -- Respuesta cruda del ministerio
    descripcion_rechazo TEXT, -- Razón/descripción del rechazo o fallo
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Tabla de Detalles del Documento (Items)
CREATE TABLE IF NOT EXISTS dte_items (
    id SERIAL PRIMARY KEY,
    dte_id INTEGER REFERENCES dtes_emitidos(id) ON DELETE CASCADE,
    num_item INTEGER NOT NULL,
    cantidad DECIMAL(10,2) NOT NULL,
    descripcion VARCHAR(255) NOT NULL,
    precio_unitario DECIMAL(10,2) NOT NULL,
    venta_gravada DECIMAL(10,2) DEFAULT 0,
    venta_exenta DECIMAL(10,2) DEFAULT 0,
    venta_nosujeta DECIMAL(10,2) DEFAULT 0,
    iva_item DECIMAL(10,2) DEFAULT 0,
    tributos JSONB -- Arreglo de tributos de este item (ej. [{"codigo": "20"}])
);

-- 6. Tabla de Configuraciones del Sistema
CREATE TABLE IF NOT EXISTS configuraciones_sistema (
    id SERIAL PRIMARY KEY,
    clave VARCHAR(50) UNIQUE NOT NULL,
    valor TEXT NOT NULL,
    descripcion VARCHAR(255)
);

-- ==========================================================
-- INSERCIÓN DE DATOS DE PRUEBA INICIALES
-- ==========================================================

-- Insertar configuraciones base recomendadas
INSERT INTO configuraciones_sistema (clave, valor, descripcion) 
VALUES
('MH_AMBIENTE', '00', '00 para Pruebas, 01 para Producción'),
('FIRMADOR_URL', 'http://localhost:8113/firmador/firmar', 'Endpoint del firmador local de Java')
ON CONFLICT (clave) DO NOTHING;
