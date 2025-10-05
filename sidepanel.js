/**
 * TypeRight Side Panel Script
 * Handles UI for displaying grammar suggestions
 */

const state = {
    port: null,
    suggestions: [],
    currentSuggestion: null,
    currentTabId: null,
    tabListenersRegistered: false,
};

function initialize() {
    console.log('TypeRight Side Panel: Initialized');
    connectToBackground();
    addStyles();
    renderSuggestions(state.suggestions);
}

function connectToBackground() {
    try {
        const port = chrome.runtime.connect({ name: 'sidepanel' });
        state.port = port;

        port.onMessage.addListener(handlePortMessage);

        port.onDisconnect.addListener(() => {
            console.warn('TypeRight Side Panel: Port disconnected, retrying...');
            state.port = null;
            setTimeout(connectToBackground, 1000);
        });

        syncActiveTab(true);

        if (!state.tabListenersRegistered) {
            chrome.tabs.onActivated.addListener(handleTabActivated);
            chrome.tabs.onUpdated.addListener(handleTabUpdated);
            state.tabListenersRegistered = true;
        }
    } catch (error) {
        console.error('TypeRight Side Panel: Failed to connect to background:', error);
    }
}

function handlePortMessage(message) {
    if (!message || !message.action) {
        return;
    }

    switch (message.action) {
        case 'displaySuggestion':
            if (message.data) {
                state.currentTabId = message.data.tabId ?? state.currentTabId;
                upsertSuggestion(message.data);
            }
            break;

        case 'displayError':
            displayError(message.error || 'Unknown error occurred');
            break;

        case 'historyUpdate':
            if (Array.isArray(message.history) && message.history.length > 0) {
                renderSuggestions(message.history);
            } else if (state.suggestions.length === 0) {
                renderSuggestions([]);
            } else {
                console.log('TypeRight Side Panel: Ignoring empty history update to preserve existing suggestions');
            }
            break;

        case 'removeSuggestion':
            removeSuggestion(message.data);
            break;

        case 'statusUpdate':
            {
                const data = message.data || {};
                const statusMessage = data.message || 'Working…';
                const statusType = data.type || 'ready';
                updateStatus(statusMessage, statusType);
            }
            break;
    }
}

function handleTabActivated(activeInfo) {
    if (!activeInfo || typeof activeInfo.tabId !== 'number') {
        return;
    }
    state.currentTabId = activeInfo.tabId;
    syncActiveTab();
}

function handleTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete' && tab.active) {
        state.currentTabId = tabId;
        syncActiveTab();
    }
}

function syncActiveTab(requestHistory = false) {
    try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                console.warn('TypeRight Side Panel: Failed to query tabs:', chrome.runtime.lastError.message);
                return;
            }

            const activeTab = tabs && tabs[0];
            if (!activeTab) {
                return;
            }

            state.currentTabId = activeTab.id;

            if (state.port) {
                state.port.postMessage({
                    action: 'registerTab',
                    tabId: state.currentTabId,
                });

                if (requestHistory || state.suggestions.length === 0) {
                    state.port.postMessage({
                        action: 'requestHistory',
                        tabId: state.currentTabId,
                    });
                }
            }
        });
    } catch (error) {
        console.error('TypeRight Side Panel: Failed to sync active tab:', error);
    }
}

function upsertSuggestion(suggestion) {
    if (!suggestion) {
        return;
    }

    const existingIndex = state.suggestions.findIndex(
        (entry) => entry.timestamp === suggestion.timestamp && entry.elementId === suggestion.elementId
    );

    const updatedSuggestions = [suggestion, ...state.suggestions];

    if (existingIndex >= 0) {
        updatedSuggestions.splice(existingIndex + 1, 1);
    }

    renderSuggestions(updatedSuggestions);
}

