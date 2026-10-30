import { construirNota } from './notas';

export async function construirDte06(req: any, versionDte: number, emisorDb: any) {
  return construirNota(req, '06', versionDte, emisorDb);
}
