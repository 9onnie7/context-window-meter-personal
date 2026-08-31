const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function runScript(filename, globals, transform = source => source) {
  const source = transform(fs.readFileSync(path.join(projectRoot, filename), 'utf8'));
  vm.runInNewContext(source, globals, { filename });
}

function waitForStreams() {
  return new Promise(resolve => setTimeout(resolve, 20));
}

test('positions the token widget in the bottom-right corner', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'styles.css'), 'utf8');
  const badgeRule = css.match(/\.gpt-token-badge \{([^}]*)\}/)?.[1] || '';
  const detailsRule = css.match(/\.gpt-token-details-card \{([^}]*)\}/)?.[1] || '';

  assert.match(badgeRule, /bottom:\s*1rem;/);
  assert.match(badgeRule, /right:\s*4rem;/);
  assert.doesNotMatch(badgeRule, /top:/);
  assert.match(detailsRule, /bottom:\s*5rem;/);
  assert.match(detailsRule, /right:\s*4rem;/);
  assert.doesNotMatch(detailsRule, /top:/);
});

test('parses the conversation detail JSON response instead of resume SSE', async () => {
  const responseBody = fs.readFileSync(
    path.join(projectRoot, 'test', 'fixtures', 'conversation-sample.json'),
    'utf8'
  );
  const updates = [];
  const window = {
    fetch: async () => new Response(responseBody, {
      headers: { 'content-type': 'application/json' }
    }),
    postMessage(message) {
      if (message.type === 'CHATGPT_TOKEN_USAGE_UPDATE') updates.push(message.data);
    }
  };
  window.window = window;

  runScript('page_script.js', {
    window,
    Response,
    TextDecoder,
    console: { log() {}, error() {} }
  });

  await window.fetch('https://chatgpt.com/backend-api/f/conversation/resume');
  await waitForStreams();
  assert.equal(updates.length, 0, 'resume responses should be ignored');

  await window.fetch('https://chatgpt.com/backend-api/conversation/6a5e4247-f128-83eb-a52b-e956275dcc0d');
  await waitForStreams();

  const usage = updates.at(-1);
  assert.ok(usage, 'expected a token usage update');
  assert.equal(usage.modelSlug, 'gpt-5-6-thinking');
  assert.ok(usage.breakdown.user > 0, 'expected user content');
  assert.ok(usage.breakdown.assistant > 0, 'expected assistant content');
  assert.equal(typeof usage.breakdown.system, 'number');
  assert.ok(usage.breakdown.tool > 0, 'expected tool content');
  assert.ok(usage.breakdown.thought > 0, 'expected reasoning content');
  assert.equal(usage.limit, 200000);
});

test('counts only active-branch content across conversation JSON schemas', async () => {
  const responseBody = JSON.stringify({
    current_node: 'recap',
    default_model_slug: 'gpt-5-6-thinking',
    mapping: {
      root: { parent: null, children: ['system', 'off-path'] },
      system: {
        parent: 'root',
        children: ['profile'],
        message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['system context'] } }
      },
      profile: {
        parent: 'system',
        children: ['recap'],
        message: {
          author: { role: 'user' },
          content: {
            content_type: 'user_editable_context',
            user_instructions: 'user instructions',
            user_profile: 'user profile'
          }
        }
      },
      recap: {
        parent: 'profile',
        children: [],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'reasoning_recap', content: 'reasoning recap' },
          metadata: { model_slug: 'gpt-5-6-thinking' }
        }
      },
      'off-path': {
        parent: 'root',
        children: [],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['must not be counted'] }
        }
      }
    }
  });
  const updates = [];
  const window = {
    fetch: async () => new Response(responseBody, {
      headers: { 'content-type': 'application/json' }
    }),
    postMessage(message) {
      if (message.type === 'CHATGPT_TOKEN_USAGE_UPDATE') updates.push(message.data);
    }
  };
  window.window = window;

  runScript('page_script.js', {
    window,
    Response,
    TextDecoder,
    console: { log() {}, error() {} }
  });

  await window.fetch('https://chatgpt.com/backend-api/conversation/conversation-id');
  await waitForStreams();

  const usage = updates.at(-1);
  assert.ok(usage.breakdown.system > 0);
  assert.ok(usage.breakdown.user > 0);
  assert.ok(usage.breakdown.thought > 0);
  assert.equal(usage.breakdown.assistant, 0);
});

