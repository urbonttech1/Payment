/**
 * Prueba de integración del reparto contra Postgres de verdad.
 *
 * Los dobles de los tests imitan las restricciones; quien las hace cumplir es
 * la base. Esto comprueba que las hace cumplir, incluso con dos peticiones a la
 * vez, que es el caso que de verdad duele:
 *
 *  · una parte por beneficiario y por cobro (nadie cobra dos veces),
 *  · un asiento por clave (el libro no se duplica en un reintento),
 *  · una cuenta de cobro por persona y procesador.
 *
 * Cómo correrla:
 *
 *   docker run -d --name urbont-pay -e POSTGRES_PASSWORD=smoke \
 *     -e POSTGRES_DB=payments -p 55432:5432 postgres:16-alpine
 *
 *   DATABASE_URL='postgres://postgres:smoke@127.0.0.1:55432/payments?sslmode=disable' \
 *     npx tsx scripts/prueba-reparto.ts
 */
import { randomUUID } from 'node:crypto';
import { crearPool } from '../src/db/pool';
import { PgTransactionsRepository } from '../src/ledger/transactions.pg.repository';
import { PgEntriesRepository } from '../src/ledger/entries.pg.repository';
import { PgSplitsRepository } from '../src/splits/splits.pg.repository';
import { PgPayeesRepository } from '../src/payees/payees.pg.repository';
import { CuentaDeOtraPersonaError } from '../src/payees/payees.repository';
import { calcularReparto, sumaDelReparto } from '../src/splits/reparto';
import { aplicarMigraciones } from '../db/migrate';

const URL = process.env.DATABASE_URL!;

let fallos = 0;
function ok(cond: boolean, texto: string) {
  console.log(`${cond ? '✓' : '✗ FALLÓ'}  ${texto}`);
  if (!cond) fallos++;
}

async function main() {
  const pool = crearPool(URL);
  await aplicarMigraciones(pool, () => {});

  const cobros = new PgTransactionsRepository(pool);
  const partes = new PgSplitsRepository(pool);
  const personas = new PgPayeesRepository(pool);
  const contable = new PgEntriesRepository(pool);

  const rideId = randomUUID();
  const chofer = randomUUID();
  const valet = randomUUID();
  const clave = `ride_${rideId}_authorize`;

  // ── Un cobro capturado ────────────────────────────────────────────────────
  const { transaccion } = await cobros.crearSiNoExiste({
    idempotencyKey: clave, provider: 'stripe', kind: 'ride',
    rideId, payerId: null, amountCents: 11715, taxCents: 715, currency: 'USD',
  });
  await cobros.marcarAutorizada(transaccion.id, 'pi_reparto');
  const capturado = await cobros.marcarCapturada(transaccion.id, 'pi_reparto', 11715, 'ch_reparto');
  ok(capturado.chargeRef === 'ch_reparto', 'el cargo que financia las transferencias queda guardado');

  // ── El reparto ────────────────────────────────────────────────────────────
  const reparto = calcularReparto({
    capturedCents: capturado.amountCents, taxCents: 715, valetCents: 1000,
    bookingFeeCents: 250, accessFeeCents: 1000, commissionRate: 0.15,
  });
  ok(sumaDelReparto(reparto) === 11715, 'el reparto suma exactamente lo capturado');

  const nuevas = reparto.partes.map((p) => ({
    beneficiaryType: p.type,
    beneficiaryId: p.type === 'driver' ? chofer : p.type === 'valet' ? valet : null,
    amountCents: p.amountCents,
    rate: p.rate ?? null,
  }));

  const primeras = await partes.crearSiNoExisten(capturado.id, nuevas);
  ok(primeras.length === 3, `se apuntan las tres partes (${primeras.map((p) => p.beneficiaryType).join(', ')})`);

  // ── La restricción, con diez peticiones a la vez ──────────────────────────
  const alaVez = await Promise.all(
    Array.from({ length: 10 }, () => partes.crearSiNoExisten(capturado.id, nuevas)),
  );
  const cuantas = new Set(alaVez.flat().map((p) => p.id)).size;
  ok(cuantas === 3, `diez repartos simultáneos dejan tres partes y no treinta (${cuantas})`);

  // ── Pagar una parte ───────────────────────────────────────────────────────
  const delChofer = primeras.find((p) => p.beneficiaryType === 'driver')!;
  const pagada = await partes.marcarPagada(delChofer.id, 'stripe', 'tr_1');
  ok(pagada.status === 'paid' && pagada.providerTransferRef === 'tr_1', 'la parte del chofer queda pagada con su referencia');

  // ── El libro contable ─────────────────────────────────────────────────────
  const asientos = [
    { entryKey: `${capturado.id}:split:clearing`, transactionId: capturado.id, entryType: 'split' as const, account: 'clearing' as const, amountCents: 11715 },
    ...primeras.map((p) => ({
      entryKey: `${capturado.id}:split:${p.beneficiaryType}`,
      transactionId: capturado.id,
      splitId: p.id,
      entryType: 'split' as const,
      account: (p.beneficiaryType === 'driver' ? 'driver_payable' : p.beneficiaryType === 'valet' ? 'valet_payable' : 'platform_revenue') as 'driver_payable' | 'valet_payable' | 'platform_revenue',
      amountCents: -p.amountCents,
    })),
  ];
  const escritos = await contable.asentar(asientos);
  ok(escritos === 4, `se escriben los cuatro asientos (${escritos})`);

  const repetidos = await contable.asentar(asientos);
  ok(repetidos === 0, `un reintento no escribe ninguno otra vez (${repetidos})`);

  const saldos = await contable.saldos(capturado.id);
  const total = Object.values(saldos).reduce((t, v) => t + v, 0);
  ok(total === 0, `los asientos del cobro suman cero (${JSON.stringify(saldos)})`);

  // ── Beneficiarios ─────────────────────────────────────────────────────────
  const r1 = await personas.registrarSiFalta({ payeeId: chofer, payeeType: 'driver', provider: 'stripe', providerRef: 'acct_bueno' });
  ok(!r1.yaExistia, 'la cuenta del chofer se registra la primera vez');

  const r2 = await personas.registrarSiFalta({ payeeId: chofer, payeeType: 'driver', provider: 'stripe', providerRef: 'acct_del_atacante' });
  ok(r2.yaExistia && r2.payee.providerRef === 'acct_bueno', 'registrar otra vez NO cambia la cuenta: manda la que estaba');

  let choque: unknown = null;
  try {
    await personas.registrarSiFalta({ payeeId: valet, payeeType: 'valet', provider: 'stripe', providerRef: 'acct_bueno' });
  } catch (e) {
    choque = e;
  }
  ok(
    choque instanceof CuentaDeOtraPersonaError,
    `la misma cuenta no se puede registrar a dos personas, y lo dice claro (${(choque as Error)?.name})`,
  );

  // ── Limpieza ──────────────────────────────────────────────────────────────
  await pool.query('DELETE FROM payments.transactions WHERE idempotency_key = $1', [clave]);
  await pool.query('DELETE FROM payments.payees WHERE payee_id = ANY($1)', [[chofer, valet]]);
  await pool.end();

  console.log(
    fallos === 0
      ? '\nTodo correcto: la base impide el doble pago y el libro cuadra.'
      : `\n${fallos} comprobación(es) fallaron.`,
  );
  if (fallos > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FALLÓ:', e instanceof Error ? e.message : e);
  process.exit(1);
});
