export interface DteCompletoJson {
  identificacion: any;
  emisor: any;
  receptor: any;
  documentoRelacionado?: any;
  otrosDocumentos?: any;
  ventaTercero?: any;
  cuerpoDocumento: any[];
  resumen: any;
  extension?: any;
  apendice?: any;
  firmaElectronica?: string | null;
  selloRecibido?: string | null;
}

/**
 * Genera la estructura JSON completa del DTE firmado y procesado por el MH,
 * lista para ser guardada como {codigoGeneracion}.json o enviada por correo.
 */
export function generarJsonDteCompleto(
  jsonEnviado: any,
  firmaElectronica: string | null,
  selloRecibido: string | null
): DteCompletoJson {
  return {
    ...jsonEnviado,
    firmaElectronica: firmaElectronica || jsonEnviado?.firmaElectronica || null,
    selloRecibido: selloRecibido || jsonEnviado?.selloRecibido || null
  };
}