test('resolves override, trusted runtime, and inferred context limits without API fallback', () => {
  const window = { fetch() {}, postMessage() {} };
  window.window = window;
  runScript('page_script.js', { window, console: { log() {}, error() {} } }, source => source
    .replace("const PERSONAL_CONTEXT_LIMIT_OVERRIDES = {};", "const PERSONAL_CONTEXT_LIMIT_OVERRIDES = { 'gpt-5': 12345 };")
    .replace('})();', ';window.__meterTestApi = { resolveContextLimit, contextMetrics };})();')
  );

  const resolve = (...args) => JSON.stringify(window.__meterTestApi.resolveContextLimit(...args));

  assert.equal(resolve('gpt-5', { modelSlug: 'gpt-5', contextWindowTokens: 180000 }), JSON.stringify({
    limit: 12345, source: 'personal override', confidence: 'user-configured'
  }));
  assert.equal(resolve('gpt-4o', { modelSlug: 'gpt-4o', contextWindowTokens: 180000 }), JSON.stringify({
    limit: 180000, source: 'ChatGPT runtime', confidence: 'confirmed'
  }));
  assert.equal(resolve('gpt-5-6-thinking'), JSON.stringify({
    limit: 200000, source: 'known ChatGPT inferred', confidence: 'inferred'
  }));
  assert.equal(resolve('gpt-5-6-thinking', { modelSlug: 'gpt-5-6-thinking', outputTokens: 1050000 }), JSON.stringify({
    limit: 200000, source: 'known ChatGPT inferred', confidence: 'inferred'
  }));
  assert.equal(resolve('gpt-4o', { modelSlug: 'other-model', contextWindowTokens: 999999 }), JSON.stringify({
    limit: 128000, source: 'known ChatGPT inferred', confidence: 'inferred'
  }));
  assert.equal(resolve('unknown-model'), JSON.stringify({
    limit: null, source: 'unknown', confidence: 'unknown'
  }));
  assert.equal(JSON.stringify(window.__meterTestApi.contextMetrics(250, 100)), JSON.stringify({
    totalTokens: 250,
    limit: 100,
    percentage: 100,
    leftPercent: 0,
    remainingTokens: 0
  }));
  assert.equal(JSON.stringify(window.__meterTestApi.contextMetrics(NaN, 0)), JSON.stringify({
    totalTokens: 0,
    limit: null,
    percentage: null,
    leftPercent: null,
    remainingTokens: null
  }));
});

test('uses full-mapping wording and keeps tool diagnostics disabled by default', () => {
  const pageScript = fs.readFileSync(path.join(projectRoot, 'page_script.js'), 'utf8');
  const contentScript = fs.readFileSync(path.join(projectRoot, 'content.js'), 'utf8');

  assert.match(pageScript, /const TOOL_SCHEMA_DIAGNOSTICS = false;/);
  assert.match(pageScript, /Tool schema fingerprints/);
  assert.match(contentScript, /'Estimated · full mapping'/);
  assert.doesNotMatch(contentScript, /Estimated · \$\{currentData\.limitSource\}/);
  assert.match(contentScript, /Limit: \$\{currentData\.limitConfidence \|\| 'unknown'\}/);
});

test('keeps an undetected backend model and context limit unknown', async () => {
  const updates = [];
  const responseBody = JSON.stringify({
    current_node: 'message',
    mapping: {
      message: {
        parent: null,
        message: { author: { role: 'user' }, content: { parts: ['unknown model'] } }
      }
    }
  });
  const window = {
    fetch: async () => new Response(responseBody, { headers: { 'content-type': 'application/json' } }),
    postMessage(message) {
      if (message.type === 'CHATGPT_TOKEN_USAGE_UPDATE') updates.push(message.data);
    }
  };
  window.window = window;
  runScript('page_script.js', { window, Response, console: { log() {}, info() {}, error() {} } });

  await window.fetch('/backend-api/conversation/conversation-id');
  await waitForStreams();

  const usage = updates.at(-1);
  assert.equal(usage.modelSlug, null);
  assert.equal(usage.modelSource, 'unknown');
  assert.equal(usage.limit, null);
  assert.equal(usage.percentage, null);
  assert.equal(usage.leftPercent, null);
});

