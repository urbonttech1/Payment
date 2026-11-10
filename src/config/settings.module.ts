import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { SettingsService } from './settings.service';

/**
 * La configuración editable, global porque la miran el registro de
 * procesadores y las rutas internas.
 */
@Global()
@Module({
  imports: [ProvidersModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
