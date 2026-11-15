import * as webllm from "https://esm.run/@mlc-ai/web-llm";

const $ = (s) => document.querySelector(s);
let engine = null;
let lastResult = null;

// Keep every primitive type singular. Some WebLLM grammar backends reject
// JSON Schema unions such as type: ["string", "number"].
const claimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["object", "entities", "relations", "attributes", "ranges", "steps", "unresolvedSegments"],
  properties: {
    object: { type: "string" },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "mentions", "sourceText"],
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          mentions: { type: "array", items: { type: "string" } },
          sourceText: { type: "string" }
        }
      }
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "predicate", "object", "sourceText"],
        properties: {
          subject: { type: "string" },
          predicate: { type: "string" },
          object: { type: "string" },
          sourceText: { type: "string" }
        }
      }
    },
    attributes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "property", "value", "sourceText"],
        properties: {
          subject: { type: "string" },
          property: { type: "string" },
          value: { type: "string" },
          sourceText: { type: "string" }
        }
      }
    },
    ranges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["property", "min", "max", "unit", "sourceText"],
        properties: {
          property: { type: "string" },
          min: { type: "number" },
          max: { type: "number" },
          unit: { type: "string" },
          sourceText: { type: "string" }
        }
      }
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["order", "action", "object", "sourceText"],
        properties: {
          order: { type: "integer" },
          action: { type: "string" },
          object: { type: "string" },
          sourceText: { type: "string" }
        }
      }
    },
    unresolvedSegments: { type: "array", items: { type: "string" } }
  }
};

const auditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["valid", "missingSegments", "inventedElements", "wrongCoreferences", "notes"],
  properties: {
    valid: { type: "boolean" },
    missingSegments: { type: "array", items: { type: "string" } },
    inventedElements: { type: "array", items: { type: "string" } },
    wrongCoreferences: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  }
};

const systemPrompt = `Você extrai estrutura técnica de reivindicações de patente em português. Não avalie art. 32, novidade ou atividade inventiva. Não acrescente matéria. Use somente o texto fornecido.
Regras:
1. Entidade é objeto, componente, sinal, grandeza ou resultado técnico; nunca uma oração inteira.
2. Resolva correferências: "o mecanismo" retoma entidade compatível já introduzida.
3. Preserve compreende, conectado a, disposto entre, configurado para, em função de, etapas, atributos e faixas.
4. sourceText deve ser cópia literal de trecho da reivindicação.
5. Em attributes.value, sempre use texto, inclusive para números, por exemplo "12".
6. Se não puder interpretar trecho técnico, coloque-o em unresolvedSegments.
7. Retorne somente JSON aderente ao schema.`;

function isGrammarCompatibilityError(error) {
  const m = String(error?.message || error);
  return m.includes("grammar matcher") || m.includes("std::string") || m.includes("response format");
}

function isDeviceLostError(error) {
  const m = String(error?.message || error);
  return m.includes("Device was lost") || m.includes("GPUDeviceLost") || m.includes("DEVICE_HUNG");
}

async function createJsonCompletion(messages, schema, maxTokens) {
  const base = { messages, temperature: 0, max_tokens: maxTokens };
  try {
    return await engine.chat.completions.create({
      ...base,
      response_format: { type: "json_object", schema }
    });
  } catch (error) {
    if (!isGrammarCompatibilityError(error)) throw error;
    // Compatibility fallback: ask for a JSON object without schema-constrained
    // grammar, then parse and validate the JSON in JavaScript.
    return await engine.chat.completions.create({
      ...base,
      messages: [
        ...messages,
        {
          role: "system",
          content: "Modo de compatibilidade: responda com um único objeto JSON válido, sem markdown, sem crases e sem texto antes ou depois do JSON."
        }
      ]
    });
  }
}

function parseJsonContent(response) {
  let text = response.choices?.[0]?.message?.content || "";
  text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  return JSON.parse(text);
}

function validateBasicClaim(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["A saída não é um objeto JSON."];
  for (const key of ["object", "entities", "relations", "attributes", "ranges", "steps", "unresolvedSegments"]) {
    if (!(key in value)) errors.push(`Campo ausente: ${key}`);
  }
  for (const key of ["entities", "relations", "attributes", "ranges", "steps", "unresolvedSegments"]) {
    if (key in value && !Array.isArray(value[key])) errors.push(`Campo não é array: ${key}`);
  }
  return errors;
}

