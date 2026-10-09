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

function catalogHarness() {
  const updates = [];
  const requests = [];
  const id = '11111111-1111-4111-8111-111111111111';
  let body = {};
  let options = { headers: { 'content-type': 'application/json' } };
  const window = {
    location: { origin: 'https://chatgpt.com', pathname: `/c/${id}` },
    fetch: async (...args) => {
      requests.push(args);
      return new Response(JSON.stringify(body), options);
    },
    postMessage: message => updates.push(message.data)
  };
  window.window = window;
  runScript('page_script.js', { window, URL, Response, console: { log() {}, error() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { resolveContextLimit };})();'));
  return {
    window, updates, requests, id,
    async respond(url, json, responseOptions = options, init) {
      body = json;
      options = responseOptions;
      const response = await window.fetch(url, init);
      assert.deepEqual(await response.json(), json, 'page retains the original response body');
      await waitForStreams();
    },
    async mapping(slug = 'gpt-6-thinking', conversationId = id) {
      await this.respond(`/backend-api/conversation/${conversationId}`, {
        current_node: 'synthetic', default_model_slug: slug,
        mapping: {
          synthetic: { parent: null, message: {
            author: { role: 'assistant' },
            content: { parts: ['Synthetic mapping content, not a real conversation.'] },
            metadata: { model_slug: slug }
          } }
        }
      });
    }
  };
}

test('accepts only the exact Chat GPT-6 catalog reference with validated max_tokens', async () => {
  const h = catalogHarness();
  const resolve = h.window.__meterTestApi.resolveContextLimit;
  assert.equal(resolve('gpt-6-thinking').limit, null);
  await h.respond('/backend-api/models/?history_and_training_disabled=false', {
    models: [{ slug: 'gpt-6-thinking', max_tokens: 262144 }, { slug: 'gpt-5-6-thinking', max_tokens: 262144 }]
  });
  assert.equal(resolve('gpt-6-thinking').limit, 262144);
  assert.equal(resolve('gpt-6-thinking').source, 'ChatGPT model catalog · max_tokens');
  assert.equal(resolve('gpt-6-thinking').confidence, 'catalog-reference');
  assert.equal(resolve('gpt-5-6-thinking').limit, 272000);
  assert.equal(resolve('gpt-6-sol-wm').limit, null);
  assert.equal(resolve('gpt-6-instant').limit, null);
  assert.equal(resolve('gpt-6-thinking', { modelSlug: 'gpt-6-thinking', contextWindowTokens: 123456 }).limit, 123456);
  assert.equal(resolve('gpt-6-thinking', { modelSlug: 'other-model', contextWindowTokens: 1050000 }).limit, 262144);
  await h.respond('/backend-api/models', { models: [{ slug: 'gpt-6-sol-wm', max_tokens: 262144 }] });
  assert.equal(resolve('gpt-6-thinking').limit, 262144, 'Work catalogs cannot replace a Chat reference');
  for (const value of [null, 0, -1, 1.5, '262144', Number.MAX_SAFE_INTEGER + 1]) {
    await h.respond('/backend-api/models', { models: [{ slug: 'gpt-6-thinking', max_tokens: value, max_output_tokens: 128000 }] });
    assert.equal(resolve('gpt-6-thinking').limit, null);
  }
  for (const models of [
    [{ slug: 'gpt-6-thinking', max_output_tokens: 128000 }],
    [{ slug: 'gpt-6-sol', max_tokens: 1050000 }],
    [{ slug: 'gpt-6-thinking', max_tokens: 262144 }, { slug: 'gpt-6-thinking', max_tokens: 200000 }],
    []
  ]) {
    await h.respond('/backend-api/models', { models });
    assert.equal(resolve('gpt-6-thinking').limit, null);
  }
  assert.equal(h.updates.length, 0);
});

test('catalog interception is same-origin GET JSON only and makes no additional requests', async () => {
  const h = catalogHarness();
  const catalog = { models: [{ slug: 'gpt-6-thinking', max_tokens: 262144 }] };
  const json = { headers: { 'content-type': 'application/json' } };
  for (const [url, options, init] of [
    ['https://other.invalid/backend-api/models', json],
    ['/backend-api/models/not-a-catalog', json],
    ['/backend-api/models', json, { method: 'POST' }],
    ['/backend-api/models', { ...json, status: 403 }],
    ['/backend-api/models', { headers: { 'content-type': 'text/plain' } }]
  ]) {
    await h.respond(url, catalog, options, init);
    assert.equal(h.window.__meterTestApi.resolveContextLimit('gpt-6-thinking').limit, null);
  }
  await h.respond('/backend-api/models', { models: { slug: 'gpt-6-thinking', max_tokens: 262144 } }, json);
  assert.equal(h.window.__meterTestApi.resolveContextLimit('gpt-6-thinking').limit, null);
  await h.respond(new Request('https://chatgpt.com/backend-api/models?x=1'), catalog, json);
  assert.equal(h.window.__meterTestApi.resolveContextLimit('gpt-6-thinking').limit, 262144);
  assert.equal(h.requests.length, 7, 'exactly one original request per page fetch, no recursion or new requests');
});

test('both catalog/mapping response orders reuse counts and refresh immediately without another fetch', async () => {
  for (const catalogFirst of [true, false]) {
    const h = catalogHarness();
    const catalog = { models: [{ slug: 'gpt-6-thinking', max_tokens: 262144 }] };
    if (catalogFirst) await h.respond('/backend-api/models', catalog);
    await h.mapping();
    const before = h.updates.at(-1);
    if (!catalogFirst) {
      assert.equal(before.limit, null);
      assert.equal(before.percentage, null);
      await h.respond('/backend-api/models', catalog);
    }
    const after = h.updates.at(-1);
    assert.equal(after.modelSlug, 'gpt-6-thinking');
    assert.equal(after.limit, 262144);
    assert.equal(after.limitConfidence, 'catalog-reference');
    assert.ok(after.percentage > 0);
    assert.equal(after.totalTokens, before.totalTokens);
    assert.deepEqual(after.breakdown, before.breakdown);
    assert.equal(after.charCount, before.charCount);
    assert.equal(h.requests.length, 2);
    assert.equal(h.updates.length, catalogFirst ? 1 : 2);
    await h.respond('/backend-api/models', catalog);
    assert.equal(h.updates.length, catalogFirst ? 1 : 2, 'unchanged catalog does not duplicate updates');
  }
});

test('late catalogs do not replay stale routes or reuse a previous model reference', async () => {
  const h = catalogHarness();
  await h.mapping();
  h.window.location.pathname = '/c/22222222-2222-4222-8222-222222222222';
  await h.respond('/backend-api/models', { models: [{ slug: 'gpt-6-thinking', max_tokens: 262144 }] });
  assert.equal(h.updates.length, 1, 'old conversation is not republished on a new route');
  await h.mapping('gpt-6-luna-wm', '22222222-2222-4222-8222-222222222222');
  assert.equal(h.updates.at(-1).limit, null);
  await h.respond('/backend-api/models', { models: [{ slug: 'gpt-6-thinking', max_tokens: 200000 }] });
  assert.equal(h.updates.length, 2, 'catalog for another model does not overwrite current data');
  await h.mapping('gpt-5-6-thinking', '22222222-2222-4222-8222-222222222222');
  assert.equal(h.updates.at(-1).limit, 272000);
  // Even an old detail response completing after navigation is not replayed by a catalog.
  await h.mapping('gpt-6-thinking', h.id);
  const count = h.updates.length;
  await h.respond('/backend-api/models', { models: [{ slug: 'gpt-6-thinking', max_tokens: 262144 }] });
  assert.equal(h.updates.length, count);
});

test('catalog body parsing is non-blocking and malformed JSON remains unknown', async () => {
  let release;
  const body = new ReadableStream({ start(controller) { release = () => {
    controller.enqueue(new TextEncoder().encode('{malformed'));
    controller.close();
  }; } });
  const response = new Response(body, { headers: { 'content-type': 'application/json' } });
  const window = { location: { origin: 'https://chatgpt.com', pathname: '/' }, fetch: async () => response, postMessage() {} };
  runScript('page_script.js', { window, URL, console: { log() {}, error() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { resolveContextLimit };})();'));
  assert.equal(await window.fetch('/backend-api/models'), response, 'return before the body is available');
  release();
  assert.equal(await response.text(), '{malformed');
  await waitForStreams();
  assert.equal(window.__meterTestApi.resolveContextLimit('gpt-6-thinking').limit, null);
});

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
  assert.equal(usage.limit, 272000);
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

test('resolves override, trusted runtime, documented reference, and inferred context limits without API fallback', () => {
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
    limit: 272000, source: 'documented ChatGPT reference', confidence: 'documented'
  }));
  // The API's 1.05M capability window must never become the ChatGPT Web
  // reference: an outputTokens field (API-style) is ignored, and only a
  // matching runtime contextWindowTokens would ever be trusted.
  assert.equal(resolve('gpt-5-6-thinking', { modelSlug: 'gpt-5-6-thinking', outputTokens: 1050000 }), JSON.stringify({
    limit: 272000, source: 'documented ChatGPT reference', confidence: 'documented'
  }));
  // A matching trusted runtime context-window value still wins over the
  // documented reference (priority preserved); the API value is never used.
  assert.equal(resolve('gpt-5-6-thinking', { modelSlug: 'gpt-5-6-thinking', contextWindowTokens: 180000 }), JSON.stringify({
    limit: 180000, source: 'ChatGPT runtime', confidence: 'confirmed'
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
    referenceExceeded: true,
    percentage: null,
    leftPercent: null,
    remainingTokens: null
  }));
  assert.equal(JSON.stringify(window.__meterTestApi.contextMetrics(NaN, 0)), JSON.stringify({
    totalTokens: 0,
    limit: null,
    referenceExceeded: false,
    percentage: null,
    leftPercent: null,
    remainingTokens: null
  }));
});

