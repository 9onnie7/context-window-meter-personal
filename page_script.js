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
    'gpt-3.5-turbo': 16384
  };

  // Personal-only overrides. Add a model slug and its inferred context limit here.
  // Example: 'my-model-slug': 200000,
  const PERSONAL_CONTEXT_LIMIT_OVERRIDES = {};
  const CONVERSATION_REFRESH_DELAY_MS = 500;
  let refreshTimer = null;
  let lastRouteConversationId = null;
  let inFlightConversationId = null;

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
    return { limit: null, source: 'unknown' };
  }

  function contextMetrics(totalTokens, limit) {
    const safeTotal = Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
    const usedPercent = safeLimit ? Math.min(100, (safeTotal / safeLimit) * 100) : null;
    const remainingTokens = safeLimit ? Math.max(0, safeLimit - safeTotal) : null;
    return {
      totalTokens: safeTotal,
      limit: safeLimit,
      percentage: usedPercent == null ? null : Number(usedPercent.toFixed(2)),
      leftPercent: safeLimit ? Number(((remainingTokens / safeLimit) * 100).toFixed(2)) : null,
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

    console.log(`[ChatGPT Token Tracker] Estimated tokens: ${metrics.totalTokens}; model: ${modelSlug || 'unknown'}; limit source: ${resolvedLimit.source}`);

    window.postMessage(
      {
        type: 'CHATGPT_TOKEN_USAGE_UPDATE',
        data: {
          ...metrics,
          modelSlug,
          modelDisplayName: null,
          modelSource: modelSlug ? 'backend' : 'unknown',
          limitSource: resolvedLimit.source,
          dataSource: 'backend',
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

    let modelSlug = jsonObj.default_model_slug || null;
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

  function extractConversationId(pathname = window.location?.pathname) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    for (let index = 0; index < segments.length - 1; index++) {
      if (segments[index] === 'c' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(segments[index + 1])) {
        return segments[index + 1];
      }
    }
    return null;
  }

  function safePathname(url) {
    try {
      return new URL(url, window.location.origin).pathname;
    } catch (error) {
      return '';
    }
  }

  function requestKind(requestUrl, method = 'GET') {
    const pathname = safePathname(requestUrl);
    if (/\/backend-api\/conversation\/init\/?$/.test(pathname)) return 'init';
    if (method === 'GET' && isConversationDetail(requestUrl)) return 'detail';
    if (isConversationSubmission(requestUrl)) return 'stream';
    return 'other';
  }

  async function processConversationResponse(response, requestUrl, method = 'GET', kind = 'detail') {
    const contentType = response.headers?.get('content-type') || '';
    let json = null;
    let parseError = false;

    if (response.ok && contentType.includes('json')) {
      try {
        json = await response.json();
      } catch (error) {
        parseError = true;
      }
    }

    const hasMapping = Boolean(json?.mapping && typeof json.mapping === 'object');
    const modelSlug = json?.default_model_slug || null;
    console.info?.('[ChatGPT Token Tracker] Conversation request result', {
      pathname: safePathname(requestUrl),
      method,
      requestKind: kind,
      status: response.status,
      contentType,
      hasMapping,
      hasCurrentNode: Boolean(json?.current_node),
      modelSlug,
      parseError
    });

    if (kind === 'detail' && hasMapping) processJsonMapping(json);
    return hasMapping;
  }

  function requestConversationDetail(conversationId) {
    if (!conversationId || inFlightConversationId === conversationId) return;
    const requestUrl = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    inFlightConversationId = conversationId;

    originalFetch.call(window, requestUrl, { credentials: 'same-origin' })
      .then(response => processConversationResponse(response, requestUrl))
      .catch(() => console.info?.('[ChatGPT Token Tracker] Conversation request result', {
        pathname: requestUrl,
        method: 'GET',
        requestKind: 'detail',
        status: 'network-error'
      }))
      .finally(() => {
        if (inFlightConversationId === conversationId) inFlightConversationId = null;
      });
  }

  function scheduleConversationRefresh(conversationId = extractConversationId()) {
    if (!conversationId || typeof setTimeout !== 'function') return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      requestConversationDetail(conversationId);
    }, CONVERSATION_REFRESH_DELAY_MS);
  }

  function handleRouteChange() {
    const conversationId = extractConversationId();
    if (conversationId === lastRouteConversationId) return;
    lastRouteConversationId = conversationId;
    if (conversationId) scheduleConversationRefresh(conversationId);
  }

  function refreshConversationAfterStream(response) {
    if (!response.body?.getReader) return;
    const reader = response.clone().body.getReader();
    const drain = () => reader.read().then(({ done }) => {
      if (!done) return drain();
      const conversationId = extractConversationId();
      if (!conversationId) return;
      scheduleConversationRefresh(conversationId);
    }).catch(() => {});
    drain();
  }

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const targetUrl = response.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
      const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
      const kind = requestKind(targetUrl, method);
      if (kind === 'detail' || kind === 'init') {
        processConversationResponse(response.clone(), targetUrl, method, kind);
      } else if (kind === 'stream') refreshConversationAfterStream(response);
    } catch (err) {
      console.error('[ChatGPT Token Tracker] Fetch intercept error:', err);
    }

    return response;
  };

  for (const method of ['pushState', 'replaceState']) {
    const original = window.history?.[method];
    if (typeof original !== 'function') continue;
    window.history[method] = function (...args) {
      const result = original.apply(this, args);
      if (typeof setTimeout === 'function') setTimeout(handleRouteChange, 0);
      return result;
    };
  }
  window.addEventListener?.('popstate', handleRouteChange);
  window.navigation?.addEventListener?.('navigatesuccess', handleRouteChange);
  if (typeof setTimeout === 'function') setTimeout(handleRouteChange, 0);
})();
