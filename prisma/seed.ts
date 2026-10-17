/**
 * Seed — Ministerio del Poder Popular para la Educación (MPPE)
 * Catálogo real de trámites según "PROCESOS POR DIRECCION.xlsx":
 * 7 Direcciones, 38 trámites, 2 dependencias (Zona Educativa / Atención
 * al Ciudadano) y 12 taquillas especializadas.
 *
 * Es idempotente (upserts): se puede ejecutar varias veces. Los motivos de
 * una sede que no estén en el catálogo se DESACTIVAN (se conserva el histórico).
 *
 *   npm run db:seed
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';

const prisma = new PrismaClient();

// ── Dependencias (paso 2 del tótem) ─────────────────────────────
const DEPENDENCIES = {
  ZE: {
    code: 'ZE',
    name: 'Zona Educativa (Caracas / Distrito Capital)',
    description: 'Personal docente, administrativo u obrero con relación laboral en planteles de Caracas.',
    icon: '🏢',
    prefix: 'ZE',
    sortOrder: 1,
  },
  OAC: {
    code: 'OAC',
    name: 'Atención al Ciudadano (Nacional / Otros Estados)',
    description: 'Personal adscrito a estados del interior del país, usuarios externos o trámites generales.',
    icon: '🏛️',
    prefix: 'OAC',
    sortOrder: 2,
  },
} as const;
type DepCode = keyof typeof DEPENDENCIES;

// ── Direcciones y trámites (paso 3 del tótem) ───────────────────
const DIR = {
  ING: 'Ingreso',
  EGR: 'Egreso',
  NOM: 'Nómina',
  GRE: 'Gremiales',
  REG: 'Registro de Personal',
  JUR: 'Asesoría Jurídica',
  EST: 'Registro y Control de Estudio',
} as const;
type DirKey = keyof typeof DIR;

/** [código, nombre, minutos estimados, prioridad, descripción] — en el orden del documento. */
const CATALOG: Record<DirKey, [string, string, number, number?, string?][]> = {
  ING: [
    ['ING-01', 'Clasificación', 15],
    ['ING-02', 'Corrección o cambio de cuenta bancaria', 10],
    ['ING-03', 'Sinceración de personal', 15],
    ['ING-04', 'Traslado', 20],
    ['ING-05', 'Incremento de horas', 15],
    ['ING-06', 'Concentración de carga horaria', 15],
    ['ING-07', 'Regularización de cargo', 20],
    ['ING-08', 'Ingresos', 20],
    ['ING-09', 'Desafiliación de sindicatos', 10],
    ['ING-10', 'Corrección de datos', 10],
    ['ING-11', 'Prima por profesionalización', 15],
    ['ING-12', 'Prima geográfica', 15],
    ['ING-13', 'Prima por hijos', 10],
  ],
  EGR: [
    ['EGR-01', 'Solicitud de jubilación', 25, 10],
    ['EGR-02', 'Solicitud de pensión de sobreviviente', 25, 10],
    ['EGR-03', 'Solicitud de FP023', 15],
    ['EGR-04', 'Autorización al cobro', 15],
    ['EGR-05', 'Solicitud 14100', 15],
    ['EGR-06', 'Solicitud 1408', 15],
    ['EGR-07', 'Renuncia', 15],
    ['EGR-08', 'Egreso por fallecimiento', 20],
  ],
  NOM: [
    ['NOM-01', 'Consulta de estatus del personal', 8],
    ['NOM-02', 'Constancia de trabajo', 8],
    ['NOM-03', 'Recibo de pago', 6],
  ],
  GRE: [
    ['GRE-01', 'Reconocimiento de años privados y públicos', 15],
    ['GRE-02', 'Reactivación', 15],
    ['GRE-03', 'Permiso por cuido', 10],
    ['GRE-04', 'Permiso pre y post natal', 10],
    ['GRE-05', 'Permiso por fallecimiento', 10],
    ['GRE-06', 'Permiso por estudios', 10],
    ['GRE-07', 'Permiso por matrimonio', 10],
    ['GRE-08', 'Solicitud de salarios no cancelados', 15],
    ['GRE-09', 'Cambio de modalidad de pago', 10],
  ],
  REG: [['REG-01', 'Vacaciones', 10]],
  JUR: [['JUR-01', 'Consultas y asesoría jurídica laboral', 20]],
  EST: [
    ['EST-01', 'Legalización de título de bachiller', 10],
    ['EST-02', 'Legalización de notas certificadas', 10],
    ['EST-03', 'Solicitud de copia certificada del título (CCRT)', 10],
  ],
};

