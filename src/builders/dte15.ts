import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo, obtenerIdentificacionBase } from './common';

export async function construirDte15(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen, otrosDocumentos } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  const codEstable = String(emisorSanitized.codEstableMH || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorSanitized.codPuntoVentaMH || "0000").trim().padStart(4, '0');

  // 1. Sanear Donatario (Emisor)
  const donatarioSanitized = {
    tipoDocumento: "36", // NIT
    numDocumento: emisorSanitized.nit.replace(/-/g, ''),
    nrc: emisorSanitized.nrc,
    nombre: emisorSanitized.nombre,
    codActividad: emisorSanitized.codActividad,
    descActividad: emisorSanitized.descActividad,
    nombreComercial: emisorSanitized.nombreComercial,
    tipoEstablecimiento: "01",
    direccion: emisorSanitized.direccion,
    telefono: emisorSanitized.telefono,
    correo: emisorSanitized.correo,
    codEstableMH: codEstable,
    codEstable: codEstable,
    codPuntoVentaMH: codPunto,
    codPuntoVenta: codPunto
  };

  // 2. Sanear Donante (Receptor)
  const donanteSanitized = {
    tipoDocumento: receptor?.tipoDocumento || "36",
    numDocumento: String(receptor?.numDocumento || receptor?.nit || "00000000000000").toUpperCase().trim(),
    nrc: receptor?.nrc || null,
    nombre: receptor?.nombre || "Donante Anonimo",
    codActividad: receptor?.codActividad || "99999",
    descActividad: receptor?.descActividad || "Donacion voluntaria",
    direccion: receptor?.direccion || { departamento: "01", municipio: "01", complemento: "San Salvador, El Salvador" },
    telefono: receptor?.telefono || "22222222",
    correo: receptor?.correo || "donante@ejemplo.com",
    codDomiciliado: receptor?.codDomiciliado ? Number(receptor.codDomiciliado) : 1,
    codPais: (() => {
      const rawPais = String(receptor?.codPais || receptor?.pais || "9300").trim().toUpperCase();
      if (rawPais === 'SLV' || rawPais === 'SV' || rawPais === 'EL SALVADOR') return '9300';
      return rawPais;
    })()
  };

  // 3. Sanear Cuerpo Documento
  const cuerpoSanitized = cuerpoDocumento.map((item: any, idx: number) => {
    const valorUni = round2(item.valorUni || item.precioUni || item.valorDonacion || item.precioUnitario || 0);
    const cantidad = Number(item.cantidad || 1);
    const valor = round2(cantidad * valorUni);

    return {
      numItem: idx + 1,
      tipoDonacion: item.tipoDonacion ? Number(item.tipoDonacion) : 1, // 1 - Efectivo, 2 - Especie, 3 - Servicios
      cantidad: cantidad,
      codigo: item.codigo || `DON-${idx + 1}`,
      uniMedida: (() => {
        const rawUm = Number(item.uniMedida || 59);
        return rawUm === 99 ? 59 : rawUm;
      })(),
      descripcion: item.descripcion || "Donacion Recibida",
      valorUni: valorUni,
      valor: valor,
      depreciacion: round2(item.depreciacion || 0)
    };
  });

  // 4. Sanear Resumen
  const valorTotal = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.valor || 0), 0));

  const resumenSanitized = {
    valorTotal,
    totalLetras: resumen?.totalLetras || resumen?.valorTotalLetras || "CERO DOLARES",
    pagos: (resumen?.pagos && resumen.pagos.length > 0) ? resumen.pagos.map((p: any) => {
      const pObj: any = {
        codigo: p.codigo || "01",
        montoPago: round2(p.montoPago || valorTotal)
      };
      if (p.referencia !== undefined && p.referencia !== null) {
        pObj.referencia = p.referencia;
      }
      return pObj;
    }) : [{ codigo: "01", montoPago: valorTotal }]
  };

  // 5. Secuencial de Control
  let { numControl, needsGeneration } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '15',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('15', emisorDb.id, codEstable, codPunto, 1);
  }

  const codGeneracion = req.body.identificacion?.codigoGeneracion
    ? req.body.identificacion.codigoGeneracion.toUpperCase()
    : uuidv4().toUpperCase();

  const identificacionSanitized = obtenerIdentificacionBase(
    req.body.identificacion || {},
    '15',
    numControl,
    codGeneracion,
    fecEmi,
    horEmi,
    emisorDb
  );
  // delete contingency fields since they are not allowed in DTE 15 identificacion
  delete (identificacionSanitized as any).tipoContingencia;
  delete (identificacionSanitized as any).motivoContin;

  const otrosDocumentosSanitized = (otrosDocumentos && otrosDocumentos.length > 0)
    ? otrosDocumentos.map((doc: any) => ({
        codDocAsociado: doc.codDocAsociado ? Number(doc.codDocAsociado) : 1,
        detalleDocumento: String(doc.detalleDocumento || doc.descDocumento || "Certificación de Donación")
      }))
    : null;

  const dteBase: any = {
    identificacion: identificacionSanitized,
    donatario: donatarioSanitized,
    donante: donanteSanitized,
    cuerpoDocumento: cuerpoSanitized,
    resumen: resumenSanitized,
    otrosDocumentos: otrosDocumentosSanitized,
    apendice: null
  };

  return dteBase;
}
