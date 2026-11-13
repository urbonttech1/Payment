/**
 * La versión del servicio. **Esta constante manda.**
 *
 * Se escribe aquí, en el código, y no se lee de `package.json` ni de
 * `npm_package_version`: esa variable sólo existe cuando el proceso lo arranca
 * npm, y en producción lo arranca ECS con `node dist/src/main.js`, así que
 * llega vacía justo donde hace falta. Una versión que dice «undefined» en el
 * único sitio donde se consulta de verdad no sirve de nada.
 *
 * `package.json` se mantiene igual, y hay una prueba que falla si se separan
 * (`version.test.ts`). Son dos ficheros porque npm necesita el suyo, pero una
 * sola verdad.
 *
 * **Cómo se sube**, con el criterio de siempre:
 *
 *  · El tercer número, cuando el cambio no se nota desde fuera.
 *  · El segundo, cuando el servicio hace algo nuevo: una pasarela más, un
 *    flujo más, una ruta más.
 *  · El primero, cuando algo que ya usaba alguien deja de funcionar igual: una
 *    ruta de `/internal` que cambia de forma, el canon de la firma, o el
 *    contrato de los adaptadores.
 *
 * Se ve en `/healthz`, en `/readyz`, en la línea del arranque y en el panel de
 * Stripe, que la muestra junto a cada cobro que este servicio crea.
 */
export const VERSION = '2.4.0';

/** El nombre con el que el servicio se presenta. */
export const SERVICIO = 'urbont-payments';