/** Taquilla → dependencias y Direcciones que atiende (listas vacías = todas). */
interface DeskSeed {
  number: number;
  deps: DepCode[];
  dirs: DirKey[];
}

const SEDE_DESKS: DeskSeed[] = [
  // 1–3 · Zona Educativa: Nómina, Ingreso y Personal (Caracas)
  ...[1, 2, 3].map((number) => ({ number, deps: ['ZE'] as DepCode[], dirs: ['NOM', 'ING', 'REG'] as DirKey[] })),
  // 4–5 · Zona Educativa: Gremiales, permisos y Asesoría Jurídica (Caracas)
  ...[4, 5].map((number) => ({ number, deps: ['ZE'] as DepCode[], dirs: ['GRE', 'JUR'] as DirKey[] })),
  // 6–8 · Atención al Ciudadano (nacional): Ingreso, estatus y reclamos de estados
  ...[6, 7, 8].map((number) => ({ number, deps: ['OAC'] as DepCode[], dirs: ['ING', 'NOM', 'GRE', 'REG', 'JUR'] as DirKey[] })),
  // 9–10 · Seguridad Social / Egreso (ambas dependencias)
  ...[9, 10].map((number) => ({ number, deps: [] as DepCode[], dirs: ['EGR'] as DirKey[] })),
  // 11 · Registro y Control de Estudio (ambas dependencias)
  { number: 11, deps: [], dirs: ['EST'] },
  // 12 · Universal polivalente: cualquier dependencia y trámite
  { number: 12, deps: [], dirs: [] },
];

const BRANCHES = [
  { code: 'SEDE', name: 'Sede Central', address: 'Caracas, Distrito Capital', deps: ['ZE', 'OAC'] as DepCode[], desks: SEDE_DESKS },
  {
    code: 'REGIONAL',
    name: 'Oficina Regional',
    address: 'Calle 10 con Av. 5, Edif. Gobernación',
    deps: ['OAC'] as DepCode[],
    desks: [
      { number: 1, deps: [], dirs: [] },
      { number: 2, deps: [], dirs: [] },
    ] as DeskSeed[],
  },
];

const OPERATOR_NAMES = [
  'María Fernanda Rivas', 'José Luis Pacheco', 'Carmen Rosa Linares', 'Pedro Antonio Salazar',
  'Yusmary Coromoto Torres', 'Luis Enrique Bolívar', 'Daniela Alejandra Mora', 'Jesús Rafael Contreras',
  'Andreína del Valle Pérez', 'Carlos Eduardo Ramírez', 'Mariela Josefina Ochoa', 'Ronald Javier Medina',
];

const USERS: { name: string; email: string; password: string; role: Role; branch: string | null }[] = [
  { name: 'Administrador del Sistema', email: 'admin@ministerio.local', password: 'Admin123!', role: 'ADMIN', branch: null },
  { name: 'Lcda. Yolanda Bermúdez', email: 'supervisor@ministerio.local', password: 'Super123!', role: 'SUPERVISOR', branch: 'SEDE' },
  ...OPERATOR_NAMES.map((name, i) => ({
    name,
    email: `taquilla${i + 1}@ministerio.local`,
    password: 'Taquilla123!',
    role: 'OPERATOR' as Role,
    branch: 'SEDE',
  })),
  { name: 'Luisa Elena Quintero', email: 'regional@ministerio.local', password: 'Taquilla123!', role: 'OPERATOR', branch: 'REGIONAL' },
];

