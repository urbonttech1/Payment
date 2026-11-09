import { Module } from '@nestjs/common';
import { PAYEES_REPOSITORY } from './payees.repository';
import { PgPayeesRepository } from './payees.pg.repository';

/**
 * Los beneficiarios, en su propio módulo.
 *
 * Lo usan el reparto (para saber a qué cuenta pagar) y los webhooks (para
 * enterarse de que un chofer ya puede cobrar). Que el módulo de webhooks
 * tuviera que importar el de reparto sólo para alcanzar esta tabla sería una
 * dependencia que no existe en la realidad.
 */
@Module({
  providers: [{ provide: PAYEES_REPOSITORY, useClass: PgPayeesRepository }],
  exports: [PAYEES_REPOSITORY],
})
export class PayeesModule {}
