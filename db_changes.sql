-- Script para agregar lo faltante a la base de datos (Productos e Inventario, y Compras)

-- Crear tabla de productos/servicios
CREATE TABLE IF NOT EXISTS productos (
    id SERIAL PRIMARY KEY,
    emisor_id INTEGER NOT NULL REFERENCES emisores(id) ON DELETE CASCADE,
    codigo VARCHAR(50) NOT NULL,
    descripcion VARCHAR(255) NOT NULL,
    precio_unitario NUMERIC(10, 2) NOT NULL,
    tipo_item INTEGER NOT NULL DEFAULT 1,
    uni_medida INTEGER NOT NULL DEFAULT 59,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_emisor_producto_codigo UNIQUE (emisor_id, codigo)
);

-- Crear tabla de compras
CREATE TABLE IF NOT EXISTS compras (
    id SERIAL PRIMARY KEY,
    emisor_id INTEGER NOT NULL REFERENCES emisores(id) ON DELETE CASCADE,
    proveedor_nombre VARCHAR(200) NOT NULL,
    proveedor_documento VARCHAR(20) NOT NULL,
    tipo_documento VARCHAR(2) NOT NULL,
    numero_documento VARCHAR(50) NOT NULL,
    fecha_compra DATE NOT NULL,
    monto_total NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla de ítems de compras
CREATE TABLE IF NOT EXISTS compra_items (
    id SERIAL PRIMARY KEY,
    compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    descripcion VARCHAR(255) NOT NULL,
    cantidad NUMERIC(10, 2) NOT NULL,
    precio_unitario NUMERIC(10, 2) NOT NULL,
    total NUMERIC(10, 2) NOT NULL
);
