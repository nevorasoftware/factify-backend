import { montoEnLetras } from '../utils/letras';
import { round2, emisorV2, identificacionV2, lineasBase, pagosV2, receptorConDocumento, redondear, textoONull, validarYNumerar } from './v2';

// El comprador emite el documento por lo que adquiere de un proveedor sin registro de IVA.
export async function construirDte14(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const lineas = lineasBase(cuerpoDocumento).map((l: any) => ({
    numItem: l.numItem,
    tipoItem: l.tipoItem,
    cantidad: l.cantidad,
    codigo: l.codigo,
    uniMedida: l.uniMedida,
    descripcion: l.descripcion,
    precioUni: l.precioUni,
    montoDescu: l.montoDescu,
    compra: redondear(l.ventaGravada + l.ventaExenta + l.ventaNoSuj, 8)
  }));

  const totalCompra = round2(lineas.reduce((a: number, l: any) => a + l.compra, 0));
  const totalDescu = round2(lineas.reduce((a: number, l: any) => a + l.montoDescu, 0));
  const reteRenta = round2(Number(resumen?.reteRenta) || 0);
  const totalPagar = round2(totalCompra - reteRenta);

  const { nombreComercial, ...emisor } = emisorV2(emisorDb);
  const { nrc, nombreComercial: _comercial, ...sujeto } = receptorConDocumento(receptor, { direccionRequerida: true });

  const documento = {
    identificacion: identificacionV2(req, '14', versionDte, emisorDb),
    emisor,
    receptor: sujeto,
    cuerpoDocumento: lineas,
    resumen: {
      totalCompra,
      descu: 0,
      totalDescu,
      subTotal: totalCompra,
      reteRenta,
      totalPagar,
      totalLetras: montoEnLetras(totalPagar),
      condicionOperacion: Number(resumen?.condicionOperacion) || 1,
      pagos: pagosV2(resumen, totalPagar),
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '14', emisorDb);
}
