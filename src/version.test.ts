/**
 * La versión del código y la de `package.json` son la misma.
 *
 * Existen las dos porque npm necesita la suya, pero una versión que miente es
 * peor que no tenerla: la de `/healthz` diría una cosa y la del paquete otra, y
 * nadie sabría cuál está desplegada de verdad. Esta prueba las ata.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICIO, VERSION } from './version';

const paquete = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { name: string; version: string };

describe('la versión del servicio', () => {
  it('COINCIDE CON LA DE package.json', () => {
    expect(
      paquete.version,
      `package.json dice ${paquete.version} y src/version.ts dice ${VERSION}. ` +
        'Manda la del código: cambia package.json para que coincida.',
    ).toBe(VERSION);
  });

  it('el nombre también', () => {
    expect(paquete.name).toBe(SERVICIO);
  });

  // Que sea legible por una máquina importa: el día que algo compare versiones
  // —un despliegue que comprueba si subió, un aviso de incompatibilidad— no
  // puede tropezar con «1.0» o «v1.0.0».
  it('tiene la forma MAYOR.MENOR.PARCHE, sin prefijos', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
