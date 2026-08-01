import { construirDte01 } from './dte01';
import { construirDte03 } from './dte03';
import { construirDte04 } from './dte04';
import { construirDte05 } from './dte05';
import { construirDte06 } from './dte06';
import { construirDte07 } from './dte07';
import { construirDte08 } from './dte08';
import { construirDte09 } from './dte09';
import { construirDte11 } from './dte11';
import { construirDte14 } from './dte14';
import { construirDte15 } from './dte15';

export async function construirDte(req: any, tipoDte: string, versionDte: number, emisorDb: any): Promise<any> {
  console.log(`🛠️ [DTE BUILDER] Construyendo DTE tipo ${tipoDte} con arquitectura aislada para emisor ${emisorDb.nit}`);
  
  switch (tipoDte) {
    case '01':
      return construirDte01(req, versionDte, emisorDb);
    case '03':
      return construirDte03(req, versionDte, emisorDb);
    case '04':
      return construirDte04(req, versionDte, emisorDb);
    case '05':
      return construirDte05(req, versionDte, emisorDb);
    case '06':
      return construirDte06(req, versionDte, emisorDb);
    case '07':
      return construirDte07(req, versionDte, emisorDb);
    case '08':
      return construirDte08(req, versionDte, emisorDb);
    case '09':
      return construirDte09(req, versionDte, emisorDb);
    case '11':
      return construirDte11(req, versionDte, emisorDb);
    case '14':
      return construirDte14(req, versionDte, emisorDb);
    case '15':
      return construirDte15(req, versionDte, emisorDb);
    default:
      throw new Error(`Tipo de DTE "${tipoDte}" no soportado por el motor de construcción modular.`);
  }
}
