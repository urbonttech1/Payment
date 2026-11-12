import { describe, expect, it } from 'vitest';
import { lineaDeArranque } from './arranque';

describe('lineaDeArranque', () => {
  it('dice el procesador por defecto y los que están montados', () => {
    expect(lineaDeArranque({ version: '2.0.6', puerto: 8080, porDefecto: 'square', montados: ['stripe', 'square'] }))
      .toBe('URBONT PAYMENTS v2.0.6 escuchando en :8080 · procesador por defecto: square · montados: stripe, square');
  });

  // El caso de producción: el panel eligió Square y la línea decía «stripe».
  it('MUESTRA EL QUE QUEDÓ, NO EL DEL ENTORNO', () => {
    const l = lineaDeArranque({ version: '2.0.6', puerto: 8080, porDefecto: 'square', montados: ['stripe', 'square'] });
    expect(l).toContain('por defecto: square');
    expect(l).not.toContain('por defecto: stripe');
  });

  it('con uno solo montado, sin aviso', () => {
    const l = lineaDeArranque({ version: '2.0.6', puerto: 8087, porDefecto: 'stripe', montados: ['stripe'] });
    expect(l).toContain('montados: stripe');
    expect(l).not.toContain('⚠');
  });

  // Cada cobro nuevo iría a un procesador sin credenciales.
  it('SI EL POR DEFECTO NO ESTÁ MONTADO, LO GRITA AL ARRANCAR', () => {
    const l = lineaDeArranque({ version: '2.0.6', puerto: 8080, porDefecto: 'square', montados: ['stripe'] });
    expect(l).toContain("⚠ 'square' NO está montado");
    expect(l).toContain('los cobros nuevos van a fallar');
  });

  it('sin ninguno montado, también', () => {
    const l = lineaDeArranque({ version: '2.0.6', puerto: 8080, porDefecto: 'stripe', montados: [] });
    expect(l).toContain('montados: ninguno');
    expect(l).toContain('⚠');
  });
});