test('computes reference ratios below the reference window and overflows at or above it', () => {
  const window = { fetch() {}, postMessage() {} };
  window.window = window;
  runScript('page_script.js', { window, console: { log() {}, error() {} } }, source =>
    source.replace('})();', ';window.__meterTestApi = { contextMetrics };})();')
  );

  const m = (...args) => JSON.stringify(window.__meterTestApi.contextMetrics(...args));

  // Normal below-reference case: 136000 / 272000 -> 50% of reference, 50% ref. left.
  assert.equal(m(136000, 272000), JSON.stringify({
    totalTokens: 136000,
    limit: 272000,
    referenceExceeded: false,
    percentage: 50,
    leftPercent: 50,
    remainingTokens: 136000
  }));

  // Boundary just below the reference window remains a normal ratio.
  // (99.9996% rounds to 100 at two decimals, but the state is still
  // reference — not overflow — and a positive remainder exists.)
  assert.equal(JSON.parse(m(271999, 272000)).referenceExceeded, false);
  assert.equal(JSON.parse(m(271999, 272000)).percentage, 100);
  assert.equal(JSON.parse(m(271999, 272000)).remainingTokens, 1);

  // Exactly at the reference window -> overflow, no fake 0% left.
  assert.equal(JSON.parse(m(272000, 272000)).referenceExceeded, true);
  assert.equal(JSON.parse(m(272000, 272000)).percentage, null);
  assert.equal(JSON.parse(m(272000, 272000)).leftPercent, null);
  assert.equal(JSON.parse(m(272000, 272000)).remainingTokens, null);

  // Slightly above the reference window -> overflow.
  assert.equal(JSON.parse(m(272001, 272000)).referenceExceeded, true);
  assert.equal(JSON.parse(m(272001, 272000)).percentage, null);
  assert.equal(JSON.parse(m(272001, 272000)).leftPercent, null);
  assert.equal(JSON.parse(m(272001, 272000)).remainingTokens, null);

  // Real-world observed mapping sizes (synthetic numbers only).
  assert.equal(JSON.parse(m(289254, 272000)).referenceExceeded, true);
  assert.equal(JSON.parse(m(289254, 272000)).percentage, null);
  assert.equal(JSON.parse(m(289254, 272000)).leftPercent, null);
  assert.equal(JSON.parse(m(505729, 272000)).referenceExceeded, true);
  assert.equal(JSON.parse(m(505729, 272000)).percentage, null);
  assert.equal(JSON.parse(m(505729, 272000)).leftPercent, null);
  assert.equal(JSON.parse(m(505729, 272000)).remainingTokens, null);
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
  }, source => source.replace('})();', ';window.__meterTestApi = { guardMessage, getStateColor, contextState, contextWarning };})();'));

  const { guardMessage, contextState, contextWarning } = window.__meterTestApi;

  // Below-reference boundaries keep the 35/25/15 thresholds with reference wording.
  assert.equal(guardMessage(36), '');
  assert.equal(guardMessage(35), 'Mapping nearing reference window');
  assert.equal(guardMessage(26), 'Mapping nearing reference window');
  assert.equal(guardMessage(25), 'Consider starting a new chat');
  assert.equal(guardMessage(16), 'Consider starting a new chat');
  assert.equal(guardMessage(15), 'Mapping very near reference window');

  // Mapping at/above the reference window must never produce the old
  // "High context pressure" or a fake 0%-left pressure state.
  for (const mapping of [272000, 289254, 505729]) {
    const overflowData = {
      totalTokens: mapping,
      limit: 272000,
      referenceExceeded: true,
      percentage: null,
      leftPercent: null,
      remainingTokens: null
    };
    assert.equal(contextState(overflowData), 'overflow');
    assert.equal(contextWarning(overflowData), 'Mapping at/above reference');
    assert.doesNotMatch(contextWarning(overflowData), /exceeds/);
    assert.doesNotMatch(contextWarning(overflowData), /High context pressure/);
  }

  const belowData = {
    totalTokens: 136000,
    limit: 272000,
    referenceExceeded: false,
    percentage: 50,
    leftPercent: 50,
    remainingTokens: 136000
  };
  assert.equal(contextState(belowData), 'reference');
  assert.equal(contextWarning(belowData), '');
});