async function diagnose() {
  let adapter = null;
  try { adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch {}
  $("#backend").textContent = adapter ? "WebGPU disponível" : "WebGPU indisponível";
  $("#diag").className = "status " + (adapter ? "ok" : "bad");
  $("#diag").innerHTML = adapter
    ? "<strong>WebGPU disponível.</strong> A prova pode prosseguir."
    : "<strong>WebGPU não disponível.</strong> Use um Edge recente ou outro computador.";
  if (navigator.storage?.persisted) {
    const persisted = await navigator.storage.persisted();
    $("#persistState").textContent = persisted ? "concedida" : "não concedida";
  }
}

$("#persist").onclick = async () => {
  if (!navigator.storage?.persist) return alert("API de persistência não disponível.");
  const granted = await navigator.storage.persist();
  $("#persistState").textContent = granted ? "concedida" : "negada";
};

$("#load").onclick = async () => {
  if (!navigator.gpu) return alert("WebGPU não está disponível.");
  $("#load").disabled = true;
  $("#loadStatus").className = "status warn";
  $("#loadStatus").textContent = "Preparando carregamento...";
  try {
    const appConfig = { ...webllm.prebuiltAppConfig, cacheBackend: "cache" };
    engine = await webllm.CreateMLCEngine($("#model").value, {
      appConfig,
      initProgressCallback: (p) => {
        $("#progress").value = Number.isFinite(p.progress) ? p.progress : 0;
        $("#loadStatus").textContent = p.text || `Carregando: ${Math.round((p.progress || 0) * 100)}%`;
      }
    });
    $("#modelState").textContent = "sim";
    $("#loadStatus").className = "status ok";
    $("#loadStatus").innerHTML = "<strong>Modelo pronto.</strong> Agora a inferência ocorre no navegador.";
    $("#extract").disabled = false;
  } catch (error) {
    $("#loadStatus").className = "status bad";
    $("#loadStatus").textContent = `Falha: ${error.message}`;
    $("#load").disabled = false;
  }
};

$("#extract").onclick = async () => {
  const claim = $("#claim").value.trim();
  if (!claim) return alert("Cole uma reivindicação.");
  $("#extract").disabled = true;
  $("#inferenceStatus").className = "status warn";
  $("#inferenceStatus").textContent = "Inferência local em andamento...";
  try {
    const response = await createJsonCompletion(
      [{ role: "system", content: systemPrompt }, { role: "user", content: `REIVINDICAÇÃO:\n${claim}` }],
      claimSchema,
      1200
    );
    lastResult = parseJsonContent(response);
    const validationErrors = validateBasicClaim(lastResult);
    $("#output").textContent = JSON.stringify(lastResult, null, 2);
    $("#inferenceStatus").className = "status " + (validationErrors.length ? "warn" : "ok");
    $("#inferenceStatus").textContent = validationErrors.length
      ? `Extração concluída, mas a validação encontrou: ${validationErrors.join("; ")}`
      : "Extração concluída localmente.";
    $("#audit").disabled = false;
    $("#export").disabled = false;
  } catch (error) {
    $("#inferenceStatus").className = "status bad";
    if (isDeviceLostError(error)) {
      $("#inferenceStatus").textContent = "A GPU foi reiniciada por falta de memória ou limite do driver. Recarregue a página e use o modelo 1B.";
    } else {
      $("#inferenceStatus").textContent = `Falha: ${error.message}`;
    }
  } finally {
    $("#extract").disabled = false;
  }
};

$("#audit").onclick = async () => {
  if (!lastResult) return;
  $("#auditOutput").textContent = "Auditoria local em andamento...";
  try {
    const response = await createJsonCompletion(
      [
        { role: "system", content: "Audite uma extração estrutural contra o texto. Não corrija silenciosamente. Liste omissões, invenções e correferências erradas. Retorne somente JSON." },
        { role: "user", content: `TEXTO:\n${$("#claim").value}\n\nEXTRAÇÃO:\n${JSON.stringify(lastResult)}` }
      ],
      auditSchema,
      800
    );
    $("#auditOutput").textContent = JSON.stringify(parseJsonContent(response), null, 2);
  } catch (error) {
    $("#auditOutput").textContent = isDeviceLostError(error)
      ? "A GPU foi reiniciada. Recarregue a página e use o modelo 1B."
      : `Falha: ${error.message}`;
  }
};

$("#example").onclick = () => {
  $("#claim").value = "Controlador eletrônico para ventilador industrial, caracterizado por compreender um sensor de rotação; um circuito de condicionamento de sinal conectado ao sensor de rotação; um microcontrolador conectado ao circuito de condicionamento de sinal; e um estágio de potência conectado ao microcontrolador e configurado para acionar um motor elétrico do ventilador.";
};

$("#export").onclick = () => {
  const blob = new Blob([JSON.stringify({ claim: $("#claim").value, result: lastResult }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "poc-art32-webllm.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
};

diagnose();
