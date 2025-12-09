import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Admin default
  const username = 'admin';
  const password = 'Admin123!';
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await prisma.user.findFirst({ where: { username } });
  if (!existing) {
    await prisma.user.create({ data: { username, passwordHash, role: 'admin' } });
    console.log(`Usuario admin creado: ${username} / ${password}`);
  } else {
    console.log('Usuario admin ya existe');
  }

  // Test user
  const testUsername = 'tester';
  const testPassword = 'Tester123!';
  const testHash = await bcrypt.hash(testPassword, 10);
  const tester = await prisma.user.findFirst({ where: { username: testUsername } });
  if (!tester) {
    await prisma.user.create({ data: { username: testUsername, passwordHash: testHash, role: 'user' } });
    console.log(`Usuario prueba creado: ${testUsername} / ${testPassword}`);
  } else {
    console.log('Usuario prueba ya existe');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
