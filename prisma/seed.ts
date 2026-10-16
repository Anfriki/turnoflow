/**
 * Seed de demostración: 2 sucursales, colas, boxes y usuarios.
 * Es idempotente (upserts): se puede ejecutar varias veces.
 *
 *   npm run db:seed
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';

const prisma = new PrismaClient();

const BRANCHES = [
  {
    code: 'CENTRAL',
    name: 'Casa Central',
    address: 'Av. Principal 1234',
    categories: [
      { prefixLetter: 'P', name: 'Atención Prioritaria', priorityLevel: 10, estimatedDurationMin: 8 },
      { prefixLetter: 'A', name: 'Cajas', priorityLevel: 0, estimatedDurationMin: 5 },
      { prefixLetter: 'C', name: 'Atención Comercial', priorityLevel: 0, estimatedDurationMin: 15 },
      { prefixLetter: 'R', name: 'Reclamos', priorityLevel: 0, estimatedDurationMin: 12 },
    ],
    desks: [
      { identifier: 'Box 1', serves: ['P', 'A'] },
      { identifier: 'Box 2', serves: ['A'] },
      { identifier: 'Box 3', serves: ['C', 'P'] },
      { identifier: 'Box 4', serves: ['R', 'C'] },
      { identifier: 'Box 5', serves: [] }, // vacío = atiende todas las colas
    ],
  },
  {
    code: 'NORTE',
    name: 'Sucursal Norte',
    address: 'Calle Norte 567',
    categories: [
      { prefixLetter: 'A', name: 'Cajas', priorityLevel: 0, estimatedDurationMin: 5 },
      { prefixLetter: 'C', name: 'Atención Comercial', priorityLevel: 0, estimatedDurationMin: 15 },
    ],
    desks: [
      { identifier: 'Ventanilla 1', serves: [] },
      { identifier: 'Ventanilla 2', serves: [] },
    ],
  },
];

const USERS: { name: string; email: string; password: string; role: Role; branch: string | null }[] = [
  { name: 'Administrador', email: 'admin@turnos.local', password: 'Admin123!', role: 'ADMIN', branch: null },
  { name: 'Sofía Supervisora', email: 'supervisor@turnos.local', password: 'Super123!', role: 'SUPERVISOR', branch: 'CENTRAL' },
  { name: 'Operador Uno', email: 'operador1@turnos.local', password: 'Operador123!', role: 'OPERATOR', branch: 'CENTRAL' },
  { name: 'Operador Dos', email: 'operador2@turnos.local', password: 'Operador123!', role: 'OPERATOR', branch: 'CENTRAL' },
  { name: 'Operador Tres', email: 'operador3@turnos.local', password: 'Operador123!', role: 'OPERATOR', branch: 'CENTRAL' },
  { name: 'Operador Norte', email: 'norte@turnos.local', password: 'Operador123!', role: 'OPERATOR', branch: 'NORTE' },
];

async function main() {
  const branchIds = new Map<string, string>();

  for (const b of BRANCHES) {
    const branch = await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name, address: b.address },
      create: { code: b.code, name: b.name, address: b.address },
    });
    branchIds.set(b.code, branch.id);

    const catIds = new Map<string, string>();
    for (const c of b.categories) {
      const cat = await prisma.serviceCategory.upsert({
        where: { branchId_prefixLetter: { branchId: branch.id, prefixLetter: c.prefixLetter } },
        update: { name: c.name, priorityLevel: c.priorityLevel, estimatedDurationMin: c.estimatedDurationMin },
        create: { ...c, branchId: branch.id },
      });
      catIds.set(c.prefixLetter, cat.id);
    }

    for (const d of b.desks) {
      const desk = await prisma.desk.upsert({
        where: { branchId_identifier: { branchId: branch.id, identifier: d.identifier } },
        update: {},
        create: { branchId: branch.id, identifier: d.identifier },
      });
      await prisma.deskCategory.deleteMany({ where: { deskId: desk.id } });
      await prisma.deskCategory.createMany({
        data: d.serves.map((p) => ({ deskId: desk.id, categoryId: catIds.get(p)! })),
      });
    }
    console.log(`✔ Sucursal ${b.code}: ${b.categories.length} colas, ${b.desks.length} boxes`);
  }

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: await bcrypt.hash(u.password, 12),
        branchId: u.branch ? branchIds.get(u.branch)! : null,
      },
    });
  }
  console.log('✔ Usuarios de prueba:');
  console.table(USERS.map(({ email, password, role, branch }) => ({ email, password, role, sucursal: branch ?? '(todas)' })));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