function renderSuggestions(suggestions) {
    const container = document.getElementById('suggestions');
    if (!container) {
        return;
    }

    if (!Array.isArray(suggestions)) {
        suggestions = [];
    }

    state.suggestions = suggestions.slice(0, 10);

    container.innerHTML = '';

    if (state.suggestions.length === 0) {
        container.appendChild(createEmptyState());
        state.currentSuggestion = null;
        updateStatus('Ready to check your writing', 'ready');
        return;
    }

    let latestEntry = null;

    state.suggestions.forEach((entry, index) => {
        const card = createSuggestionCard(entry);
        container.appendChild(card);

        if (index === 0) {
            state.currentSuggestion = entry;
            state.currentTabId = entry.tabId ?? state.currentTabId;
            latestEntry = entry;
        }
    });

    if (latestEntry?.noIssues || latestEntry?.hasIssues === false) {
        updateStatus('No issues found', 'ready');
    } else {
        updateStatus('Suggestion found!', 'ready');
    }
}

function createSuggestionCard(data) {
    const {
        originalText,
        correctedText,
        alternative,
        summary,
        suggestion,
    } = data;

    const isNoIssues = Boolean(data.noIssues || data.hasIssues === false);
    const displayOriginal = originalText ?? '';
    const displayRevisedRaw = correctedText ?? '';
    const showRevisedSection = !isNoIssues && displayRevisedRaw.trim().length > 0;
    const displayRevised = showRevisedSection ? displayRevisedRaw : '';

    const card = document.createElement('div');
    card.className = 'suggestion-card';
    if (typeof data.timestamp === 'number') {
        card.dataset.timestamp = String(data.timestamp);
    }
    if (data.elementId) {
        card.dataset.elementId = data.elementId;
    }

    if (isNoIssues) {
        card.classList.add('no-issues-card');
    }

    const timeString = new Date(data.timestamp || Date.now()).toLocaleTimeString();

    let alternativeHTML = '';
    if (alternative) {
        alternativeHTML = `
            <div class="text-section">
                <div class="text-label" style="color: #0056b3; display: flex; justify-content: space-between; align-items: center;">
                    <span>Alternative Suggestion</span>
                    <a href="#" class="copy-link" data-text="${escapeHtml(alternative)}" style="font-size: 13px; color: #5a6268; text-decoration: none;">Copy</a>
                </div>
                <div class="text-content" style="border-left-color: #0056b3;">${escapeHtml(alternative)}</div>
            </div>
        `;
    }

    let summaryHTML = '';
    if (summary) {
        summaryHTML = `
            <div class="explanation">
                <strong>Summary:</strong> ${escapeHtml(summary)}
            </div>
        `;
    }

    const titleText = isNoIssues ? 'No issues found' : 'Grammar Suggestion';
    const originalLabel = 'Original Text';
    const bannerHTML = isNoIssues
        ? `<div class="no-issues-banner" style="background: #e6f4ea; color: #0b6b2f; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-weight: 600;">
                        ${escapeHtml(suggestion || 'Your text looks good! No grammar issues found.')}
                    </div>`
        : '';

    let revisedSection = '';
    if (showRevisedSection) {
        revisedSection = `
        <div class="text-section">
            <div class="text-label label-corrected" style="display: flex; justify-content: space-between; align-items: center;">
                <span>Revised</span>
                <a href="#" class="copy-link" data-text="${escapeHtml(displayRevised)}" style="font-size: 13px; color: #5a6268; text-decoration: none;">Copy</a>
            </div>
            <div class="text-content text-corrected">${escapeHtml(displayRevised)}</div>
        </div>
        `;
    }

    card.innerHTML = `
        <div class="suggestion-header">
            <span class="suggestion-title">${titleText}</span>
            <span class="suggestion-time">${timeString}</span>
        </div>
        ${bannerHTML}
        <div class="text-section">
            <div class="text-label label-original">
                ${originalLabel}
            </div>
            <div class="text-content text-original">${escapeHtml(displayOriginal)}</div>
        </div>
        ${revisedSection}
        ${alternativeHTML}
    
        ${summaryHTML}
    
        <div class="actions">
            <button class="btn-dismiss">Dismiss</button>
        </div>
    `;

    const dismissBtn = card.querySelector('.btn-dismiss');
    const copyLinks = card.querySelectorAll('.copy-link');

    copyLinks.forEach(copyLink => {
        copyLink.addEventListener('click', (e) => {
            e.preventDefault();
            const textToCopy = copyLink.getAttribute('data-text');
            copyToClipboard(textToCopy);
            const originalLabel = copyLink.textContent;
            const originalColor = copyLink.style.color;
            copyLink.textContent = 'Copied';
            copyLink.style.color = '#28a745';
            setTimeout(() => {
                copyLink.textContent = originalLabel;
                copyLink.style.color = originalColor;
            }, 1500);
        });
    });

    dismissBtn.addEventListener('click', () => {
        if (state.port) {
            try {
                state.port.postMessage({
                    action: 'dismissEntry',
                    timestamp: data.timestamp,
                    elementId: data.elementId,
                });
            } catch (error) {
                console.error('TypeRight Side Panel: Failed to notify background about dismissal:', error);
            }
        }

        card.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            card.remove();

            state.suggestions = state.suggestions.filter((entry) => {
                const sameTimestamp = entry.timestamp === data.timestamp;
                const sameElement = entry.elementId === data.elementId;
                return !(sameTimestamp && sameElement);
            });

            const container = document.getElementById('suggestions');
            if (container && container.children.length === 0) {
                state.currentSuggestion = null;
                state.currentTabId = null;
                container.appendChild(createEmptyState());
                updateStatus('Ready to check your writing', 'ready');
            }
        }, 300);
    });

    return card;
}

