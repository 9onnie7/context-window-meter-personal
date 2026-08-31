(function () {
  let widgetContainer = null;
  let detailsCard = null;
  let isCardOpen = false;
  let currentData = null;
  // 'loading' until the conversation has actually been measured, so the badge
  // never shows a 0% that looks like a real reading.
  let status = 'loading';
  let emptyStateTimer = null;

  const EMPTY_STATE_DELAY_MS = 7000;

  const CATEGORIES = [
    { key: 'user', label: 'Your messages', color: 'var(--gtu-cat-user)' },
    { key: 'assistant', label: 'ChatGPT replies', color: 'var(--gtu-cat-assistant)' },
    { key: 'tool', label: 'Tool and search results', color: 'var(--gtu-cat-tool)' },
    { key: 'thought', label: 'Reasoning', color: 'var(--gtu-cat-thought)' },
    { key: 'system', label: 'System instructions', color: 'var(--gtu-cat-system)' }
  ];

  function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const words = text.match(/\w+/g) || [];
    const nonWords = text.match(/[^\w\s]+/g) || [];
    const estimated = Math.ceil(words.length * 1.3 + nonWords.length * 1.1 + (text.length * 0.05));
    return Math.max(0, Math.round(estimated));
  }

  function getStateColor(leftPercent) {
    if (leftPercent > 35) return 'var(--gtu-ok)';
    if (leftPercent > 25) return 'var(--gtu-warn)';
    if (leftPercent > 15) return 'var(--gtu-pressure)';
    return 'var(--gtu-crit)';
  }

  function guardMessage(leftPercent) {
    if (leftPercent <= 15) return 'High context pressure';
    if (leftPercent <= 25) return 'New chat recommended';
    if (leftPercent <= 35) return 'Consider wrapping up this phase';
    return '';
  }

  function formatNumber(num) {
    return new Intl.NumberFormat().format(num || 0);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createWidget() {
    if (widgetContainer) return;

    widgetContainer = document.createElement('div');
    widgetContainer.id = 'chatgpt-token-usage-badge';
    widgetContainer.className = 'gpt-token-badge is-loading';
    widgetContainer.setAttribute('role', 'button');
    widgetContainer.setAttribute('tabindex', '0');
    widgetContainer.setAttribute('aria-label', 'Context window usage. Reading conversation.');
    widgetContainer.setAttribute('title', 'Context window usage');

    widgetContainer.innerHTML = `
      <div class="gpt-token-ring-container">
        <svg class="gpt-token-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="gpt-token-ring-track" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.5" />
          <circle id="gpt-token-ring-path" class="gpt-token-ring-value" cx="18" cy="18" r="15.9155"
            fill="none" stroke-width="3.5" stroke-linecap="round"
            stroke-dasharray="25, 100" pathLength="100" />
        </svg>
        <span id="gpt-token-pct-text" class="gpt-token-ring-pct">0%</span>
      </div>
      <div class="gpt-token-badge-labels">
        <span class="gpt-token-badge-title">Context</span>
        <span id="gpt-token-count-text" class="gpt-token-badge-value">
          <span class="gpt-token-skeleton" style="width: 4.5rem;"></span>
        </span>
      </div>
    `;

    detailsCard = document.createElement('div');
    detailsCard.id = 'chatgpt-token-usage-details';
    detailsCard.className = 'gpt-token-details-card hidden';
    detailsCard.setAttribute('role', 'dialog');
    detailsCard.setAttribute('aria-label', 'Context window breakdown');

    document.body.appendChild(widgetContainer);
    document.body.appendChild(detailsCard);

    widgetContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      isCardOpen = !isCardOpen;
      renderDetailsCard();
    });

    widgetContainer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      isCardOpen = !isCardOpen;
      renderDetailsCard();
    });

    document.addEventListener('click', (e) => {
      if (isCardOpen && !detailsCard.contains(e.target) && !widgetContainer.contains(e.target)) {
        isCardOpen = false;
        detailsCard.classList.add('hidden');
      }
    });

    // A brand new chat has nothing to measure. Stop spinning and say so rather
    // than loading forever.
    if (typeof setTimeout === 'function') {
      emptyStateTimer = setTimeout(() => {
        if (status === 'loading') setStatus('empty');
      }, EMPTY_STATE_DELAY_MS);
    }
  }

  function setStatus(next) {
    status = next;
    if (!widgetContainer) return;

    if (next === 'loading') {
      widgetContainer.classList.add('is-loading');
      widgetContainer.setAttribute('aria-label', 'Context window usage. Reading conversation.');
      return;
    }

    widgetContainer.classList.remove('is-loading');

    if (next === 'empty') {
      const countText = document.getElementById('gpt-token-count-text');
      const pctText = document.getElementById('gpt-token-pct-text');
      const ringPath = document.getElementById('gpt-token-ring-path');
      if (ringPath) ringPath.setAttribute('stroke-dasharray', '0, 100');
      if (pctText) pctText.innerText = '0%';
      if (countText) countText.innerText = 'Empty';
      widgetContainer.setAttribute('aria-label', 'Context window usage. No messages yet.');
      if (isCardOpen) renderDetailsCard();
    }
  }

  function updateWidgetUI(data) {
    createWidget();
    currentData = data;

    if (emptyStateTimer && typeof clearTimeout === 'function') {
      clearTimeout(emptyStateTimer);
      emptyStateTimer = null;
    }
    setStatus('ready');

    const ringPath = document.getElementById('gpt-token-ring-path');
    const pctText = document.getElementById('gpt-token-pct-text');
    const countText = document.getElementById('gpt-token-count-text');
    const leftPercent = Number.isFinite(data.leftPercent) ? Math.max(0, Math.min(100, data.leftPercent)) : Math.max(0, 100 - data.percentage);
    const color = getStateColor(leftPercent);

    if (ringPath) {
      ringPath.setAttribute('stroke-dasharray', `${leftPercent}, 100`);
      ringPath.setAttribute('stroke', color);
    }

    if (pctText) {
      pctText.innerText = `${Math.round(leftPercent)}%`;
    }

    if (countText) {
      countText.innerText = `${Math.round(leftPercent)}% left`;
    }

    widgetContainer.setAttribute(
      'aria-label',
      `Estimated context: ${Math.round(leftPercent)} percent left, ${Math.round(data.percentage)} percent used.`
    );

    if (isCardOpen) {
      renderDetailsCard();
    }
  }

  function renderSegments(breakdown, limit) {
    return CATEGORIES.map(category => {
      const tokens = breakdown[category.key] || 0;
      if (tokens <= 0) return '';
      const width = Math.min(100, (tokens / limit) * 100);
      return `<div class="gpt-token-bar-segment" style="width: ${width}%; background-color: ${category.color};" title="${escapeHtml(category.label)}"></div>`;
    }).join('');
  }

  function renderLegend(breakdown, totalTokens) {
    return CATEGORIES.map(category => {
      const tokens = breakdown[category.key] || 0;
      const share = totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
      return `
        <div class="gpt-token-row${tokens === 0 ? ' is-empty' : ''}">
          <span class="gpt-token-swatch" style="background-color: ${category.color};"></span>
          <span class="gpt-token-row-name">${escapeHtml(category.label)}</span>
          <span class="gpt-token-row-value">${formatNumber(tokens)}</span>
          <span class="gpt-token-row-share">${share}%</span>
        </div>
      `;
    }).join('');
  }

  function renderDetailsCard() {
    if (!detailsCard) return;

    if (!isCardOpen) {
      detailsCard.classList.add('hidden');
      return;
    }

    detailsCard.classList.remove('hidden');

    if (!currentData) {
      detailsCard.innerHTML = `
        <div class="gpt-token-card-head">
          <span class="gpt-token-card-title">Context window</span>
        </div>
        ${status === 'loading' ? `
          <div class="gpt-token-headline-sub">Reading this conversation…</div>
          <span class="gpt-token-skeleton" style="width: 100%; height: 0.5rem; margin-top: 0.75rem;"></span>
          <div class="gpt-token-legend">
            <span class="gpt-token-skeleton" style="width: 70%; margin-bottom: 0.75rem;"></span>
            <span class="gpt-token-skeleton" style="width: 85%; margin-bottom: 0.75rem;"></span>
            <span class="gpt-token-skeleton" style="width: 55%;"></span>
          </div>
        ` : `
          <p class="gpt-token-empty">No messages yet. Send one and the breakdown appears here.</p>
        `}
      `;
      return;
    }

    const leftPercent = Number.isFinite(currentData.leftPercent) ? Math.max(0, Math.min(100, currentData.leftPercent)) : Math.max(0, 100 - currentData.percentage);
    const color = getStateColor(leftPercent);
    const breakdown = currentData.breakdown || {};
    const remainingTokens = Number.isFinite(currentData.remainingTokens) ? Math.max(0, currentData.remainingTokens) : Math.max(0, currentData.limit - currentData.totalTokens);
    const warning = guardMessage(leftPercent);

    detailsCard.innerHTML = `
      <div class="gpt-token-card-head">
        <span class="gpt-token-card-title">Estimated context</span>
        <span class="gpt-token-model">${escapeHtml(currentData.modelSlug || 'gpt-4o')}</span>
      </div>

      <div class="gpt-token-headline">
        <span class="gpt-token-headline-pct" style="color: ${color};">${Math.round(currentData.percentage)}%</span>
        <span class="gpt-token-headline-note">used</span>
      </div>
      <div class="gpt-token-headline-sub">
        ${formatNumber(currentData.totalTokens)} / ${formatNumber(currentData.limit)} estimated tokens<br>
        ${formatNumber(remainingTokens)} estimated tokens left · ${Math.round(leftPercent)}% left
      </div>

      ${warning ? `<div class="gpt-token-guard" style="color: ${color};">${warning}</div>` : ''}

      <div class="gpt-token-bar">
        ${renderSegments(breakdown, currentData.limit)}
      </div>

      <div class="gpt-token-legend">
        <div class="gpt-token-legend-title">What is filling it</div>
        ${renderLegend(breakdown, currentData.totalTokens)}
      </div>

      <div class="gpt-token-foot">
        <span title="Token usage is estimated from visible conversation data and inferred model limits.">Estimated · ${escapeHtml(currentData.limitSource || 'default fallback')}</span>
        <button id="gpt-token-close-btn" type="button">Close</button>
      </div>
    `;

    document.getElementById('gpt-token-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      isCardOpen = false;
      detailsCard.classList.add('hidden');
    });
  }

  // Enhanced DOM Fallback Scanner
  function scanDOMFallback() {
    if (currentData && currentData.limitSource !== 'DOM fallback' && currentData.totalTokens > 0) return;

    const articles = document.querySelectorAll('article');
    let userText = '';
    let assistantText = '';

    if (articles.length > 0) {
      articles.forEach(article => {
        const isUser = article.querySelector('[data-message-author-role="user"]') || article.getAttribute('data-message-author-role') === 'user' || article.innerText.includes('You said:');
        if (isUser) {
          userText += article.innerText + '\n';
        } else {
          assistantText += article.innerText + '\n';
        }
      });
    } else {
      const userEls = document.querySelectorAll('[data-message-author-role="user"], .user-message');
      const assistantEls = document.querySelectorAll('[data-message-author-role="assistant"], .markdown');
      userEls.forEach(el => userText += el.innerText + '\n');
      assistantEls.forEach(el => assistantText += el.innerText + '\n');
    }

    const userTokens = estimateTokens(userText);
    const assistantTokens = estimateTokens(assistantText);
    const totalTokens = userTokens + assistantTokens;

    if (totalTokens > 0) {
      const limit = 128000;
      const percentage = Math.min(100, (totalTokens / limit) * 100);

      console.log(`[ChatGPT Token Tracker] DOM Scan Fallback: ${totalTokens} tokens (${percentage.toFixed(1)}%) from ${articles.length} articles`);

      updateWidgetUI({
        totalTokens,
        limit,
        percentage: parseFloat(percentage.toFixed(2)),
        leftPercent: parseFloat((100 - percentage).toFixed(2)),
        remainingTokens: Math.max(0, limit - totalTokens),
        modelSlug: 'gpt-4o',
        breakdown: {
          user: userTokens,
          assistant: assistantTokens,
          tool: 0,
          thought: 0,
          system: 0
        },
        limitSource: 'DOM fallback',
        updatedAt: new Date().toISOString()
      });
    }
  }

  // Listen for real-time SSE network messages
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'CHATGPT_TOKEN_USAGE_UPDATE') {
      const data = event.data.data;
      updateWidgetUI(data);
    }
  });

  function init() {
    createWidget();
    scanDOMFallback();

    let fallbackTimer = null;
    const observer = new MutationObserver(mutations => {
      const onlyTrackerMutations = mutations.length > 0 && mutations.every(mutation =>
        widgetContainer?.contains(mutation.target) || detailsCard?.contains(mutation.target)
      );
      if (onlyTrackerMutations) return;

      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(scanDOMFallback, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
