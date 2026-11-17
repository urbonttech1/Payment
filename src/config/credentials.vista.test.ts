import { describe, expect, it } from 'vitest';
import { CAMPOS, vistaDeLosCampos } from './credentials.service';

const TOKEN = 'EAAAl-token-de-square-muy-largo-wCgt';
const SECRETO_APP = 'sq0csp-secreto-de-la-aplicacion-9XyZ';
const REFRESH = 'EQAAl-refresh-token-de-square-4k2P';
const FIRMA = 'clave-de-firma-del-webhook-Q7rm';

const guardadoDeSquare = {
  accessToken: TOKEN,
  locationId: 'LFJ4WXYZ123',
  environment: 'production',
  webhookSignatureKey: FIRMA,
  applicationId: 'sq0idp-AbCdEf',
  applicationSecret: SECRETO_APP,
  refreshToken: REFRESH,
  // Lo que el servicio añade al guardar y que no es un campo del formulario.
  webhookNotificationUrl: 'https://payments.urbont.com/webhooks/square',
};

describe('vistaDeLosCampos', () => {
  it('enmascara los secretos con sus últimos cuatro caracteres', () => {
    const v = vistaDeLosCampos(CAMPOS.square, guardadoDeSquare);
    expect(v.accessToken).toEqual({ puesto: true, vista: '••••wCgt' });
    expect(v.webhookSignatureKey).toEqual({ puesto: true, vista: '••••Q7rm' });
    expect(v.applicationSecret).toEqual({ puesto: true, vista: '••••9XyZ' });
    expect(v.refreshToken).toEqual({ puesto: true, vista: '••••4k2P' });
  });

  it('enseña enteros solo los campos que no son secretos', () => {
    const v = vistaDeLosCampos(CAMPOS.square, guardadoDeSquare);
    expect(v.locationId).toEqual({ puesto: true, vista: 'LFJ4WXYZ123' });
    expect(v.environment).toEqual({ puesto: true, vista: 'production' });
    expect(v.applicationId).toEqual({ puesto: true, vista: 'sq0idp-AbCdEf' });
  });

  it('ningún secreto entero sale en lo que se serializa', () => {
    const texto = JSON.stringify(vistaDeLosCampos(CAMPOS.square, guardadoDeSquare));
    for (const secreto of [TOKEN, SECRETO_APP, REFRESH, FIRMA]) {
      expect(texto).not.toContain(secreto);
    }
  });

  it('marca como no puestos los campos vacíos, en blanco o ausentes', () => {
    const v = vistaDeLosCampos(CAMPOS.square, { accessToken: TOKEN, locationId: '   ', environment: '' });
    expect(v.locationId).toEqual({ puesto: false, vista: null });
    expect(v.environment).toEqual({ puesto: false, vista: null });
    expect(v.refreshToken).toEqual({ puesto: false, vista: null });
    expect(v.applicationId).toEqual({ puesto: false, vista: null });
  });

  it('ignora lo guardado que no es un campo del formulario', () => {
    const v = vistaDeLosCampos(CAMPOS.square, guardadoDeSquare);
    expect(Object.keys(v)).toEqual(CAMPOS.square.map(c => c.nombre));
    expect(JSON.stringify(v)).not.toContain('webhooks/square');
  });

  it('un valor que no es texto cuenta como no puesto', () => {
    const v = vistaDeLosCampos(CAMPOS.square, { accessToken: 12345, locationId: null });
    expect(v.accessToken.puesto).toBe(false);
    expect(v.locationId.puesto).toBe(false);
  });

  it('un secreto muy corto no deja ver ni un carácter', () => {
    const v = vistaDeLosCampos(CAMPOS.square, { accessToken: 'abc' });
    expect(v.accessToken).toEqual({ puesto: true, vista: '••••' });
  });

  it('sirve para Stripe: la clave secreta enmascarada y la location entera', () => {
    const v = vistaDeLosCampos(CAMPOS.stripe, { secretKey: 'sk_live_abcdefghijkl1234', terminalLocationId: 'tml_ABC123' });
    expect(v.secretKey).toEqual({ puesto: true, vista: '••••1234' });
    expect(v.terminalLocationId).toEqual({ puesto: true, vista: 'tml_ABC123' });
  });
});
