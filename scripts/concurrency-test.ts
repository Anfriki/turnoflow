/**
 * Prueba de concurrencia de "Llamar siguiente" contra un servidor en marcha.
 *
 *  1. Tres operadores toman Box 1, Box 2 y Box 5 (todos atienden la cola "A").
 *  2. Se emiten N turnos de Cajas en paralelo (prueba del correlativo atómico).
 *  3. Los tres boxes llaman y finalizan turnos en paralelo, a máxima velocidad.
 *  4. Se verifica: ningún ticket llamado dos veces y códigos sin duplicados.
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

async function main() {
  const branch = (await api<{ id: string; categories: { id: string; prefixLetter: string }[] }>('GET', '/api/public/branches/CENTRAL')).data;
  const cajas = branch.categories.find((c) => c.prefixLetter === 'A')!;

  const ops = ['operador1', 'operador2', 'operador3'];
  const deskNames = ['Box 1', 'Box 2', 'Box 5'];
  const sessions = await Promise.all(
    ops.map(async (op, i) => {
      const { data } = await api<{ token: string }>('POST', '/api/auth/login', { email: `${op}@turnos.local`, password: 'Operador123!' });
      const desks = (await api<{ id: string; identifier: string }[]>('GET', '/api/operator/desks', undefined, data.token)).data;
      const desk = desks.find((d) => d.identifier === deskNames[i])!;
      const claim = await api('POST', `/api/operator/desks/${desk.id}/claim`, {}, data.token);
      if (claim.status !== 200) throw new Error(`${op} no pudo tomar ${desk.identifier}: ${JSON.stringify(claim.data)}`);
      return { op, token: data.token, deskId: desk.id };
    }),
  );
  console.log(`✔ ${sessions.length} operadores en sus boxes`);

  // Vaciar la cola previa para que la prueba sea determinista
  for (const s of sessions) {
    for (;;) {
      const r = await api<{ id: string }>('POST', `/api/operator/desks/${s.deskId}/call-next`, {}, s.token);
      if (r.status !== 200) break;
      await api('POST', `/api/operator/tickets/${r.data.id}/finish`, {}, s.token);
    }
  }

  const issued = await Promise.all(
    Array.from({ length: N }, () =>
      api<{ id: string; code: string }>('POST', '/api/public/tickets', { branchId: branch.id, categoryId: cajas.id }),
    ),
  );
  const codes = issued.map((r) => r.data.code);
  if (new Set(codes).size !== N) throw new Error('❌ Códigos duplicados en la emisión concurrente');
  console.log(`✔ ${N} turnos emitidos en paralelo, todos con código único (${codes.sort()[0]} … ${codes.sort().at(-1)})`);

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
        await api('POST', `/api/operator/tickets/${r.data.id}/finish`, {}, s.token);
      }
    }),
  );

  const perOp = Object.fromEntries(ops.map((op) => [op, [...calledBy.values()].filter((v) => v === op).length]));
  console.log('  Reparto:', perOp);
  if (dupes.length) throw new Error(`❌ Tickets llamados dos veces: ${dupes.join(', ')}`);
  if (calledBy.size !== N) throw new Error(`❌ Se llamaron ${calledBy.size} de ${N} turnos`);
  console.log(`✔ ${N} turnos despachados entre 3 boxes concurrentes sin duplicados`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
