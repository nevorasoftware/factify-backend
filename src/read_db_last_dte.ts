import prisma from './db/prisma';

async function run() {
  try {
    const lastDte = await prisma.dteEmitido.findFirst({
      where: { tipo_dte: '11' },
      orderBy: { created_at: 'desc' }
    });

    if (!lastDte) {
      console.log('No se encontraron DTEs de tipo 11.');
      return;
    }

    console.log('=== ULTIMO DTE 11 EMITIDO ===');
    console.log('ID:', lastDte.id);
    console.log('Codigo de Generacion:', lastDte.codigo_generacion);
    console.log('Numero de Control:', lastDte.numero_control);
    console.log('Estado:', lastDte.estado);
    console.log('Respuesta MH:', JSON.stringify(lastDte.respuesta_mh, null, 2));
    console.log('JSON Enviado:', JSON.stringify(lastDte.json_enviado, null, 2));
  } catch (error: any) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

run();
