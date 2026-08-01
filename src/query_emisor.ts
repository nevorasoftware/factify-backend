import prisma from './db/prisma';

async function main() {
  const emisores = await prisma.emisor.findMany();
  console.log('EMISORES_RESULT:', JSON.stringify(emisores.map(e => ({
    id: e.id,
    nit: e.nit,
    correo: e.correo,
    password: e.password,
    ambiente: e.ambiente,
    razon_social: e.razon_social
  })), null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
