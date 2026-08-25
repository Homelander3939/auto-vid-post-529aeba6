import { LOVABLE_MODELS } from '../_shared/ai-provider.ts';

// List available AI models for a given provider using the user's API key.
// Used by Settings UI so the user can pick from a real, live list of models.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}

interface ModelInfo {
  id: string;
  label?: string;
}

async function fetchOpenAICompat(endpoint: string, apiKey: string, extraHeaders: Record<string, string> = {}): Promise<ModelInfo[]> {
  const resp = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
  });
  if (!resp.ok) throw new Error(`Provider returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return arr.map((m: any) => ({ id: m.id || m.name, label: m.id || m.name })).filter((m: ModelInfo) => m.id);
}

async function fetchGoogle(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!resp.ok) throw new Error(`Google returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const arr = Array.isArray(data?.models) ? data.models : [];
  return arr
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => ({
      id: (m.name || '').replace(/^models\//, ''),
      label: m.displayName || m.name,
    }))
    .filter((m: ModelInfo) => m.id);
}

async function fetchAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!resp.ok) throw new Error(`Anthropic returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const arr = Array.isArray(data?.data) ? data.data : [];
  return arr.map((m: any) => ({ id: m.id, label: m.display_name || m.id }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { provider, apiKey, baseUrl } = (await req.json()) as Body;
    if (!provider) {
      return new Response(JSON.stringify({ error: 'provider is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let models: ModelInfo[] = [];
    if (provider === 'lovable') {
      models = [...LOVABLE_MODELS];
    } else if (provider === 'lmstudio') {
      // LM Studio runs locally on the user's machine and exposes an OpenAI-compatible
      // /v1/models endpoint. The cloud edge function cannot reach localhost, so we
      // return a friendly placeholder list and let the user type/confirm the model.
      const trimmedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (trimmedBase && !/localhost|127\.0\.0\.1|192\.168\.|10\.|172\./i.test(trimmedBase)) {
        try {
          const url = trimmedBase.endsWith('/v1') ? `${trimmedBase}/models` : `${trimmedBase}/v1/models`;
          models = await fetchOpenAICompat(url, apiKey || 'lm-studio');
        } catch (e) {
          console.warn('LM Studio fetch failed, returning empty list:', e);
          models = [];
        }
      }
      // Always include a hint entry so the dropdown is never empty
      if (models.length === 0) {
        models = [
          { id: 'qwen3.8-27b-uncensored-aggressive', label: 'Qwen 3.8 27B (LM Studio local)' },
        ];
      }
    } else {
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key is required for this provider' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (provider === 'openai') {
        models = await fetchOpenAICompat('https://api.openai.com/v1/models', apiKey);
        // Keep only chat-capable models
        models = models.filter((m) => /gpt|o\d|chat/i.test(m.id));
      } else if (provider === 'openrouter') {
        models = await fetchOpenAICompat('https://openrouter.ai/api/v1/models', apiKey);
      } else if (provider === 'anthropic') {
        models = await fetchAnthropic(apiKey);
      } else if (provider === 'google') {
        models = await fetchGoogle(apiKey);
      } else if (provider === 'nvidia') {
        models = await fetchOpenAICompat('https://integrate.api.nvidia.com/v1/models', apiKey);
      } else if (provider === 'xai') {
        models = await fetchOpenAICompat('https://api.x.ai/v1/models', apiKey);
      } else {
        return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Sort: putative chat/text models first by id
    models.sort((a, b) => a.id.localeCompare(b.id));

    return new Response(JSON.stringify({ models }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('list-ai-models error', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
