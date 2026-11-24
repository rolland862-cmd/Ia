const MODEL_CHAINS = {
  code: {
    agent1: [
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { provider: 'groq', model: 'openai/gpt-oss-120b' }
    ],
    agent2: [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'mistral', model: 'codestral-latest' },
      { provider: 'cerebras', model: 'llama-3.3-70b' },
      { provider: 'openrouter', model: 'openrouter/free' }
    ],
    agent3: [
      { provider: 'mistral', model: 'codestral-latest' },
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'cerebras', model: 'llama-3.3-70b' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'gemini', model: 'gemini-3.8-flash' }
    ]
  },
  architect: {
    agent1: [
      { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { provider: 'groq', model: 'openai/gpt-oss-120b' }
    ],
    agent2: [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'mistral', model: 'codestral-latest' },
      { provider: 'cerebras', model: 'llama-3.3-70b' }
    ],
    agent3: [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'mistral', model: 'codestral-latest' },
      { provider: 'gemini', model: 'gemini-3.8-flash' }
    ]
  },
  qa: {
    agent1: [
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { provider: 'groq', model: 'llama-3.3-70b-versatile' }
    ],
    agent2: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'mistral', model: 'mistral-small-latest' }
    ],
    agent3: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'gemini', model: 'gemini-3.8-flash' }
    ]
  },
  image: {
    agent1: [
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' }
    ],
    agent2: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'cerebras', model: 'llama-3.3-70b' }
    ],
    agent3: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'gemini', model: 'gemini-3.8-flash' }
    ]
  }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(apiKey, model, systemPrompt, userPrompt) {
  const trimmedKey = String(apiKey || '').trim();
  const isClassic = trimmedKey.startsWith('AIza');
  const url = isClassic
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(trimmedKey)}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': trimmedKey
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 2400 }
    })
  });

  const rawText = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {}

  if (!res.ok) {
    const errMsg = data?.error?.message || rawText.slice(0, 180) || 'Erreur Gemini';
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Réponse Gemini vide');
  }
  return text;
}

async function callOpenAICompat(url, apiKey, model, systemPrompt, userPrompt) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(apiKey || '').trim()}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      max_tokens: 2400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const rawText = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {}

  if (!res.ok) {
    const errMsg = data?.error?.message || rawText.slice(0, 180) || 'Erreur API';
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }

  const msg = data?.choices?.[0]?.message || {};
  const text = (msg.content || msg.reasoning_content || msg.reasoning || '').trim();
  if (!text) {
    throw new Error('Réponse vide');
  }
  return text;
}

async function executeCandidate(cand, keys, systemPrompt, userPrompt) {
  const apiKey = (keys[cand.provider] || '').trim();
  if (!apiKey) {
    throw new Error(`Clé ${cand.provider} absente`);
  }

  if (cand.provider === 'gemini') {
    return await callGemini(apiKey, cand.model, systemPrompt, userPrompt);
  }
  if (cand.provider === 'groq') {
    return await callOpenAICompat('https://api.groq.com/openai/v1/chat/completions', apiKey, cand.model, systemPrompt, userPrompt);
  }
  if (cand.provider === 'mistral') {
    return await callOpenAICompat('https://api.mistral.ai/v1/chat/completions', apiKey, cand.model, systemPrompt, userPrompt);
  }
  if (cand.provider === 'cerebras') {
    return await callOpenAICompat('https://api.cerebras.ai/v1/chat/completions', apiKey, cand.model, systemPrompt, userPrompt);
  }
  if (cand.provider === 'openrouter') {
    return await callOpenAICompat('https://openrouter.ai/api/v1/chat/completions', apiKey, cand.model, systemPrompt, userPrompt);
  }
  throw new Error(`Fournisseur non supporté : ${cand.provider}`);
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
        status: 405,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    try {
      const body = await request.json();
      const mode = body.mode || 'code';
      const role = body.role || 'agent1';
      const preferredModel = body.preferredModel || '';
      const systemPrompt = body.systemPrompt || '';
      const userPrompt = body.userPrompt || '';
      const keys = body.keys || {};

      const modeMap = MODEL_CHAINS[mode] || MODEL_CHAINS.code;
      const baseChain = modeMap[role] || modeMap.agent1;
      const candidates = [];

      const pushCand = (provider, model) => {
        if (!provider || !model || !(keys[provider] || '').trim()) return;
        if (!candidates.some((c) => c.provider === provider && c.model === model)) {
          candidates.push({ provider, model });
        }
      };

      if (role === 'agent1' && keys.gemini) {
        pushCand('gemini', 'gemini-3.1-pro-preview');
        pushCand('gemini', 'gemini-3.8-flash');
        pushCand('gemini', 'gemini-3.5-flash-lite');
      }

      if ((mode === 'code' || mode === 'architect') && (role === 'agent2' || role === 'agent3')) {
        pushCand('groq', 'openai/gpt-oss-120b');
        pushCand('mistral', 'codestral-latest');
        pushCand('cerebras', 'llama-3.3-70b');
        pushCand('openrouter', 'openrouter/free');
      }

      const [prefProv, prefMdl] = String(preferredModel).split(':');
      if (prefProv && prefMdl && prefMdl !== 'auto') {
        pushCand(prefProv.trim(), prefMdl.trim());
      }

      baseChain.forEach((c) => pushCand(c.provider, c.model));

      ['gemini', 'groq', 'mistral', 'cerebras', 'openrouter'].forEach((prov) => {
        const defaults = {
          gemini: 'gemini-3.8-flash',
          groq: 'openai/gpt-oss-120b',
          mistral: 'codestral-latest',
          cerebras: 'llama-3.3-70b',
          openrouter: 'openrouter/free'
        };
        pushCand(prov, defaults[prov]);
      });

      if (candidates.length === 0) {
        return new Response(JSON.stringify({ error: 'Aucune clé API fournie au Worker' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }

      const errors = [];

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        if (i > 0) {
          await sleep(450);
        }

        try {
          const text = await executeCandidate(cand, keys, systemPrompt, userPrompt);
          return new Response(
            JSON.stringify({
              text,
              usedModel: `${cand.provider}:${cand.model}`,
              fallbackErrors: errors
            }),
            {
              status: 200,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            }
          );
        } catch (err) {
          const msg = `${cand.provider}:${cand.model} (${err.message || 'erreur'})`;
          errors.push(msg);

          if (String(err.message || '').includes('503')) {
            await sleep(700);
            try {
              const retryText = await executeCandidate(cand, keys, systemPrompt, userPrompt);
              return new Response(
                JSON.stringify({
                  text: retryText,
                  usedModel: `${cand.provider}:${cand.model} (retry 503 OK)`,
                  fallbackErrors: errors
                }),
                {
                  status: 200,
                  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                }
              );
            } catch (retryErr) {
              errors.push(`${cand.provider}:${cand.model} retry (${retryErr.message || 'erreur'})`);
            }
          }
        }
      }

      return new Response(
        JSON.stringify({
          error: errors.join(' | ') || 'Tous les modèles ont échoué'
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || 'Erreur interne Worker' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
  }
};
