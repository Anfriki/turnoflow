/**
 * Prueba de concurrencia de "Llamar siguiente" contra un servidor en marcha.
 *
 *  1. Tres funcionarios toman las Taquillas 01, 02 y 03 (Zona Educativa: Nómina, Ingreso y Personal).
 *  2. Se emiten N turnos ZE de NOM-01 en paralelo, con cédulas distintas (prueba del correlativo atómico).
 *  3. Las tres taquillas llaman y finalizan turnos en paralelo, a máxima velocidad.
 *  4. Se verifica: ningún turno llamado dos veces y códigos sin duplicados.
 *
 *   npm run dev            (en otra terminal, con el seed cargado)
 *   npm run test:concurrency
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 40);

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const RESOLUTION = { resolutionStatus: 'RESUELTO', resolutionNotes: 'Prueba automatizada de concurrencia' };

async function main() {
  const branch = (
    await api<{ id: string; reasons: { id: string; code: string }[]; dependencies: { id: string; code: string }[] }>('GET', '/api/public/branches/SEDE')
  ).data;
  const ze = branch.dependencies.find((d) => d.code === 'ZE')!;
  const nomina = branch.reasons.find((r) => r.code === 'NOM-01')!;

  const ops = ['taquilla1', 'taquilla2', 'taquilla3'];
  const deskNumbers = [1, 2, 3];
  const sessions = await Promise.all(
    ops.map(async (op, i) => {
      const { data } = await api<{ token: string }>('POST', '/api/auth/login', { email: `${op}@ministerio.local`, password: 'Taquilla123!' });
      const desks = (await api<{ id: string; number: number }[]>('GET', '/api/operator/desks', undefined, data.token)).data;
      const desk = desks.find((d) => d.number === deskNumbers[i])!;
      const claim = await api('POST', `/api/operator/desks/${desk.id}/claim`, {}, data.token);
      if (claim.status !== 200) throw new Error(`${op} no pudo tomar la taquilla ${desk.number}: ${JSON.stringify(claim.data)}`);
      return { op, token: data.token, deskId: desk.id };
    }),
  );
  console.log(`✔ ${sessions.length} funcionarios en sus taquillas`);

  // Vaciar la cola previa para que la prueba sea determinista
  for (const s of sessions) {
    for (;;) {
      const r = await api<{ id: string }>('POST', `/api/operator/desks/${s.deskId}/call-next`, {}, s.token);
      if (r.status !== 200) break;
      await api('POST', `/api/operator/tickets/${r.data.id}/finish`, RESOLUTION, s.token);
    }
  }

  const base = 30_000_000 + Math.floor(Math.random() * 1_000_000) * 100;
  const issued = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api<{ id: string; code: string; message?: string }>('POST', '/api/public/tickets', {
        branchId: branch.id,
        reasonId: nomina.id,
        dependencyId: ze.id,
        idOrigin: 'V',
        idNumber: String(base + i),
        citizenName: `Ciudadano Prueba ${i + 1}`,
      }),
    ),
  );
  const failed = issued.filter((r) => r.status !== 201);
  if (failed.length) throw new Error(`❌ ${failed.length} emisiones fallaron: ${failed[0].data.message}`);
  const codes = issued.map((r) => r.data.code).sort();
  if (new Set(codes).size !== N) throw new Error('❌ Códigos duplicados en la emisión concurrente');
  console.log(`✔ ${N} turnos emitidos en paralelo, todos con código único (${codes[0]} … ${codes.at(-1)})`);

  const calledBy = new Map<string, string>();
  const dupes: string[] = [];
  await Promise.all(
    sessions.map(async (s) => {
      for (;;) {
        const r = await api<{ id: string; code: string }>('POST', `/api/operator/desks/${s.deskId}/call-next`, {}, s.token);
        if (r.status === 204) return;
        if (r.status !== 200) throw new Error(`${s.op}: ${r.status} ${JSON.stringify(r.data)}`);
        if (calledBy.has(r.data.id)) dupes.push(`${r.data.code} (${calledBy.get(r.data.id)} y ${s.op})`);
        calledBy.set(r.data.id, s.op);
        await api('POST', `/api/operator/tickets/${r.data.id}/finish`, RESOLUTION, s.token);
      }
    }),
  );

  const perOp = Object.fromEntries(ops.map((op) => [op, [...calledBy.values()].filter((v) => v === op).length]));
  console.log('  Reparto:', perOp);
  if (dupes.length) throw new Error(`❌ Turnos llamados dos veces: ${dupes.join(', ')}`);
  if (calledBy.size !== N) throw new Error(`❌ Se llamaron ${calledBy.size} de ${N} turnos`);
  console.log(`✔ ${N} turnos despachados entre 3 taquillas concurrentes sin duplicados`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
