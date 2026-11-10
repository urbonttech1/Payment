import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { SettingsService } from './settings.service';
import { CredentialsService } from './credentials.service';

/**
 * La configuración editable, global porque la miran el registro de
 * procesadores y las rutas internas.
 */
@Global()
@Module({
  imports: [ProvidersModule],
  providers: [SettingsService, CredentialsService],
  exports: [SettingsService, CredentialsService],
})
export class SettingsModule {}
