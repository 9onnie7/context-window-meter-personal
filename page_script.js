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
  // Disabled by default. Enable temporarily only to inspect aggregate active-branch
  // tool-schema fingerprints when a tool result is missing.
  const TOOL_SCHEMA_DIAGNOSTICS = false;
  const CONVERSATION_REFRESH_DELAY_MS = 500;
  const AUTH_SESSION_URL = '/api/auth/session';
  let refreshTimer = null;
  let lastRouteConversationId = null;
  let inFlightConversationId = null;
  let sessionAuth = null;
  let sessionAuthPromise = null;

  function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const words = text.match(/\w+/g) || [];
    const nonWords = text.match(/[^\w\s]+/g) || [];
    const estimated = Math.ceil(words.length * 1.3 + nonWords.length * 1.1 + (text.length * 0.05));
    return Math.max(0, Math.round(estimated));
  }

  function trustedRuntimeContextLimit(modelSlug, runtimeModel) {
    const slug = String(modelSlug || '').toLowerCase();
    if (!runtimeModel || String(runtimeModel.modelSlug || '').toLowerCase() !== slug) return null;
    const limit = runtimeModel.contextWindowTokens;
    return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
  }

  function resolveContextLimit(modelSlug, runtimeModel = null) {
    const slug = String(modelSlug || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PERSONAL_CONTEXT_LIMIT_OVERRIDES, slug)) {
      return { limit: PERSONAL_CONTEXT_LIMIT_OVERRIDES[slug], source: 'personal override', confidence: 'user-configured' };
    }
    const runtimeLimit = trustedRuntimeContextLimit(slug, runtimeModel);
    if (runtimeLimit) {
      return { limit: runtimeLimit, source: 'ChatGPT runtime', confidence: 'confirmed' };
    }
    if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, slug)) {
      return { limit: MODEL_CONTEXT_LIMITS[slug], source: 'known ChatGPT inferred', confidence: 'inferred' };
    }
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (key !== 'default' && slug.includes(key)) return { limit, source: 'conservative pattern', confidence: 'low' };
    }
    return { limit: null, source: 'unknown', confidence: 'unknown' };
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
          limitConfidence: resolvedLimit.confidence,
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

  function toolSchemaFingerprint(message) {
    const content = message?.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    return {
      role: message?.author?.role || 'assistant',
      authorName: typeof message?.author?.name === 'string' ? message.author.name : null,
      recipient: typeof message?.recipient === 'string' ? message.recipient : null,
      contentType: typeof content.content_type === 'string' ? content.content_type : null,
      partKinds: [...new Set(parts.map(part => part === null ? 'null' : Array.isArray(part) ? 'array' : typeof part))],
      metadataKeys: Object.keys(metadata).sort(),
      estimatedLength: parts.reduce((total, part) => total + (typeof part === 'string' ? part.length : 0), 0)
    };
  }

  function logToolSchemaDiagnostics(activeNodes) {
    if (!TOOL_SCHEMA_DIAGNOSTICS) return;
    const fingerprints = activeNodes
      .map(node => toolSchemaFingerprint(node.message))
      .filter(item => item.role === 'tool' || item.authorName === 'web.search' || item.recipient ||
        /(?:tool|search|browse|execution)/i.test(item.contentType || ''));
    if (fingerprints.length) console.info?.('[ChatGPT Token Tracker] Tool schema fingerprints', { count: fingerprints.length, fingerprints });
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

    logToolSchemaDiagnostics(activeNodes);

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

  function resolveChatgptAccountId(session) {
    const candidates = [
      session?.chatgpt_account_id,
      session?.chatgptAccountId,
      session?.account?.chatgpt_account_id,
      session?.account?.chatgptAccountId
    ];
    return candidates.find(value => typeof value === 'string' && value.trim()) || null;
  }

  function hasHeader(headers, name) {
    if (!headers) return false;
    if (typeof headers.get === 'function') return Boolean(headers.get(name));
    if (Array.isArray(headers)) return headers.some(([key]) => String(key).toLowerCase() === name.toLowerCase());
    return Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());
  }

  function requestAuthInfo(args) {
    const input = args[0];
    const headers = args[1]?.headers || input?.headers;
    const hasAuthorization = hasHeader(headers, 'Authorization');
    return {
      authMode: hasAuthorization ? 'bearer' : 'none',
      hasAccountIdHeader: hasHeader(headers, 'ChatGPT-Account-ID')
    };
  }

  function detailRequestOptions(auth) {
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
    return { credentials: 'same-origin', headers };
  }

  async function getSessionAuth(refresh = false) {
    if (refresh) sessionAuth = null;
    if (sessionAuth?.accessToken) return sessionAuth;
    if (sessionAuthPromise) return sessionAuthPromise;

    sessionAuthPromise = originalFetch.call(window, AUTH_SESSION_URL, { credentials: 'same-origin' })
      .then(async response => {
        let session = null;
        if (response.ok && (response.headers?.get('content-type') || '').includes('json')) {
          try {
            session = await response.json();
          } catch (error) {
            // Keep the session unavailable without exposing its contents.
          }
        }
        const accessToken = typeof session?.accessToken === 'string' && session.accessToken.trim() ? session.accessToken : null;
        const accountId = accessToken ? resolveChatgptAccountId(session) : null;
        console.info?.('[ChatGPT Token Tracker] Auth session result', {
          status: response.status,
          hasAccessToken: Boolean(accessToken),
          hasUsableAccountId: Boolean(accountId)
        });
        sessionAuth = accessToken ? { accessToken, accountId } : null;
        return sessionAuth;
      })
      .catch(() => {
        console.info?.('[ChatGPT Token Tracker] Auth session result', {
          status: 'network-error',
          hasAccessToken: false,
          hasUsableAccountId: false
        });
        sessionAuth = null;
        return null;
      })
      .finally(() => {
        sessionAuthPromise = null;
      });

    return sessionAuthPromise;
  }

  function requestKind(requestUrl, method = 'GET') {
    const pathname = safePathname(requestUrl);
    if (/\/backend-api\/conversation\/init\/?$/.test(pathname)) return 'init';
    if (method === 'GET' && isConversationDetail(requestUrl)) return 'detail';
    if (isConversationSubmission(requestUrl)) return 'stream';
    return 'other';
  }

  async function processConversationResponse(response, requestUrl, method = 'GET', kind = 'detail', auth = { authMode: 'none', hasAccountIdHeader: false }) {
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
      authMode: auth.authMode,
      hasAccountIdHeader: auth.hasAccountIdHeader,
      status: response.status,
      contentType,
      hasMapping,
      hasCurrentNode: Boolean(json?.current_node),
      modelSlug,
      parseError
    });

    if (kind === 'detail' && hasMapping) processJsonMapping(json);
    return { status: response.status, hasMapping };
  }

  async function requestConversationDetail(conversationId) {
    if (!conversationId || inFlightConversationId === conversationId) return;
    const requestUrl = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    inFlightConversationId = conversationId;

    try {
      let auth = await getSessionAuth();
      for (let attempt = 0; auth?.accessToken && attempt < 2; attempt++) {
        const options = detailRequestOptions(auth);
        const response = await originalFetch.call(window, requestUrl, options);
        const result = await processConversationResponse(response, requestUrl, 'GET', 'detail', requestAuthInfo([requestUrl, options]));
        if ((result.status !== 401 && result.status !== 403) || attempt === 1) break;
        auth = await getSessionAuth(true);
      }
    } catch (error) {
      console.info?.('[ChatGPT Token Tracker] Conversation request result', {
        pathname: requestUrl,
        method: 'GET',
        requestKind: 'detail',
        status: 'network-error',
        authMode: 'none',
        hasAccountIdHeader: false
      });
    } finally {
      if (inFlightConversationId === conversationId) inFlightConversationId = null;
    }
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
        processConversationResponse(response.clone(), targetUrl, method, kind, requestAuthInfo(args));
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
