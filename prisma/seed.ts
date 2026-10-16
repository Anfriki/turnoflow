/**
 * Seed de demostración — Oficina de Atención al Ciudadano de un Ministerio.
 * Sedes, motivos de atención por Dirección, taquillas y funcionarios.
 * Es idempotente (upserts): se puede ejecutar varias veces.
 *
 *   npm run db:seed
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';

const prisma = new PrismaClient();

const DIR = {
  OAC: 'Oficina de Atención al Ciudadano',
  RRHH: 'Dirección General de Recursos Humanos',
  NOMINA: 'Dirección de Nómina y Pagos',
  SEGSOC: 'Dirección de Seguridad Social (Jubilaciones y Pensiones)',
  JURIDICA: 'Consultoría Jurídica',
  ARCHIVO: 'Coordinación de Archivo y Correspondencia',
};

interface ReasonSeed {
  code: string;
  name: string;
  department: string;
  prefixLetter: string;
  priorityLevel?: number;
  estimatedDurationMin: number;
  allowAppointments?: boolean;
  description?: string;
}

const REASONS: ReasonSeed[] = [
  { code: 'NOM-01', name: 'Reclamo de Nómina', department: DIR.NOMINA, prefixLetter: 'N', estimatedDurationMin: 15, description: 'Diferencias de pago, deducciones, bonos o retroactivos no cancelados.' },
  { code: 'NOM-02', name: 'Constancia de Trabajo', department: DIR.RRHH, prefixLetter: 'C', estimatedDurationMin: 8, description: 'Emisión de constancia de trabajo con o sin sueldo.' },
  { code: 'NOM-03', name: 'Recibos de Pago / ARC', department: DIR.NOMINA, prefixLetter: 'N', estimatedDurationMin: 8, description: 'Reimpresión de recibos de pago y planilla ARC.' },
  { code: 'JUB-01', name: 'Solicitud de Jubilación', department: DIR.SEGSOC, prefixLetter: 'J', estimatedDurationMin: 25, priorityLevel: 5, description: 'Inicio o seguimiento del expediente de jubilación.' },
  { code: 'JUB-02', name: 'Solicitud de Pensión (Incapacidad / Sobreviviente)', department: DIR.SEGSOC, prefixLetter: 'J', estimatedDurationMin: 25, priorityLevel: 5 },
  { code: 'RRHH-01', name: 'Actualización de Datos del Trabajador', department: DIR.RRHH, prefixLetter: 'R', estimatedDurationMin: 10 },
  { code: 'RRHH-02', name: 'Vacaciones, Permisos y Reposos', department: DIR.RRHH, prefixLetter: 'R', estimatedDurationMin: 10 },
  { code: 'DOC-01', name: 'Entrega de Documentos / Recaudos', department: DIR.ARCHIVO, prefixLetter: 'D', estimatedDurationMin: 6, description: 'Consignación de recaudos pendientes y correspondencia.' },
  { code: 'JUR-01', name: 'Asesoría Legal Laboral', department: DIR.JURIDICA, prefixLetter: 'L', estimatedDurationMin: 20 },
  { code: 'OAC-01', name: 'Consultas Generales', department: DIR.OAC, prefixLetter: 'G', estimatedDurationMin: 7, allowAppointments: false },
  { code: 'OAC-02', name: 'Denuncias, Quejas y Sugerencias', department: DIR.OAC, prefixLetter: 'Q', estimatedDurationMin: 15 },
];

const BRANCHES = [
  {
    code: 'SEDE',
    name: 'Sede Central',
    address: 'Av. Principal, Torre Ministerial, PB',
    reasons: REASONS.map((r) => r.code),
    desks: [
      { number: 1, serves: ['NOM-01', 'NOM-02', 'NOM-03'] },
      { number: 2, serves: ['NOM-01', 'NOM-02', 'NOM-03'] },
      { number: 3, serves: ['JUB-01', 'JUB-02'] },
      { number: 4, serves: ['RRHH-01', 'RRHH-02', 'NOM-02'] },
      { number: 5, serves: ['DOC-01', 'OAC-01', 'OAC-02'] },
      { number: 6, serves: ['JUR-01', 'OAC-02'] },
      { number: 7, serves: [] }, // sin motivos asignados = atiende todos
    ],
  },
  {
    code: 'REGIONAL',
    name: 'Oficina Regional',
    address: 'Calle 10 con Av. 5, Edif. Gobernación',
    reasons: ['NOM-01', 'NOM-02', 'JUB-01', 'DOC-01', 'OAC-01'],
    desks: [
      { number: 1, serves: [] },
      { number: 2, serves: [] },
    ],
  },
];

const USERS: { name: string; email: string; password: string; role: Role; branch: string | null }[] = [
  { name: 'Administrador del Sistema', email: 'admin@ministerio.local', password: 'Admin123!', role: 'ADMIN', branch: null },
  { name: 'Lcda. Yolanda Bermúdez', email: 'supervisor@ministerio.local', password: 'Super123!', role: 'SUPERVISOR', branch: 'SEDE' },
  { name: 'María Fernanda Rivas', email: 'taquilla1@ministerio.local', password: 'Taquilla123!', role: 'OPERATOR', branch: 'SEDE' },
  { name: 'José Luis Pacheco', email: 'taquilla2@ministerio.local', password: 'Taquilla123!', role: 'OPERATOR', branch: 'SEDE' },
  { name: 'Carmen Rosa Linares', email: 'taquilla3@ministerio.local', password: 'Taquilla123!', role: 'OPERATOR', branch: 'SEDE' },
  { name: 'Pedro Antonio Salazar', email: 'taquilla4@ministerio.local', password: 'Taquilla123!', role: 'OPERATOR', branch: 'SEDE' },
  { name: 'Luisa Elena Quintero', email: 'regional@ministerio.local', password: 'Taquilla123!', role: 'OPERATOR', branch: 'REGIONAL' },
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

    const reasonIds = new Map<string, string>();
    for (const code of b.reasons) {
      const { code: _c, ...r } = REASONS.find((x) => x.code === code)!;
      const reason = await prisma.attentionReason.upsert({
        where: { branchId_code: { branchId: branch.id, code } },
        update: r,
        create: { ...r, code, branchId: branch.id },
      });
      reasonIds.set(code, reason.id);
    }

    for (const d of b.desks) {
      const identifier = `Taquilla ${String(d.number).padStart(2, '0')}`;
      const desk = await prisma.desk.upsert({
        where: { branchId_number: { branchId: branch.id, number: d.number } },
        update: { identifier },
        create: { branchId: branch.id, number: d.number, identifier },
      });
      await prisma.deskReason.deleteMany({ where: { deskId: desk.id } });
      await prisma.deskReason.createMany({ data: d.serves.map((code) => ({ deskId: desk.id, reasonId: reasonIds.get(code)! })) });
    }
    console.log(`✔ ${b.name} (${b.code}): ${b.reasons.length} motivos, ${b.desks.length} taquillas`);
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
  console.log('✔ Funcionarios de prueba:');
  console.table(USERS.map(({ email, password, role, branch }) => ({ email, password, role, sede: branch ?? '(todas)' })));
  console.log('ℹ Cédulas de prueba del servicio simulado: V-12345678, V-87654321, V-5123456, E-84123456, J-123456789');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
