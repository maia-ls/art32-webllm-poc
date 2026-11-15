import * as webllm from "https://esm.run/@mlc-ai/web-llm";

const $ = (s) => document.querySelector(s);
let engine = null;
let lastResult = null;

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["object", "entities", "relations", "attributes", "ranges", "steps", "unresolvedSegments"],
  properties: {
    object: { type: "string" },
    entities: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "type", "mentions", "sourceText"], properties: { id: {type:"string"}, type: {type:"string"}, mentions: {type:"array",items:{type:"string"}}, sourceText: {type:"string"} } } },
    relations: { type: "array", items: { type: "object", additionalProperties: false, required: ["subject", "predicate", "object", "sourceText"], properties: { subject:{type:"string"}, predicate:{type:"string"}, object:{type:"string"}, sourceText:{type:"string"} } } },
    attributes: { type:"array", items:{type:"object", additionalProperties:false, required:["subject","property","value","sourceText"], properties:{subject:{type:"string"},property:{type:"string"},value:{type:["string","number"]},sourceText:{type:"string"}}}},
    ranges: { type:"array", items:{type:"object", additionalProperties:false, required:["property","min","max","unit","sourceText"], properties:{property:{type:"string"},min:{type:"number"},max:{type:"number"},unit:{type:"string"},sourceText:{type:"string"}}}},
    steps: { type:"array", items:{type:"object", additionalProperties:false, required:["order","action","object","sourceText"], properties:{order:{type:"integer"},action:{type:"string"},object:{type:"string"},sourceText:{type:"string"}}}},
    unresolvedSegments: { type:"array", items:{type:"string"} }
  }
};

const systemPrompt = `Você extrai estrutura técnica de reivindicações de patente em português. Não avalie art. 32, novidade ou atividade inventiva. Não acrescente matéria. Use somente o texto fornecido.\nRegras:\n1. Entidade é objeto, componente, sinal, grandeza ou resultado técnico; nunca uma oração inteira.\n2. Resolva correferências: "o mecanismo" retoma entidade compatível já introduzida.\n3. Preserve compreende, conectado a, disposto entre, configurado para, em função de, etapas, atributos e faixas.\n4. sourceText deve ser cópia literal de trecho da reivindicação.\n5. Se não puder interpretar trecho técnico, coloque-o em unresolvedSegments.\n6. Retorne somente JSON aderente ao schema.`;

async function diagnose(){
  const gpu = !!navigator.gpu;
  let adapter = null;
  try { adapter = gpu ? await navigator.gpu.requestAdapter() : null; } catch {}
  $("#backend").textContent = adapter ? "WebGPU disponível" : "WebGPU indisponível";
  $("#diag").className = "status " + (adapter ? "ok" : "bad");
  $("#diag").innerHTML = adapter ? "<strong>WebGPU disponível.</strong> A prova pode prosseguir." : "<strong>WebGPU não disponível.</strong> Teste um Edge/Chrome recente ou outro computador.";
  if(navigator.storage?.persisted){
    const p = await navigator.storage.persisted();
    $("#persistState").textContent = p ? "concedida" : "não concedida";
  }
}

$("#persist").onclick = async () => {
  if(!navigator.storage?.persist) return alert("API de persistência não disponível.");
  const granted = await navigator.storage.persist();
  $("#persistState").textContent = granted ? "concedida" : "negada";
};

$("#load").onclick = async () => {
  if(!navigator.gpu) return alert("WebGPU não está disponível.");
  $("#load").disabled = true;
  $("#loadStatus").className = "status warn";
  $("#loadStatus").textContent = "Preparando carregamento...";
  try {
    const appConfig = {...webllm.prebuiltAppConfig, cacheBackend: "indexeddb"};
    engine = await webllm.CreateMLCEngine($("#model").value, {
      appConfig,
      initProgressCallback: (p) => {
        $("#progress").value = Number.isFinite(p.progress) ? p.progress : 0;
        $("#loadStatus").textContent = p.text || `Carregando: ${Math.round((p.progress||0)*100)}%`;
      }
    });
    $("#modelState").textContent = "sim";
    $("#loadStatus").className = "status ok";
    $("#loadStatus").innerHTML = "<strong>Modelo pronto.</strong> Agora a inferência ocorre no navegador.";
    $("#extract").disabled = false;
  } catch(e) {
    $("#loadStatus").className = "status bad";
    $("#loadStatus").textContent = `Falha: ${e.message}`;
    $("#load").disabled = false;
  }
};

$("#extract").onclick = async () => {
  const claim = $("#claim").value.trim();
  if(!claim) return alert("Cole uma reivindicação.");
  $("#extract").disabled = true;
  $("#inferenceStatus").className = "status warn";
  $("#inferenceStatus").textContent = "Inferência local em andamento...";
  try {
    const rsp = await engine.chat.completions.create({
      messages: [{role:"system",content:systemPrompt},{role:"user",content:`REIVINDICAÇÃO:\n${claim}`}],
      temperature: 0,
      max_tokens: 1800,
      response_format: {type:"json_object", schema}
    });
    const text = rsp.choices[0].message.content;
    lastResult = JSON.parse(text);
    $("#output").textContent = JSON.stringify(lastResult,null,2);
    $("#inferenceStatus").className = "status ok";
    $("#inferenceStatus").textContent = "Extração concluída localmente.";
    $("#audit").disabled = false;
    $("#export").disabled = false;
  } catch(e) {
    $("#inferenceStatus").className = "status bad";
    $("#inferenceStatus").textContent = `Falha: ${e.message}`;
  } finally { $("#extract").disabled = false; }
};

$("#audit").onclick = async () => {
  if(!lastResult) return;
  $("#auditOutput").textContent = "Auditoria local em andamento...";
  const auditSchema = {type:"object",additionalProperties:false,required:["valid","missingSegments","inventedElements","wrongCoreferences","notes"],properties:{valid:{type:"boolean"},missingSegments:{type:"array",items:{type:"string"}},inventedElements:{type:"array",items:{type:"string"}},wrongCoreferences:{type:"array",items:{type:"string"}},notes:{type:"array",items:{type:"string"}}}};
  try {
    const rsp = await engine.chat.completions.create({messages:[{role:"system",content:"Audite uma extração estrutural contra o texto. Não corrija silenciosamente. Liste omissões, invenções e correferências erradas. Retorne somente JSON."},{role:"user",content:`TEXTO:\n${$("#claim").value}\n\nEXTRAÇÃO:\n${JSON.stringify(lastResult)}`}],temperature:0,max_tokens:1000,response_format:{type:"json_object",schema:auditSchema}});
    $("#auditOutput").textContent = JSON.stringify(JSON.parse(rsp.choices[0].message.content),null,2);
  } catch(e) { $("#auditOutput").textContent = `Falha: ${e.message}`; }
};

$("#example").onclick = () => { $("#claim").value = "Controlador eletrônico para ventilador industrial, caracterizado por compreender um sensor de rotação; um circuito de condicionamento de sinal conectado ao sensor de rotação; um microcontrolador conectado ao circuito de condicionamento de sinal; e um estágio de potência conectado ao microcontrolador e configurado para acionar um motor elétrico do ventilador."; };

$("#export").onclick = () => {
  const blob = new Blob([JSON.stringify({claim:$("#claim").value,result:lastResult},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="poc-art32-webllm.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);
};

diagnose();
