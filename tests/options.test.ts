import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/options';

describe('settings defaults and validation', () => {
  it('loads defaults without requiring a settings file or writing one', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it('preserves the original two settings when upgrading', () => {
    expect(normalizeSettings({ gitPath: ' custom-git ', showMarkers: false })).toEqual({ ...DEFAULT_SETTINGS, gitPath: 'custom-git', showMarkers: false });
  });
  it('accepts independent display, navigation and refresh controls', () => {
    const options = { ...DEFAULT_SETTINGS, fontSize: 18, contextLines: 0, inlineHighlights: false, showWhitespace: false, followEditor: false, followNavigation: false, editDelayMs: 500, gitPollSeconds: 30 };
    expect(normalizeSettings(options)).toEqual(options);
  });
  it('bounds numeric settings and rejects invalid persisted values', () => {
    expect(normalizeSettings({ fontSize: 99, contextLines: -1, editDelayMs: 1, gitPollSeconds: 999 })).toMatchObject({ fontSize: 22, contextLines: 0, editDelayMs: 100, gitPollSeconds: 60 });
    expect(normalizeSettings({ fontSize: NaN, contextLines: Infinity, editDelayMs: '0', showMarkers: 'false', gitPath: '' })).toEqual(DEFAULT_SETTINGS);
  });
});
