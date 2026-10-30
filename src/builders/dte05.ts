import { construirNota } from './notas';

export async function construirDte05(req: any, versionDte: number, emisorDb: any) {
  return construirNota(req, '05', versionDte, emisorDb);
}
