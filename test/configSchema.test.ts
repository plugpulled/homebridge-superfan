import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PLATFORM_NAME } from '../src/settings.js';

// Homebridge UI matches config blocks to the plugin by pluginAlias; a mismatch makes the settings form unusable.
const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));

describe('config.schema.json', () => {
  test('is wired to this platform', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
    expect(schema.pluginType).toBe('platform');
    expect(schema.singular).toBe(true);
  });

  test('asks for the credentials the platform requires, with a masked password field', () => {
    expect(schema.schema.required).toEqual(expect.arrayContaining(['email', 'password']));
    expect(schema.schema.properties.password['x-schema-form']).toEqual({ type: 'password' });
  });

  test('offers the per-device overrides parseConfig understands', () => {
    expect(Object.keys(schema.schema.properties.devices.items.properties).sort()).toEqual(['deviceId', 'host', 'model']);
  });
});