async function main() {
  const branchIds = new Map<string, string>();
  let order = 0;
  const reasonsFlat = (Object.keys(CATALOG) as DirKey[]).flatMap((dir) =>
    CATALOG[dir].map(([code, name, minutes, priority = 0, description]) => ({
      dir,
      code,
      name,
      description: description ?? null,
      department: DIR[dir],
      prefixLetter: dir, // respaldo si una sede no usa dependencias
      priorityLevel: priority,
      estimatedDurationMin: minutes,
      allowAppointments: true,
      isActive: true,
      sortOrder: ++order,
    })),
  );

  for (const b of BRANCHES) {
    const branch = await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name, address: b.address },
      create: { code: b.code, name: b.name, address: b.address },
    });
    branchIds.set(b.code, branch.id);

    // Dependencias
    const depIds = new Map<DepCode, string>();
    for (const code of b.deps) {
      const { code: _c, ...d } = DEPENDENCIES[code];
      const dep = await prisma.dependency.upsert({
        where: { branchId_code: { branchId: branch.id, code } },
        update: { ...d, isActive: true },
        create: { ...d, code, branchId: branch.id },
      });
      depIds.set(code, dep.id);
    }

    // Catálogo de trámites
    const reasonIdsByDir = new Map<DirKey, string[]>();
    for (const { dir, ...r } of reasonsFlat) {
      const reason = await prisma.attentionReason.upsert({
        where: { branchId_code: { branchId: branch.id, code: r.code } },
        update: r,
        create: { ...r, branchId: branch.id },
      });
      reasonIdsByDir.set(dir, [...(reasonIdsByDir.get(dir) ?? []), reason.id]);
    }
    const deactivated = await prisma.attentionReason.updateMany({
      where: { branchId: branch.id, code: { notIn: reasonsFlat.map((r) => r.code) }, isActive: true },
      data: { isActive: false },
    });

    // Taquillas especializadas
    for (const d of b.desks) {
      const identifier = `Taquilla ${String(d.number).padStart(2, '0')}`;
      const desk = await prisma.desk.upsert({
        where: { branchId_number: { branchId: branch.id, number: d.number } },
        update: { identifier, isActive: true },
        create: { branchId: branch.id, number: d.number, identifier },
      });
      await prisma.deskReason.deleteMany({ where: { deskId: desk.id } });
      await prisma.deskReason.createMany({
        data: d.dirs.flatMap((dir) => reasonIdsByDir.get(dir)!).map((reasonId) => ({ deskId: desk.id, reasonId })),
      });
      await prisma.deskDependency.deleteMany({ where: { deskId: desk.id } });
      await prisma.deskDependency.createMany({
        data: d.deps.filter((c) => depIds.has(c)).map((c) => ({ deskId: desk.id, dependencyId: depIds.get(c)! })),
      });
    }
    // Taquillas que ya no forman parte de la distribución quedan inactivas
    await prisma.desk.updateMany({
      where: { branchId: branch.id, number: { notIn: b.desks.map((d) => d.number) } },
      data: { isActive: false },
    });

    console.log(
      `✔ ${b.name} (${b.code}): ${b.deps.length} dependencia(s), ${reasonsFlat.length} trámites en ${Object.keys(DIR).length} Direcciones, ` +
        `${b.desks.length} taquillas${deactivated.count ? ` · ${deactivated.count} motivos anteriores desactivados` : ''}`,
    );
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
  console.log('✔ Funcionarios: admin@ministerio.local (Admin123!), supervisor@ministerio.local (Super123!),');
  console.log('  taquilla1…taquilla12@ministerio.local (Taquilla123!), regional@ministerio.local (Taquilla123!)');
  console.log('ℹ Cédulas de prueba del servicio simulado: V-12345678, V-87654321, V-5123456, E-84123456');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
