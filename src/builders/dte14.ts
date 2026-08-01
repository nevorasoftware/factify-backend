import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo, obtenerIdentificacionBase } from './common';

export async function construirDte14(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  delete (emisorSanitized as any).tipoEstablecimiento;
  delete (emisorSanitized as any).nombreComercial;
  const codEstable = String(emisorDb.cod_establecimiento_mh || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorDb.cod_punto_venta_mh || "0000").trim().padStart(4, '0');

  // 1. Sanear Receptor
  let receptorSanitized: any = null;
  if (receptor && receptor.nombre) {
    const rawDoc = String(receptor.numDocumento || receptor.nit || "").replace(/[^0-9]/g, '');
    let tipoDoc = receptor.tipoDocumento;
    if (!tipoDoc) {
      tipoDoc = rawDoc.length === 9 ? "13" : "36";
    }

    receptorSanitized = {
      tipoDocumento: tipoDoc,
      numDocumento: rawDoc,
      nombre: receptor.nombre,
      codActividad: receptor.codActividad || null,
      descActividad: receptor.descActividad || null,
      direccion: receptor.direccion || null,
      telefono: receptor.telefono || null,
      correo: receptor.correo || null
    };
  } else {
    receptorSanitized = {
      tipoDocumento: "13",
      numDocumento: "000000000",
      nombre: "Consumidor Final",
      codActividad: null,
      descActividad: null,
      direccion: null,
      telefono: null,
      correo: null
    };
  }

  // 2. Sanear Cuerpo Documento
  const cuerpoSanitized = cuerpoDocumento.map((item: any, idx: number) => {
    const compra = round2(item.compra || item.ventaGravada || 0);

    return {
      numItem: idx + 1,
      tipoItem: item.tipoItem || 1,
      codigo: item.codigo || null,
      descripcion: item.descripcion || "Servicio/Compra",
      cantidad: Number(item.cantidad || 1),
      uniMedida: item.uniMedida || 59,
      precioUni: round2(item.precioUni || item.precioUnitario || 0),
      montoDescu: round2(item.montoDescu || 0),
      compra: compra
    };
  });

  // 3. Sanear Resumen
  const totalCompra = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.compra || 0), 0));
  const totalDescu = round2(resumen?.totalDescu || 0);
  const subTotal = round2(totalCompra - totalDescu);
  const reteRenta = round2(resumen?.reteRenta || 0);
  const totalPagar = round2(subTotal - reteRenta);

  const resumenSanitized = {
    totalCompra,
    descu: totalDescu,
    totalDescu,
    subTotal,
    reteRenta,
    ivaRete1: round2(resumen?.ivaRete1 || 0),
    totalPagar,
    totalLetras: resumen?.totalLetras || "CERO DOLARES",
    condicionOperacion: resumen?.condicionOperacion || 1,
    pagos: (resumen?.pagos && resumen.pagos.length > 0) ? resumen.pagos.map((p: any) => ({
      codigo: p.codigo || "01",
      montoPago: round2(p.montoPago || totalPagar),
      referencia: p.referencia || null,
      plazo: p.plazo || null,
      periodo: p.periodo || null
    })) : [{ codigo: "01", montoPago: totalPagar, referencia: null, plazo: null, periodo: null }],
    observaciones: resumen?.observaciones !== undefined && resumen?.observaciones !== null ? String(resumen.observaciones) : null
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '14',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('14', emisorDb.id, codEstable, codPunto, 1);
  }

  const codGeneracion = req.body.identificacion?.codigoGeneracion
    ? req.body.identificacion.codigoGeneracion.toUpperCase()
    : uuidv4().toUpperCase();

  const dteBase: any = {
    identificacion: obtenerIdentificacionBase(
      req.body.identificacion || {},
      '14',
      numControl,
      codGeneracion,
      fecEmi,
      horEmi,
      emisorDb
    ),
    emisor: emisorSanitized,
    sujetoExcluido: receptorSanitized,
    cuerpoDocumento: cuerpoSanitized,
    resumen: resumenSanitized,
    apendice: null
  };

  return dteBase;
}
