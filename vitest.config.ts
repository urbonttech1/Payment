/**
 * Vitest transpila con esbuild, y esbuild **no emite `emitDecoratorMetadata`**.
 *
 * Sin esa metadata, Nest no puede resolver un parámetro de constructor por su
 * tipo (`constructor(private readonly payments: PaymentsService)`) y lo inyecta
 * como `undefined`: el servicio arranca y revienta en la primera petición. Con
 * swc, las pruebas ven el mismo grafo de dependencias que `nest build`.
 */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'db/**/*.test.ts'],
    environment: 'node',
  },
});
