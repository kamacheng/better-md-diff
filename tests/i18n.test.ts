import { afterEach, describe, expect, it } from 'vitest';
import { ENGLISH, LocalizedError, languageForObsidian, setLanguage, t } from '../src/i18n';

afterEach(() => setLanguage('zh-CN'));
describe('interface language', () => {
  it.each(['zh', 'zh-CN', 'zh-TW', 'zh_HK'])('uses Chinese for Obsidian language %s', (code) => {
    expect(languageForObsidian(code)).toBe('zh-CN');
  });
  it.each(['en', 'de', 'ja', ''])('falls back to English for Obsidian language %s', (code) => {
    expect(languageForObsidian(code)).toBe('en');
  });
  it('translates text and parameters, including errors created before switching', () => {
    const error = new LocalizedError('文档不在本次刷新范围内。');
    setLanguage('en');
    expect(t('刷新')).toBe('Refresh');
    expect(t('第 {index} / {total} 处', { index: 2, total: 3 })).toBe('Change 2 / 3');
    expect(error.message).toBe('The document is not in this refresh batch.');
    setLanguage('zh-CN');
    expect(error.message).toBe('文档不在本次刷新范围内。');
  });
  it('keeps the same placeholders in every English translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
    for (const [chinese, english] of Object.entries(ENGLISH)) {
      expect(english.trim()).not.toBe('');
      expect(placeholders(english)).toEqual(placeholders(chinese));
    }
  });
});
