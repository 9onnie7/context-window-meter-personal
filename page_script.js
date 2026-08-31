(function () {
  if (window.__chatgpt_token_tracker_injected) return;
  window.__chatgpt_token_tracker_injected = true;

  console.log('[ChatGPT Token Tracker] Injected into MAIN world context.');

  const MODEL_CONTEXT_LIMITS = {
    'gpt-5-6-thinking': 200000,
    'gpt-5': 200000,
    'o1': 200000,
    'o1-preview': 128000,
    'o1-mini': 128000,
    'o3-mini': 200000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16384,
    'default': 128000
  };

  // Personal-only overrides. Add a model slug and its inferred context limit here.
  // Example: 'my-model-slug': 200000,
  const PERSONAL_CONTEXT_LIMIT_OVERRIDES = {};
  const CONVERSATION_REFRESH_DELAY_MS = 500;
  let refreshTimer = null;

  function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const words = text.match(/\w+/g) || [];
    const nonWords = text.match(/[^\w\s]+/g) || [];
    const estimated = Math.ceil(words.length * 1.3 + nonWords.length * 1.1 + (text.length * 0.05));
    return Math.max(0, Math.round(estimated));
  }

  function resolveContextLimit(modelSlug) {
    const slug = String(modelSlug || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PERSONAL_CONTEXT_LIMIT_OVERRIDES, slug)) {
      return { limit: PERSONAL_CONTEXT_LIMIT_OVERRIDES[slug], source: 'override' };
    }
    if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, slug)) {
      return { limit: MODEL_CONTEXT_LIMITS[slug], source: 'exact mapping' };
    }
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (key !== 'default' && slug.includes(key)) return { limit, source: 'pattern mapping' };
    }
    return { limit: MODEL_CONTEXT_LIMITS.default, source: 'default fallback' };
  }

  function contextMetrics(totalTokens, limit) {
    const safeTotal = Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
    const usedPercent = safeLimit ? Math.min(100, (safeTotal / safeLimit) * 100) : 0;
    const remainingTokens = safeLimit ? Math.max(0, safeLimit - safeTotal) : 0;
    return {
      totalTokens: safeTotal,
      limit: safeLimit,
      percentage: Number(usedPercent.toFixed(2)),
      leftPercent: Number((safeLimit ? (remainingTokens / safeLimit) * 100 : 0).toFixed(2)),
      remainingTokens
    };
  }

  function dispatchTokenUpdate(textByRole, modelSlug) {
    let totalTokens = 0;
    const breakdown = {};

    for (const [role, text] of Object.entries(textByRole)) {
      const tokens = estimateTokens(text);
      breakdown[role] = tokens;
      totalTokens += tokens;
    }

    if (totalTokens === 0) return;

    const resolvedLimit = resolveContextLimit(modelSlug);
    const metrics = contextMetrics(totalTokens, resolvedLimit.limit);

    console.log(`[ChatGPT Token Tracker] Estimated tokens: ${metrics.totalTokens} (${metrics.percentage.toFixed(1)}% used) for ${modelSlug}`);

    window.postMessage(
      {
        type: 'CHATGPT_TOKEN_USAGE_UPDATE',
        data: {
          ...metrics,
          modelSlug,
          limitSource: resolvedLimit.source,
          breakdown,
          charCount: Object.values(textByRole).reduce((a, b) => a + b.length, 0),
          updatedAt: new Date().toISOString()
        }
      },
      '*'
    );
  }

  function extractContentText(content) {
    if (!content || typeof content !== 'object') return '';

    const text = [];
    const appendValue = value => {
      if (typeof value === 'string') text.push(value);
      else if (value && typeof value === 'object') text.push(JSON.stringify(value));
    };

    if (Array.isArray(content.parts)) content.parts.forEach(appendValue);
    appendValue(content.text);
    appendValue(content.result);
    appendValue(content.content);
    appendValue(content.summary);
    appendValue(content.model_set_context);
    appendValue(content.structured_context);
    appendValue(content.repo_summary);
    appendValue(content.repository);
    appendValue(content.user_instructions);
    appendValue(content.user_profile);

    if (Array.isArray(content.thoughts)) {
      for (const thought of content.thoughts) {
        if (typeof thought === 'string') {
          text.push(thought);
          continue;
        }
        if (!thought || typeof thought !== 'object') continue;
        appendValue(thought.summary);
        appendValue(thought.content);
        if (Array.isArray(thought.chunks)) thought.chunks.forEach(appendValue);
      }
    }

    return text.join('\n');
  }

  function getMessageRole(message) {
    const contentType = message.content?.content_type;
    if (contentType === 'thoughts' || contentType === 'reasoning_recap') return 'thought';
    if (contentType === 'model_editable_context') return 'system';

    const role = message.author?.role || 'assistant';
    if (role === 'tool' || role === 'system' || role === 'user') return role;
    return 'assistant';
  }

  function getMessageModelSlug(message) {
    return message.metadata?.model_slug ||
      message.metadata?.resolved_model_slug ||
      message.metadata?.default_model_slug ||
      null;
  }

  function processJsonMapping(jsonObj) {
    if (!jsonObj || typeof jsonObj !== 'object') return;
    const mapping = jsonObj.mapping;
    if (!mapping || typeof mapping !== 'object') return;

    let modelSlug = jsonObj.default_model_slug || 'gpt-4o';
    const textByRole = {
      user: '',
      assistant: '',
      system: '',
      tool: '',
      thought: ''
    };

    const activeNodes = [];
    const visitedNodeIds = new Set();
    let nodeId = jsonObj.current_node;

    while (nodeId && !visitedNodeIds.has(nodeId)) {
      const node = mapping[nodeId];
      if (!node) break;
      activeNodes.push(node);
      visitedNodeIds.add(nodeId);
      nodeId = node.parent;
    }

    if (activeNodes.length > 0) activeNodes.reverse();
    else activeNodes.push(...Object.values(mapping));

    for (const node of activeNodes) {
      const msg = node.message;
      if (!msg) continue;

      const targetRole = getMessageRole(msg);
      const messageModelSlug = getMessageModelSlug(msg);
      if (messageModelSlug) modelSlug = messageModelSlug;

      textByRole[targetRole] += extractContentText(msg.content);
    }

    dispatchTokenUpdate(textByRole, modelSlug);
  }

  function isConversationDetail(url) {
    if (!url || typeof url !== 'string') return false;
    return /^(?:https?:\/\/[^/]+)?\/backend-api\/conversation\/[^/?#]+\/?(?:[?#].*)?$/.test(url);
  }

  function isConversationSubmission(url) {
    return /^(?:https?:\/\/[^/]+)?\/backend-api\/(?:f\/)?conversation\/?(?:[?#].*)?$/.test(url || '');
  }

  function currentConversationId() {
    return window.location?.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || null;
  }

  function refreshConversationAfterStream(response) {
    if (!response.body?.getReader) return;
    const reader = response.clone().body.getReader();
    const drain = () => reader.read().then(({ done }) => {
      if (!done) return drain();
      const conversationId = currentConversationId();
      if (!conversationId) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => window.fetch(`/backend-api/conversation/${conversationId}`), CONVERSATION_REFRESH_DELAY_MS);
    }).catch(() => {});
    drain();
  }

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const targetUrl = response.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
      if (isConversationDetail(targetUrl)) {

        response.clone().json().then(json => {
          processJsonMapping(json);
        }).catch(err => {
          console.error('[ChatGPT Token Tracker] Conversation JSON parse error:', err);
        });
      } else if (isConversationSubmission(targetUrl)) refreshConversationAfterStream(response);
    } catch (err) {
      console.error('[ChatGPT Token Tracker] Fetch intercept error:', err);
    }

    return response;
  };
})();
