-- =========================================================================
-- SCRIPT DE SEEDING Y MANTENIMIENTO MULTI-TENANT (SaaS)
-- Facturación Electrónica El Salvador
-- =========================================================================

-- 1. Insertar Emisor / Tenant 1: Empresa de Pruebas Comercial
-- Configurada en Ambiente de Pruebas ('00')
-- Habilitada para: Factura (01), Crédito Fiscal (03) y Factura de Exportación (11)
INSERT INTO emisores (
    nit,
    nrc,
    razon_social,
    nombre_comercial,
    cod_actividad,
    desc_actividad,
    cod_establecimiento_mh,
    cod_punto_venta_mh,
    correo,
    password, -- Contraseña para logearse al frontend
    pwd_mh, -- Contraseña API Ministerio de Hacienda
    pwd_firmador, -- Contraseña de la Llave Privada del Firmador
    ambiente, -- '00' para Pruebas, '01' para Producción
    dtes_visibles, -- Tipos de DTE visibles en formato JSON array
    direccion
) VALUES (
    '0614-100890-101-1',
    '123456-7',
    'SERVICIOS COMERCIALES S.A. DE C.V.',
    'Servicios Comerciales El Salvador',
    '62010',
    'Servicios de programación informática',
    '0000',
    '0001',
    'comercial@empresa1.com',
    'admin123', -- Contraseña de acceso
    'ApiPasswordMH_123_Test', -- Reemplazar por contraseña API MH
    'FirmadorPassword_123_Test', -- Reemplazar por contraseña de llave privada
    '00', -- Ambiente de Pruebas
    '["01", "03", "11"]', -- DTEs habilitados
    '{"departamento": "06", "municipio": "14", "complemento": "Calle El Mirador, Galerías Escalón, San Salvador"}'::jsonb
) ON CONFLICT (nit) DO UPDATE SET 
    correo = EXCLUDED.correo,
    password = EXCLUDED.password,
    dtes_visibles = EXCLUDED.dtes_visibles,
    ambiente = EXCLUDED.ambiente;

-- 2. Insertar Emisor / Tenant 2: Empresa de Exportaciones y Servicios Médicos
-- Habilitada para: Factura (01), Crédito Fiscal (03), Exportación (11) y Sujeto Excluido (14)
INSERT INTO emisores (
    nit,
    nrc,
    razon_social,
    nombre_comercial,
    cod_actividad,
    desc_actividad,
    cod_establecimiento_mh,
    cod_punto_venta_mh,
    correo,
    password,
    pwd_mh,
    pwd_firmador,
    ambiente,
    dtes_visibles,
    direccion
) VALUES (
    '0511-150285-102-2',
    '765432-1',
    'EXPORTACIONES GLOBALES Y SALUD S.A.',
    'Global Exports El Salvador',
    '86100',
    'Actividades de hospitales',
    '0001',
    '0002',
    'salud@empresa2.com',
    'salud123',
    'ApiPasswordMH_456_Test',
    'FirmadorPassword_456_Test',
    '00', -- Ambiente de Pruebas
    '["01", "03", "11", "14"]', -- DTEs habilitados
    '{"departamento": "05", "municipio": "01", "complemento": "Avenida Masferrer Norte, Redondel Luceiro, San Salvador"}'::jsonb
) ON CONFLICT (nit) DO UPDATE SET 
    correo = EXCLUDED.correo,
    password = EXCLUDED.password,
    dtes_visibles = EXCLUDED.dtes_visibles,
    ambiente = EXCLUDED.ambiente;

-- =========================================================================
-- CONSULTAS DE APOYO PARA EL ADMINISTRADOR (VÍA SCRIPT SQL)
-- =========================================================================

-- Listar todos los tenants registrados y su estado actual
-- SELECT id, nit, razon_social, correo, ambiente, dtes_visibles FROM emisores;

-- Listar documentos emitidos agrupados por tenant/emisor
-- SELECT e.razon_social, d.tipo_dte, COUNT(*) as cantidad, SUM(d.total_pagar) as total_ventas 
-- FROM dtes_emitidos d
-- JOIN emisores e ON d.emisor_id = e.id
-- GROUP BY e.razon_social, d.tipo_dte;