test('refreshes the active conversation once after a reply stream finishes', async () => {
  const updates = [];
  const detail = JSON.stringify({
    current_node: 'message',
    default_model_slug: 'gpt-4o',
    mapping: {
      message: {
        parent: null,
        message: { author: { role: 'user' }, content: { parts: ['refresh me'] } }
      }
    }
  });
  const requestedUrls = [];
  const window = {
    location: { pathname: '/' },
    fetch: async url => {
      requestedUrls.push(url);
      const body = url === '/api/auth/session'
        ? JSON.stringify({ accessToken: 'test-token' })
        : url === '/backend-api/f/conversation' ? 'data: [DONE]\n\n' : detail;
      return new Response(body, {
        headers: { 'content-type': url === '/backend-api/f/conversation' ? 'text/event-stream' : 'application/json' }
      });
    },
    postMessage(message) {
      if (message.type === 'CHATGPT_TOKEN_USAGE_UPDATE') updates.push(message.data);
    }
  };
  window.window = window;
  runScript('page_script.js', { window, Response, setTimeout, clearTimeout, console: { log() {}, error() {} } });

  const submission = window.fetch('/backend-api/f/conversation');
  window.location.pathname = '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await submission;
  await new Promise(resolve => setTimeout(resolve, 600));

  assert.ok(requestedUrls.includes('/backend-api/conversation/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  assert.equal(requestedUrls.filter(url => url === '/backend-api/conversation/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').length, 1);
  assert.ok(updates.at(-1), 'the refreshed detail should produce a usage update');
});

test('fetches one same-origin detail response on an initial conversation route', async () => {
  const requested = [];
  const detail = JSON.stringify({
    current_node: 'message',
    default_model_slug: 'gpt-4o',
    mapping: {
      message: {
        parent: null,
        message: { author: { role: 'user' }, content: { parts: ['initial route'] } }
      }
    }
  });
  const window = {
    location: { pathname: '/g/g-p-xxxxxxxx-project/c/11111111-2222-3333-4444-555555555555', origin: 'https://chatgpt.com' },
    history: {
      pushState() {},
      replaceState() {}
    },
    addEventListener() {},
    fetch: async (url, options) => {
      requested.push({ url, options });
      const body = url === '/api/auth/session' ? JSON.stringify({ accessToken: 'test-token' }) : detail;
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
    postMessage() {}
  };
  window.window = window;
  runScript('page_script.js', { window, URL, Response, setTimeout, clearTimeout, console: { log() {}, info() {}, error() {} } });

  window.history.replaceState({}, '', '/g/g-p-xxxxxxxx-project/c/11111111-2222-3333-4444-555555555555');
  await new Promise(resolve => setTimeout(resolve, 600));

  const detailRequests = requested.filter(item => item.url === '/backend-api/conversation/11111111-2222-3333-4444-555555555555');
  assert.equal(detailRequests.length, 1);
  assert.equal(detailRequests[0].options.credentials, 'same-origin');
});

test('uses in-memory session auth for detail requests without logging secrets', async () => {
  const requested = [];
  const diagnostics = [];
  const updates = [];
  const detail = JSON.stringify({
    current_node: 'message',
    default_model_slug: 'gpt-5-6-thinking',
    mapping: {
      message: {
        parent: null,
        message: { author: { role: 'user' }, content: { parts: ['authenticated detail'] } }
      }
    }
  });
  const window = {
    location: { pathname: '/', origin: 'https://chatgpt.com' },
    fetch: async (url, options) => {
      requested.push({ url, options });
      const body = url === '/api/auth/session'
        ? JSON.stringify({ accessToken: 'secret-token', chatgpt_account_id: 'secret-account' })
        : detail;
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
    postMessage(message) {
      if (message.type === 'CHATGPT_TOKEN_USAGE_UPDATE') updates.push(message.data);
    }
  };
  window.window = window;
  runScript('page_script.js', {
    window,
    URL,
    Response,
    console: { log() {}, error() {}, info(...args) { diagnostics.push(JSON.stringify(args)); } }
  }, source => source.replace('})();', ';window.__meterTestApi = { requestConversationDetail };})();'));

  await window.__meterTestApi.requestConversationDetail('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  const detailRequest = requested.at(-1);
  assert.equal(requested.length, 2, 'session and detail should use the saved original fetch exactly once each');
  assert.equal(detailRequest.options.headers.Authorization, 'Bearer secret-token');
  assert.equal(detailRequest.options.headers['ChatGPT-Account-ID'], 'secret-account');
  assert.ok(updates.at(-1), 'authenticated mapping should reach the existing parser');
  assert.doesNotMatch(diagnostics.join('\n'), /secret-token|secret-account/);
});

test('stays partial when session has no access token and never invents an account id', async () => {
  const requested = [];
  const window = {
    location: { pathname: '/', origin: 'https://chatgpt.com' },
    fetch: async (url, options) => {
      requested.push({ url, options });
      return new Response(JSON.stringify({ account: { id: 'workspace-id' } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  };
  window.window = window;
  runScript('page_script.js', { window, URL, Response, console: { log() {}, info() {}, error() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { requestConversationDetail };})();')
  );

  await window.__meterTestApi.requestConversationDetail('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, '/api/auth/session');
});

test('retries authentication once on 401 and does not add a generic account id header', async () => {
  const requested = [];
  let sessionCount = 0;
  let detailCount = 0;
  const detail = JSON.stringify({
    current_node: 'message',
    default_model_slug: 'gpt-5-6-thinking',
    mapping: {
      message: {
        parent: null,
        message: { author: { role: 'user' }, content: { parts: ['retry detail'] } }
      }
    }
  });
  const window = {
    location: { pathname: '/', origin: 'https://chatgpt.com' },
    fetch: async (url, options) => {
      requested.push({ url, options });
      if (url === '/api/auth/session') {
        sessionCount++;
        return new Response(JSON.stringify({ accessToken: `token-${sessionCount}`, account: { id: 'workspace-id' } }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      detailCount++;
      return new Response(detailCount === 1 ? '' : detail, {
        status: detailCount === 1 ? 401 : 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    postMessage() {}
  };
  window.window = window;
  runScript('page_script.js', { window, URL, Response, console: { log() {}, info() {}, error() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { requestConversationDetail };})();')
  );

  await window.__meterTestApi.requestConversationDetail('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  assert.equal(sessionCount, 2);
  assert.equal(detailCount, 2);
  for (const request of requested.filter(item => item.url.startsWith('/backend-api/'))) {
    assert.equal(request.options.headers['ChatGPT-Account-ID'], undefined);
  }
});

test('extracts route ids and prefers backend model data over the UI label', () => {
  let showModel = true;
  let modelAria = 'Model: GPT-5.6 Thinking';
  const modelElement = {
    get innerText() { return modelAria ? 'Thinking' : '高'; },
    getAttribute(name) {
      if (name === 'aria-label') return modelAria;
      return null;
    }
  };
  const document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector(selector) {
      return showModel && selector.includes('__composer-pill') ? modelElement : null;
    }
  };
  const window = { addEventListener() {} };
  window.window = window;
  runScript('content.js', { window, document, MutationObserver: class {}, Intl, console: { log() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { detectUiModel, withModelFallback, createDomEstimate, contextWarning };})();')
  );

  assert.equal(JSON.stringify(window.__meterTestApi.detectUiModel()), JSON.stringify({
    modelSlug: null,
    modelDisplayName: 'GPT-5.6 Thinking',
    modelSource: 'ui'
  }));
  showModel = false;
  assert.equal(window.__meterTestApi.detectUiModel().modelDisplayName, 'Unknown');
  showModel = true;
  modelAria = null;
  assert.equal(window.__meterTestApi.detectUiModel().modelDisplayName, 'Unknown');
  modelAria = 'Model: GPT-5.6 Thinking';
  const backend = window.__meterTestApi.withModelFallback({ modelSlug: 'backend-model', modelSource: 'backend' });
  assert.equal(backend.modelDisplayName, 'backend-model');
  assert.equal(backend.modelSource, 'backend');

  const dom = window.__meterTestApi.createDomEstimate(100, 40, 60);
  assert.equal(dom.dataSource, 'dom');
  assert.equal(dom.limit, null);
  assert.equal(dom.percentage, null);
  assert.equal(window.__meterTestApi.contextWarning(dom), '');

  const pageWindow = {
    fetch() {},
    postMessage() {},
    location: { pathname: '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', origin: 'https://chatgpt.com' }
  };
  pageWindow.window = pageWindow;
  runScript('page_script.js', { window: pageWindow, URL, console: { log() {}, info() {}, error() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { extractConversationId, requestKind };})();')
  );
  const { extractConversationId, requestKind } = pageWindow.__meterTestApi;
  assert.equal(extractConversationId(), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(extractConversationId('/g/g-p-xxxxxxxx-project/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(extractConversationId('/g/g-xxxxxxxx-custom/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(extractConversationId('/g/g-p-xxxxxxxx-project'), null);
  assert.equal(extractConversationId('/g/g-p-xxxxxxxx-project/project'), null);
  assert.equal(extractConversationId('/g/g-p-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-project'), null);
  assert.equal(requestKind('/backend-api/conversation/init', 'POST'), 'init');
  assert.equal(requestKind('/backend-api/conversation/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'GET'), 'detail');
});

test('uses the intended context guard boundaries', () => {
  const window = { addEventListener() {} };
  window.window = window;
  runScript('content.js', {
    window,
    document: { readyState: 'loading', addEventListener() {} },
    MutationObserver: class {},
    Intl,
    console: { log() {} }
  }, source => source.replace('})();', ';window.__meterTestApi = { guardMessage, getStateColor };})();'));

  const { guardMessage } = window.__meterTestApi;
  assert.equal(guardMessage(36), '');
  assert.equal(guardMessage(35), 'Consider wrapping up this phase');
  assert.equal(guardMessage(26), 'Consider wrapping up this phase');
  assert.equal(guardMessage(25), 'New chat recommended');
  assert.equal(guardMessage(16), 'New chat recommended');
  assert.equal(guardMessage(15), 'High context pressure');
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.classList = { add() {}, remove() {} };
    this.innerText = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener() {}
  setAttribute() {}

  contains(target) {
    return target === this || this.children.some(child => child.contains(target));
  }
}

test('ignores DOM mutations made by the tracker widget', () => {
  let observer;
  let fallbackLogs = 0;
  const elements = new Map();
  const body = new FakeElement('body');
  const originalAppendChild = body.appendChild.bind(body);
  body.appendChild = child => {
    originalAppendChild(child);
    if (child.id) elements.set(child.id, child);
    return child;
  };

  const userMessage = new FakeElement('div');
  userMessage.innerText = 'A message that should be counted once.';

  const document = {
    body,
    readyState: 'complete',
    createElement: tagName => new FakeElement(tagName),
    getElementById: id => elements.get(id) || null,
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector === 'article') return [];
      if (selector.includes('data-message-author-role="user"')) return [userMessage];
      return [];
    }
  };
  const window = { addEventListener() {} };
  window.window = window;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }

    observe() {}
  }

  runScript('content.js', {
    window,
    document,
    MutationObserver: FakeMutationObserver,
    Intl,
    console: {
      log(message) {
        if (message.includes('Partial DOM estimate')) fallbackLogs++;
      }
    }
  });

  assert.equal(fallbackLogs, 1);
  const widget = elements.get('chatgpt-token-usage-badge');
  observer.callback([{ type: 'childList', target: widget }]);
  assert.equal(fallbackLogs, 1);
});