test('badge shows reference and overflow states without fake remaining percentages', () => {
  const elements = {};
  const makeStub = id => ({ id, innerText: '', setAttribute() {}, classList: { add() {}, remove() {} } });
  const document = {
    body: new FakeElement('body'),
    readyState: 'complete',
    createElement: tagName => new FakeElement(tagName),
    getElementById: id => elements[id] || (elements[id] = makeStub(id)),
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const window = { addEventListener() {} };
  window.window = window;
  runScript('content.js', {
    window,
    document,
    MutationObserver: class { observe() {} },
    Intl,
    console: { log() {} }
  }, source => source.replace('})();', ';window.__meterTestApi = { updateWidgetUI };})();'));

  // Below-reference state: the badge shows a reference percentage, not "used".
  window.__meterTestApi.updateWidgetUI({
    totalTokens: 136000,
    limit: 272000,
    referenceExceeded: false,
    percentage: 50,
    leftPercent: 50,
    remainingTokens: 136000,
    modelSlug: 'gpt-5-6-thinking',
    modelSource: 'backend',
    limitSource: 'documented ChatGPT reference',
    limitConfidence: 'documented',
    dataSource: 'backend',
    breakdown: { user: 10000, assistant: 10000, tool: 10000, thought: 10000, system: 10000 }
  });
  assert.equal(elements['gpt-token-count-text'].innerText, 'Ref. 50% left');
  assert.doesNotMatch(elements['gpt-token-count-text'].innerText, /used/);

  // At and above the reference: no fake 0% left, no fake 100% used, and no
  // mathematically incorrect "exceeds" wording at exact equality.
  for (const totalTokens of [272000, 505729]) {
    window.__meterTestApi.updateWidgetUI({
      totalTokens,
      limit: 272000,
      referenceExceeded: true,
      percentage: null,
      leftPercent: null,
      remainingTokens: null,
      modelSlug: 'gpt-5-6-thinking',
      modelSource: 'backend',
      limitSource: 'documented ChatGPT reference',
      limitConfidence: 'documented',
      dataSource: 'backend',
      breakdown: { user: 10000, assistant: 10000, tool: 10000, thought: 10000, system: 10000 }
    });
    assert.equal(elements['gpt-token-count-text'].innerText, 'Mapping ≥ ref');
    assert.doesNotMatch(elements['gpt-token-count-text'].innerText, /exceeds|> ref/);
    assert.notEqual(elements['gpt-token-count-text'].innerText, '0% left');
    assert.notEqual(elements['gpt-token-pct-text'].innerText, '0%');
  }
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

test('catalog panel labels reference semantics and retains overflow and Unknown safeguards', () => {
  const elements = {};
  const document = {
    body: new FakeElement('body'), readyState: 'complete',
    createElement: tag => new FakeElement(tag),
    getElementById: id => elements[id] || (elements[id] = {
      innerText: '', setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }
    }),
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
  };
  const window = { addEventListener() {} };
  runScript('content.js', {
    window, document, MutationObserver: class { observe() {} }, Intl, console: { log() {} }
  }, source => source.replace('})();', `;window.__meterTestApi = {
    updateWidgetUI,
    openDetails() { isCardOpen = true; renderDetailsCard(); },
    contextWarning
  };})();`));
  const api = window.__meterTestApi;
  const base = {
    totalTokens: 4876, limit: 262144, referenceExceeded: false,
    percentage: 1.86, leftPercent: 98.14, remainingTokens: 257268,
    modelSlug: 'gpt-6-thinking', modelSource: 'backend', dataSource: 'backend',
    limitSource: 'ChatGPT model catalog · max_tokens', limitConfidence: 'catalog-reference',
    breakdown: { user: 4876 }
  };
  api.updateWidgetUI(base);
  api.openDetails();
  const panel = document.body.children.find(element => element.id === 'chatgpt-token-usage-details');
  assert.match(panel.innerHTML, /~1\.9%/);
  assert.match(panel.innerHTML, /of catalog reference/);
  assert.match(panel.innerHTML, /Catalog reference: 262,144/);
  assert.match(panel.innerHTML, /ChatGPT model catalog · max_tokens/);
  assert.match(panel.innerHTML, /Runtime context unavailable/);
  assert.match(panel.innerHTML, /not verified per-session runtime context telemetry/);
  assert.doesNotMatch(panel.innerHTML, /confirmed-runtime|exact-context-window|official-plus-limit/);
  for (const totalTokens of [262144, 262145]) {
    api.updateWidgetUI({ ...base, totalTokens, referenceExceeded: true, percentage: null, leftPercent: null, remainingTokens: null });
    assert.equal(elements['gpt-token-count-text'].innerText, 'Mapping ≥ ref');
    assert.equal(elements['gpt-token-pct-text'].innerText, '—');
    assert.match(panel.innerHTML, /Catalog reference: 262,144/);
    assert.match(panel.innerHTML, /Runtime context unavailable/);
    assert.doesNotMatch(panel.innerHTML, /100% used|0% left|High context pressure/);
  }
  const unknown = { ...base, limit: null, referenceExceeded: false, percentage: null, leftPercent: null, remainingTokens: null, limitSource: 'unknown', limitConfidence: 'unknown' };
  api.updateWidgetUI(unknown);
  assert.match(panel.innerHTML, /Context limit unknown · percentage unavailable/);
  assert.doesNotMatch(panel.innerHTML, /Catalog reference|gpt-token-guard/);
  assert.equal(api.contextWarning(unknown), '');
});

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