function displayError(errorMessage) {
    updateStatus('Error occurred', 'error');

    const container = document.getElementById('suggestions');
    if (!container) {
        return;
    }

    const errorCard = document.createElement('div');
    errorCard.className = 'error-card';
    errorCard.innerHTML = `
    <div class="error-title">⚠️ Error</div>
    <p>${escapeHtml(errorMessage)}</p>
    <p style="margin-top: 8px; font-size: 13px;">
      Make sure Ollama is running: <code>ollama serve</code>
    </p>
  `;

    container.insertBefore(errorCard, container.firstChild);

    setTimeout(() => {
        errorCard.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => errorCard.remove(), 300);
    }, 10000);
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        console.log('TypeRight: Text copied to clipboard');
    }).catch(err => {
        console.error('TypeRight: Failed to copy text:', err);
    });
}

function clearSuggestions() {
    renderSuggestions([]);
}

function updateStatus(message, type = 'ready') {
    const statusEl = document.getElementById('status');
    if (!statusEl) {
        return;
    }

    statusEl.innerHTML = `
    <span class="status-indicator status-${type}"></span>
    ${message}
  `;
}

function createEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
    <div class="empty-state-icon">📝</div>
    <p class="empty-state-text">No suggestions yet</p>
    <p class="empty-state-hint">Start typing in any text field, and TypeRight will check your grammar automatically!</p>
  `;
    return div;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

function addStyles() {
    if (document.getElementById('typeright-sidepanel-extra-styles')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'typeright-sidepanel-extra-styles';
    style.textContent = `
  @keyframes slideOut {
    from {
      opacity: 1;
      transform: translateX(0);
    }
    to {
      opacity: 0;
      transform: translateX(100%);
    }
  }
`;
    document.head.appendChild(style);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}

function removeSuggestion(identifier = {}) {
    if (!identifier || identifier.timestamp == null) {
        return;
    }

    const { timestamp, elementId = null } = identifier;

    const filtered = state.suggestions.filter((entry) => {
        const sameTimestamp = entry.timestamp === timestamp;
        const sameElement = elementId ? entry.elementId === elementId : true;
        return !(sameTimestamp && sameElement);
    });

    renderSuggestions(filtered);
}