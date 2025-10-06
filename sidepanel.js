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
    availableModels: [],
    selectedModel: null,
    modelsLoading: false,
};

let modelSelectEl = null;
let refreshModelsButton = null;
let modelStatusEl = null;

const MODEL_STATUS_MESSAGES = {
    loading: 'Loading models…',
    refreshing: 'Refreshing model list…',
    switching: (model) => `Switching to ${model}…`,
    success: (model) => `Using model: ${model}`,
    empty: 'No models detected. Use "ollama pull <model>" then click Refresh.',
};

function initialize() {
    console.log('TypeRight Side Panel: Initialized');
    connectToBackground();
    addStyles();
    setupModelControls();
    renderSuggestions(state.suggestions);
}

function connectToBackground() {
    try {
        const port = chrome.runtime.connect({ name: 'sidepanel' });
        state.port = port;

        if (modelSelectEl) {
            requestModelList({ forceRefresh: false });
        }

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

        case 'modelList':
            handleModelListResponse(message);
            break;

        case 'modelSelected':
            handleModelSelected(message.model);
            break;

        case 'modelSelectionError':
            handleModelSelectionError(message.error);
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

function setupModelControls() {
    modelSelectEl = document.getElementById('model-select');
    refreshModelsButton = document.getElementById('refresh-models');
    modelStatusEl = document.getElementById('model-status');

    if (!modelSelectEl || !refreshModelsButton || !modelStatusEl) {
        console.warn('TypeRight Side Panel: Model controls missing from DOM');
        return;
    }

    refreshModelsButton.addEventListener('click', () => {
        requestModelList({ forceRefresh: true });
    });

    modelSelectEl.addEventListener('change', (event) => {
        const newModel = event.target.value;

        if (!newModel) {
            updateModelStatus('Select a model to continue.');
            return;
        }

        if (newModel === state.selectedModel) {
            updateModelStatus(MODEL_STATUS_MESSAGES.success(newModel));
            return;
        }

        requestModelSelection(newModel);
    });

    requestModelList({ forceRefresh: false });
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
            <div class="text-section text-section-alternative">
                <div class="text-label">
                    <span>Alternative Suggestion</span>
                    <a href="#" class="copy-link copy-link-alt" data-text="${escapeHtml(alternative)}">Copy</a>
                </div>
                <div class="text-content">${escapeHtml(alternative)}</div>
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
        ? `<div class="no-issues-banner">
                        ${escapeHtml(suggestion || 'Your text looks good! No grammar issues found.')}
                    </div>`
        : '';

    let revisedSection = '';
    if (showRevisedSection) {
        revisedSection = `
        <div class="text-section">
            <div class="text-label label-corrected">
                <span>Revised</span>
                <a href="#" class="copy-link" data-text="${escapeHtml(displayRevised)}">Copy</a>
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
            const textToCopy = copyLink.getAttribute('data-text') ?? '';
            copyToClipboard(textToCopy);
            const originalLabel = copyLink.dataset.originalText ?? copyLink.textContent;
            copyLink.dataset.originalText = originalLabel;
            copyLink.textContent = 'Copied';
            copyLink.classList.add('is-copied');
            setTimeout(() => {
                copyLink.textContent = copyLink.dataset.originalText || 'Copy';
                delete copyLink.dataset.originalText;
                copyLink.classList.remove('is-copied');
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

function requestModelList({ forceRefresh }) {
    if (!state.port) {
        console.warn('TypeRight Side Panel: No active port when requesting model list');
        updateModelStatus('Not connected. Reopen the side panel to load models.', true);
        setModelControlsLoading(false, null);
        return;
    }

    const loadingMessage = forceRefresh ? MODEL_STATUS_MESSAGES.refreshing : MODEL_STATUS_MESSAGES.loading;
    setModelControlsLoading(true, loadingMessage);

    state.port.postMessage({ action: forceRefresh ? 'refreshModels' : 'requestModels' });
}

function requestModelSelection(model) {
    if (!state.port) {
        console.warn('TypeRight Side Panel: Unable to set model without active port');
        updateModelStatus('Unable to switch models right now. Reopen the side panel and try again.', true);
        setModelControlsLoading(false, null);
        if (modelSelectEl && state.selectedModel) {
            modelSelectEl.value = state.selectedModel;
        }
        return;
    }

    setModelControlsLoading(true, MODEL_STATUS_MESSAGES.switching(model));
    state.port.postMessage({ action: 'setModel', model });
}

function handleModelListResponse(message) {
    if (!modelSelectEl || !modelStatusEl) {
        return;
    }

    if (message.loading) {
        setModelControlsLoading(true, MODEL_STATUS_MESSAGES.loading);
        return;
    }

    const models = Array.isArray(message.models) ? message.models : [];
    state.availableModels = models;

    setModelControlsLoading(false, null);

    if (message.error) {
        updateModelStatus(`Error loading models: ${message.error}`, true);
        return;
    }

    const selectedModel = message.selectedModel || state.selectedModel;
    populateModelSelect(models, selectedModel);

    if (models.length === 0) {
        updateModelStatus(MODEL_STATUS_MESSAGES.empty, true);
    } else {
        const effectiveModel = state.selectedModel || models[0]?.name;
        updateModelStatus(MODEL_STATUS_MESSAGES.success(effectiveModel));
    }
}

function handleModelSelected(model) {
    if (!modelSelectEl) {
        return;
    }

    if (!model || typeof model !== 'string') {
        updateModelStatus('No model selected.', true);
        return;
    }

    state.selectedModel = model;

    const optionExists = Array.from(modelSelectEl.options).some((option) => option.value === model);
    if (!optionExists) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        modelSelectEl.appendChild(option);
    }

    modelSelectEl.value = model;
    setModelControlsLoading(false, null);
    updateModelStatus(MODEL_STATUS_MESSAGES.success(model));
}

function handleModelSelectionError(errorMessage) {
    setModelControlsLoading(false, null);
    updateModelStatus(errorMessage || 'Failed to update model. Please try again.', true);

    if (modelSelectEl && state.selectedModel) {
        modelSelectEl.value = state.selectedModel;
    }
}

function populateModelSelect(models, selectedModel) {
    if (!modelSelectEl) {
        return;
    }

    modelSelectEl.innerHTML = '';

    if (!models || models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No models found';
        option.disabled = true;
        option.selected = true;
        modelSelectEl.appendChild(option);
        modelSelectEl.disabled = true;
        state.selectedModel = null;
        return;
    }

    modelSelectEl.disabled = state.modelsLoading;

    models.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.name;
        option.textContent = formatModelLabel(model);
        modelSelectEl.appendChild(option);
    });

    const fallbackModel = selectedModel && models.some((model) => model.name === selectedModel)
        ? selectedModel
        : models[0].name;

    modelSelectEl.value = fallbackModel;
    state.selectedModel = fallbackModel;
}

function formatModelLabel(model) {
    if (!model || !model.name) {
        return 'Unknown model';
    }

    const parts = [model.name];

    if (typeof model.size === 'number' && !Number.isNaN(model.size)) {
        parts.push(`(${formatBytes(model.size)})`);
    }

    return parts.join(' ');
}

function formatBytes(bytes) {
    if (typeof bytes !== 'number' || Number.isNaN(bytes)) {
        return 'unknown';
    }

    if (bytes === 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, index);

    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function setModelControlsLoading(isLoading, statusMessage) {
    state.modelsLoading = Boolean(isLoading);

    if (modelSelectEl) {
        const shouldDisableSelect = isLoading || state.availableModels.length === 0;
        modelSelectEl.disabled = shouldDisableSelect;
    }

    if (refreshModelsButton) {
        refreshModelsButton.disabled = Boolean(isLoading);
    }

    if (statusMessage) {
        updateModelStatus(statusMessage, false);
    }
}

function updateModelStatus(message, isError = false) {
    if (!modelStatusEl) {
        return;
    }

    modelStatusEl.textContent = message || '';
    modelStatusEl.classList.toggle('is-error', Boolean(isError));
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