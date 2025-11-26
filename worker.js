// =================================================================================
//  项目: teleprompt-2api (Cloudflare Worker 单文件版)
//  版本: 1.0.0 (代号: Chimera Synthesis - Teleprompt)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-26
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 
//  teleprompt-v2-backend (RailWay) 的提示词优化服务，无损地转换为一个
//  高性能、兼容 OpenAI 标准的 API。
//  
//  特性:
//  1. [多模型路由] 支持 reason, standard, apps 三种优化模式。
//  2. [无限匿名] 自动生成随机 Email 头，绕过单用户限制。
//  3. [伪流式] 将上游阻塞响应转换为流式输出，兼容性满分。
//  4. [驾驶舱] 内置高颜值 Web UI。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "teleprompt-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_ORIGIN: "https://teleprompt-v2-backend-production.up.railway.app",
  
  // 伪装配置
  EXTENSION_ORIGIN: "chrome-extension://alfpjlcndmeoainjfgbbnphcidpnmoae",
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",

  // 模型定义与路径映射
  MODEL_MAP: {
    "teleprompt-reason": "/api/v1/prompt/optimize_reason_auth",   // 推理优化
    "teleprompt-standard": "/api/v1/prompt/optimize_auth",         // 标准优化
    "teleprompt-apps": "/api/v1/prompt/optimize_apps_auth"         // 应用/表格优化
  },
  
  DEFAULT_MODEL: "teleprompt-reason",
  
  // 伪流式生成的打字速度 (毫秒)
  STREAM_DELAY: 10
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 优先读取环境变量中的密钥
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 1. 预检请求
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') {
      return handleUI(request, apiKey);
    } 
    // 3. API 路由
    else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request, apiKey);
    } 
    // 4. 404
    else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

/**
 * API 路由分发
 */
async function handleApi(request, apiKey) {
  // 鉴权
  const authHeader = request.headers.get('Authorization');
  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return createErrorResponse('无效的 API Key。', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

/**
 * 处理 /v1/models
 */
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: Object.keys(CONFIG.MODEL_MAP).map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'teleprompt-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * 处理 /v1/chat/completions
 */
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    
    if (!lastMsg) {
      return createErrorResponse("未找到用户消息 (role: user)", 400, "invalid_request");
    }

    const prompt = lastMsg.content;
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const endpoint = CONFIG.MODEL_MAP[model] || CONFIG.MODEL_MAP[CONFIG.DEFAULT_MODEL];

    // 1. 构造上游请求
    // 生成随机 UUID 作为 email，实现匿名无限使用
    const randomEmail = `${crypto.randomUUID()}@anonymous.user`;
    
    const upstreamPayload = {
      text: prompt
    };

    const headers = {
      "Content-Type": "application/json",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Origin": CONFIG.EXTENSION_ORIGIN,
      "User-Agent": CONFIG.USER_AGENT,
      "email": randomEmail, // 关键：注入随机身份
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "none"
    };

    // 2. 发送请求到上游
    const response = await fetch(`${CONFIG.UPSTREAM_ORIGIN}${endpoint}`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`上游服务错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.success || !data.data) {
      throw new Error(`上游返回业务错误: ${JSON.stringify(data)}`);
    }

    const resultText = data.data;

    // 3. 处理响应 (流式或非流式)
    if (body.stream) {
      return handleStreamResponse(resultText, model, requestId);
    } else {
      return handleNormalResponse(resultText, model, requestId);
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

/**
 * 处理非流式响应
 */
function handleNormalResponse(text, model, requestId) {
  return new Response(JSON.stringify({
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

/**
 * 处理伪流式响应 (Pseudo-Streaming)
 */
function handleStreamResponse(text, model, requestId) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    // 模拟打字机效果
    const chunkSize = 2; // 每次发送的字符数
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunkContent = text.slice(i, i + chunkSize);
      const chunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: { content: chunkContent }, finish_reason: null }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      await new Promise(r => setTimeout(r, CONFIG.STREAM_DELAY));
    }
    
    // 发送结束块
    const endChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
  })();

  return new Response(readable, {
    headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
  });
}

// --- 辅助函数 ---
function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const modelsList = Object.keys(CONFIG.MODEL_MAP);
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; white-space: pre-wrap; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      
      .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #888; border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; margin-right: 5px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      
      details { margin-top: 10px; }
      summary { cursor: pointer; color: #888; font-size: 12px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🚀 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${modelsList.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            <div style="font-size:11px; color:#666; margin-top:5px;">
                * reason: 推理优化<br>
                * standard: 标准优化<br>
                * apps: 表格/应用优化
            </div>
        </div>

        <div class="box">
            <span class="label">输入提示词</span>
            <textarea id="prompt" rows="6" placeholder="输入需要优化的提示词...">我想找一下免费的API</textarea>
            <button id="btn-gen" onclick="generate()">开始优化</button>
        </div>
        
        <details>
            <summary>cURL 示例</summary>
            <div class="code-block" style="margin-top:5px" onclick="copy(this.innerText)">
curl ${origin}/v1/chat/completions \
-H "Authorization: Bearer ${apiKey}" \
-H "Content-Type: application/json" \
-d '{
  "model": "${CONFIG.DEFAULT_MODEL}",
  "messages": [{"role": "user", "content": "测试"}],
  "stream": true
}'
            </div>
        </details>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                Teleprompt 优化服务就绪。<br>
                输入原始提示词，获取优化后的版本。
            </div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert('请输入提示词');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 优化中...';

            // 清空欢迎语
            if(document.querySelector('.chat-window').innerText.includes('服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '<span class="spinner"></span> 正在连接 Teleprompt...');
            let fullText = "";

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: "user", content: prompt }],
                        stream: true
                    })
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error?.message || '请求失败');
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                aiMsg.innerHTML = ""; // 清空 loading

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0].delta.content;
                                if (content) {
                                    fullText += content;
                                    aiMsg.innerText = fullText;
                                    // 自动滚动
                                    document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
                                }
                            } catch (e) {}
                        }
                    }
                }

            } catch (e) {
                aiMsg.innerHTML = \`<span style="color:#CF6679">❌ 错误: \${e.message}</span>\`;
            } finally {
                btn.disabled = false;
                btn.innerText = "开始优化";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}
