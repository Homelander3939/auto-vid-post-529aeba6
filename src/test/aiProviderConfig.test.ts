import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOVABLE_MODEL,
  GOOGLE_OPENAI_GATEWAY,
  LOVABLE_GATEWAY,
  resolveChatProviderConfig,
} from '../../supabase/functions/_shared/ai-provider';

describe('resolveChatProviderConfig', () => {
  it('keeps OpenRouter models on the OpenRouter backend when a key is saved', () => {
    const config = resolveChatProviderConfig(
      { provider: 'openrouter', apiKey: 'sk-or-v1-test', model: 'openrouter/test-model' },
      'lovable-test-key',
    );

    expect(config.provider).toBe('openrouter');
    expect(config.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(config.key).toBe('sk-or-v1-test');
    expect(config.model).toBe('openrouter/test-model');
    expect(config.fallbackReason).toBeUndefined();
  });

  it('falls back to a Lovable-safe model when the selected provider cannot be used', () => {
    const config = resolveChatProviderConfig(
      { provider: 'openrouter', apiKey: '', model: 'openrouter/test-model' },
      'lovable-test-key',
    );

    expect(config.provider).toBe('lovable');
    expect(config.url).toBe(LOVABLE_GATEWAY);
    expect(config.key).toBe('lovable-test-key');
    expect(config.model).toBe(DEFAULT_LOVABLE_MODEL);
    expect(config.fallbackReason).toContain('no saved API key');
  });

  it('normalizes Google models for the Gemini OpenAI-compatible endpoint', () => {
    const config = resolveChatProviderConfig(
      { provider: 'google', apiKey: 'AIza-test-key', model: 'google/gemini-2.5-pro' },
      'lovable-test-key',
    );

    expect(config.provider).toBe('google');
    expect(config.url).toBe(GOOGLE_OPENAI_GATEWAY);
    expect(config.model).toBe('gemini-2.5-pro');
    expect(config.googleMode).toBe(true);
  });

  it('replaces invalid Lovable models with the default compatible model', () => {
    const config = resolveChatProviderConfig(
      { provider: 'lovable', model: 'local/test-model' },
      'lovable-test-key',
    );

    expect(config.provider).toBe('lovable');
    expect(config.url).toBe(LOVABLE_GATEWAY);
    expect(config.model).toBe(DEFAULT_LOVABLE_MODEL);
    expect(config.fallbackReason).toContain('not supported by Lovable');
  });
});
