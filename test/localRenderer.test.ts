import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/localRenderer.js';

// A real settings.yml pulled from a live TRMNL Recipe (id 369398, "Shakespeare
// Quotes") via usetrmnl.com/api/plugin_settings/:id/archive -- see
// docs/architecture.md's "Recipe archive format" section for how this shape
// was confirmed against Terminus's own import code.
const REAL_SETTINGS_YAML = `
---
strategy: polling
no_screen_padding: 'no'
dark_mode: 'no'
static_data: ''
polling_verb: get
framework_version: 3.1.1
serverless_language: ''
polling_url: https://trmnl.bloax.xyz/api/shakespeare-quotes
polling_headers: ''
polling_body: ''
id: 369398
oauth_enabled: 'false'
custom_fields:
- keyname: bio
  name: About This Plugin
  field_type: author_bio
  category: life
  description: A random quote from the works of William Shakespeare.
  github_url: https://github.com/SteveBloX/trmnl-recipes
  email_address: contact@bloax.xyz
name: Shakespeare Quotes
refresh_interval: 480
`;

describe('parseSettings', () => {
  it('parses a real polling-strategy Recipe settings.yml', () => {
    const settings = parseSettings(REAL_SETTINGS_YAML);

    expect(settings.id).toBe(369398);
    expect(settings.name).toBe('Shakespeare Quotes');
    expect(settings.strategy).toBe('polling');
    expect(settings.pollUrl).toBe('https://trmnl.bloax.xyz/api/shakespeare-quotes');
    expect(settings.pollVerb).toBe('GET');
    expect(settings.refreshIntervalMinutes).toBe(480);
  });

  it('drops empty-string polling_headers/polling_body/static_data rather than treating them as data', () => {
    const settings = parseSettings(REAL_SETTINGS_YAML);

    expect(settings.pollHeaders).toBeUndefined();
    expect(settings.pollBody).toBeUndefined();
    expect(settings.staticData).toBeUndefined();
  });

  it('filters out author_bio fields, since they are plugin metadata, not configurable settings', () => {
    const settings = parseSettings(REAL_SETTINGS_YAML);

    expect(settings.customFields).toEqual([]);
  });

  it('parses custom fields with defaults and options', () => {
    const settings = parseSettings(`
---
strategy: polling
polling_url: https://example.com/{{ event_id }}
polling_verb: get
polling_headers: 'Authorization=Bearer%20{{ api_token }}'
polling_body: ''
static_data: ''
id: 1
custom_fields:
- keyname: api_token
  field_type: string
  name: API Token
- keyname: event_id
  field_type: string
  name: Event ID
  default: 66
name: Example
refresh_interval: 15
`);

    expect(settings.pollHeaders).toEqual({ Authorization: 'Bearer {{ api_token }}' });
    expect(settings.customFields).toEqual([
      { keyname: 'api_token', name: 'API Token', fieldType: 'string', description: undefined, options: undefined, default: undefined, optional: false },
      { keyname: 'event_id', name: 'Event ID', fieldType: 'string', description: undefined, options: undefined, default: '66', optional: false },
    ]);
  });
});
