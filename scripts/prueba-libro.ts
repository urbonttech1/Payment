/**
 * Prueba de integración del libro contra Postgres de verdad.
 *
 * El repositorio en memoria de los tests imita la restricción única, pero quien
 * la hace cumplir es la base. Esto comprueba que lo hace, incluso con dos
 * peticiones a la vez, que es el caso que de verdad duele.
 */
import { crearPool } from '../src/db/pool';
import { PgTransactionsRepository } from '../src/ledger/transactions.pg.repository';
import { aplicarMigraciones } from '../db/migrate';

const URL = process.env.DATABASE_URL!;

async function main() {
  const pool = crearPool(URL);
  await aplicarMigraciones(pool, () => {});
  const repo = new PgTransactionsRepository(pool);

  const clave = `ride_${Date.now()}_authorize`;
  const base = {
    idempotencyKey: clave,
    provider: 'stripe' as const,
    kind: 'ride' as const,
    rideId: null,
    payerId: null,
    amountCents: 11000,
    taxCents: 715,
    currency: 'USD' as const,
  };

  const primera = await repo.crearSiNoExiste(base);
  console.log(`1) creada            → id=${primera.transaccion.id} yaExistia=${primera.yaExistia} estado=${primera.transaccion.status}`);

  const segunda = await repo.crearSiNoExiste(base);
  console.log(`2) reintento         → id=${segunda.transaccion.id} yaExistia=${segunda.yaExistia}`);
  if (segunda.transaccion.id !== primera.transaccion.id) throw new Error('¡el reintento creó otra fila!');

  // Diez peticiones a la vez con la misma clave: el caso real de un móvil con
  // mala cobertura que reenvía mientras la primera sigue en vuelo.
  const clave2 = `ride_${Date.now()}_concurrente`;
  const alaVez = await Promise.all(
    Array.from({ length: 10 }, () => repo.crearSiNoExiste({ ...base, idempotencyKey: clave2 })),
  );
  const ids = new Set(alaVez.map((r) => r.transaccion.id));
  const creadas = alaVez.filter((r) => !r.yaExistia).length;
  console.log(`3) 10 a la vez       → ${ids.size} fila(s), ${creadas} creada(s)`);
  if (ids.size !== 1) throw new Error(`¡se crearon ${ids.size} filas para la misma clave!`);

  const autorizada = await repo.marcarAutorizada(primera.transaccion.id, 'pi_abc');
  console.log(`4) autorizada        → estado=${autorizada.status} ref=${autorizada.providerRef}`);

  const capturada = await repo.marcarCapturada(primera.transaccion.id, 'pi_abc', 5500);
  console.log(`5) capturada parcial → estado=${capturada.status} importe=${capturada.amountCents}`);

  const porRef = await repo.porReferenciaDelProveedor('stripe', 'pi_abc');
  console.log(`6) buscada por ref   → ${porRef?.id === primera.transaccion.id ? 'la misma fila' : 'OTRA FILA'}`);

  await pool.query('DELETE FROM payments.transactions WHERE idempotency_key = ANY($1)', [[clave, clave2]]);
  await pool.end();
  console.log('\nTodo correcto: la base impide el doble cobro, también con peticiones simultáneas.');
}

main().catch((e) => { console.error('FALLÓ:', e.message); process.exit(1); });
