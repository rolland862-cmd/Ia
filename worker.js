const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://rolland862-cmd.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const GEMINI_AUTO_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
];

const PROVIDER_ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
};

const PROVIDER_FALLBACK_MODELS = {
  groq: "openai/gpt-oss-120b",
  cerebras: "llama-3.3-70b",
  mistral: "codestral-latest",
  openrouter: "openrouter/free",
};

function jsonCorsResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

async function callGeminiModel(apiKey, model, systemPrompt, userPrompt) {
  const trimmedKey = String(apiKey || "").trim();
  const isClassicKey = trimmedKey.startsWith("AIza");
  const url = isClassicKey
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(trimmedKey)}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": trimmedKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt || "" }] },
      contents: [{ role: "user", parts: [{ text: userPrompt || "" }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 2400 },
    }),
  });

  const rawText = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {}

  if (!res.ok) {
    const errObj = parsed?.error || {};
    throw new Error(`HTTP ${res.status}${errObj.message ? `: ${errObj.message}` : ""}`);
  }

  const text = (parsed?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error(`Gemini (${model}) réponse vide`);
  }

  return { text, usedModel: `Gemini (${model})` };
}

async function runGeminiChain(apiKey, preferredModel, systemPrompt, userPrompt, errorsList) {
  const models = [];
  if (preferredModel && preferredModel !== "auto") models.push(preferredModel);
  for (const m of GEMINI_AUTO_CHAIN) {
    if (!models.includes(m)) models.push(m);
  }

  for (const model of models) {
    try {
      return await callGeminiModel(apiKey, model, systemPrompt, userPrompt);
    } catch (err) {
      errorsList.push(`[${model}] ${err?.message || "Erreur Gemini"}`);
    }
  }
  throw new Error("Aucun modèle Gemini n'a répondu");
}

async function callOpenAICompat(provider, apiKey, model, systemPrompt, userPrompt) {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) throw new Error(`Fournisseur inconnu: ${provider}`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${String(apiKey || "").trim()}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      max_tokens: 2400,
      messages: [
        { role: "system", content: systemPrompt || "" },
        { role: "user", content: userPrompt || "" },
      ],
    }),
  });

  const rawText = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {}

  if (!res.ok) {
    const msg = data?.error?.message || rawText.slice(0, 140) || `HTTP ${res.status}`;
    throw new Error(`${provider.toUpperCase()} (${model}): ${msg}`);
  }

  const msg = data?.choices?.[0]?.message || {};
  const text = (msg.content || msg.reasoning_content || msg.reasoning || "").trim();
  if (!text) throw new Error(`${provider.toUpperCase()} (${model}) réponse vide`);

  return { text, usedModel: `${provider.toUpperCase()} (${model})` };
}

async function orchestrateRequest(body, env) {
  const preferredModelStr = String(body?.preferredModel || "gemini:auto");
  const [prefProviderRaw, prefModelRaw] = preferredModelStr.split(":");
  const prefProvider = (prefProviderRaw || "").trim();
  const prefModel = (prefModelRaw || "").trim();

  const systemPrompt = String(body?.systemPrompt || "");
  const userPrompt = String(body?.userPrompt || "");

  const keys = {
    gemini: body?.keys?.gemini || env?.GEMINI_API_KEY || "",
    groq: body?.keys?.groq || env?.GROQ_API_KEY || "",
    openrouter: body?.keys?.openrouter || env?.OPENROUTER_API_KEY || "",
    mistral: body?.keys?.mistral || env?.MISTRAL_API_KEY || "",
    cerebras: body?.keys?.cerebras || env?.CEREBRAS_API_KEY || "",
  };

  const fallbackErrors = [];

  if (prefProvider === "gemini" && keys.gemini) {
    try {
      const r = await runGeminiChain(keys.gemini, prefModel || "auto", systemPrompt, userPrompt, fallbackErrors);
      return { ...r, fallbackErrors };
    } catch (_) {}
  }

  const candidates = [];
  if (prefProvider && prefProvider !== "gemini" && prefModel && keys[prefProvider]) {
    candidates.push({ provider: prefProvider, model: prefModel });
  }
  if (prefProvider !== "gemini" && keys.gemini) {
    candidates.push({ provider: "gemini", model: "auto" });
  }
  for (const prov of ["groq", "cerebras", "mistral", "openrouter"]) {
    if (prov !== prefProvider && keys[prov]) {
      candidates.push({ provider: prov, model: PROVIDER_FALLBACK_MODELS[prov] });
    }
  }

  if (candidates.length === 0) {
    throw new Error("Aucune clé API disponible côté Worker ou requête.");
  }

  for (const cand of candidates) {
    try {
      if (cand.provider === "gemini") {
        const r = await runGeminiChain(keys.gemini, cand.model, systemPrompt, userPrompt, fallbackErrors);
        return { ...r, fallbackErrors };
      }
      const r = await callOpenAICompat(cand.provider, keys[cand.provider], cand.model, systemPrompt, userPrompt);
      return { ...r, fallbackErrors };
    } catch (err) {
      fallbackErrors.push(err?.message || `Erreur ${cand.provider}`);
    }
  }

  throw new Error(fallbackErrors.join(" | ") || "Tous les fournisseurs ont échoué");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (request.method === "GET") {
      return jsonCorsResponse({
        status: "ok",
        service: "devstudio-relais",
        repo: "Ia",
      });
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        const result = await orchestrateRequest(body, env);
        return jsonCorsResponse(result, 200);
      } catch (err) {
        return jsonCorsResponse(
          { error: err?.message || "Erreur interne du Worker" },
          500
        );
      }
    }

    return jsonCorsResponse({ error: "Méthode non autorisée" }, 405);
  },
};
