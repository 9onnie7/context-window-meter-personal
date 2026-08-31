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

test('resolves overrides before mappings and clamps context math', () => {
  const window = { fetch() {}, postMessage() {} };
  window.window = window;
  runScript('page_script.js', { window, console: { log() {}, error() {} } }, source => source
    .replace("const PERSONAL_CONTEXT_LIMIT_OVERRIDES = {};", "const PERSONAL_CONTEXT_LIMIT_OVERRIDES = { 'gpt-5': 12345 };")
    .replace('})();', ';window.__meterTestApi = { resolveContextLimit, contextMetrics };})();')
  );

  assert.equal(JSON.stringify(window.__meterTestApi.resolveContextLimit('gpt-5')), JSON.stringify({ limit: 12345, source: 'override' }));
  assert.equal(JSON.stringify(window.__meterTestApi.resolveContextLimit('gpt-4o')), JSON.stringify({ limit: 128000, source: 'exact mapping' }));
  assert.equal(JSON.stringify(window.__meterTestApi.resolveContextLimit('unknown-model')), JSON.stringify({ limit: 128000, source: 'default fallback' }));
  assert.equal(JSON.stringify(window.__meterTestApi.contextMetrics(250, 100)), JSON.stringify({
    totalTokens: 250,
    limit: 100,
    percentage: 100,
    leftPercent: 0,
    remainingTokens: 0
  }));
  assert.equal(JSON.stringify(window.__meterTestApi.contextMetrics(NaN, 0)), JSON.stringify({
    totalTokens: 0,
    limit: 0,
    percentage: 0,
    leftPercent: 0,
    remainingTokens: 0
  }));
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
    location: { pathname: '/c/conversation-id' },
    fetch: async url => {
      requestedUrls.push(url);
      return new Response(url === '/backend-api/f/conversation' ? 'data: [DONE]\n\n' : detail);
    },
    postMessage(message) {
      if (message.type === 'CHATGPT_TOKEN_USAGE_UPDATE') updates.push(message.data);
    }
  };
  window.window = window;
  runScript('page_script.js', { window, Response, setTimeout, clearTimeout, console: { log() {}, error() {} } });

  await window.fetch('/backend-api/f/conversation');
  await new Promise(resolve => setTimeout(resolve, 600));

  assert.ok(requestedUrls.includes('/backend-api/conversation/conversation-id'));
  assert.ok(updates.at(-1), 'the refreshed detail should produce a usage update');
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
        if (message.includes('DOM Scan Fallback')) fallbackLogs++;
      }
    }
  });

  assert.equal(fallbackLogs, 1);
  const widget = elements.get('chatgpt-token-usage-badge');
  observer.callback([{ type: 'childList', target: widget }]);
  assert.equal(fallbackLogs, 1);
});
