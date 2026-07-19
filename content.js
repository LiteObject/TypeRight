/**
 * TypeRight Content Script
 * Monitors text input in editable elements and triggers grammar checking
 */

// Configuration
const CONFIG = {
    typingDelay: 2000, // Wait 2 seconds after typing stops
    minTextLength: 25, // Minimum text length to check
    debounceDelay: 300, // Debounce for rapid input events
    clickCheckDelay: 250, // Delay after click before checking (ms)
};

// State managemen
const state = {
    typingTimers: new Map(),
    lastCheckedText: new Map(),
    lastObservedText: new Map(),
    requestVersions: new Map(),
    currentRequests: new Map(),
    elementsById: new Map(),
    requestSequence: 0,
    activeElement: null,
    sidePanelOpen: false,
    captureEnabled: false,
};

const elementIdentities = new WeakMap();
let nextElementIdentity = 0;

const SENSITIVE_FIELD_PATTERN = /\b(?:password|passwd|passcode|secret|token|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|auth(?:orization)?|credential(?:s)?|ssn|social[-_ ]?security|tax[-_ ]?id|security[-_ ]?code|verification[-_ ]?code|one[-_ ]?time|otp|pin|cvv|cvc|cc[-_ ]?(?:number|name|exp|csc|cvv)|card[-_ ]?number|credit[-_ ]?card|bank|routing[-_ ]?number|account[-_ ]?number)\b/i;

// Selectors for editable elements
const EDITABLE_SELECTORS = [
    'input[type="text"]',
    'input[type="email"]',
    'input[type="search"]',
    'input[type="url"]',
    'textarea',
    '[contenteditable="true"]',
].join(', ');

/**
 * Initialize the content script
 */
function initialize() {
    console.log('TypeRight: Content script initialized');

    // Listen for input events on the entire document
    document.addEventListener('input', handleInput, true);

    // Listen for focus to track active element
    document.addEventListener('focus', handleFocus, true);
    document.addEventListener('click', handleClick, true);

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener(handleMessage);
}

/**
 * Handle input events
 */
function handleInput(event) {
    const element = event.target;

    // Check if element is editable
    if (!isEditableElement(element)) {
        return;
    }

    state.activeElement = element;

    if (!state.sidePanelOpen || !state.captureEnabled || isSensitiveElement(element)) {
        return;
    }

    scheduleGrammarCheck(element, { immediate: false });
}

/**
 * Handle focus events
 */
function handleFocus(event) {
    const element = event.target;

    if (isEditableElement(element)) {
        state.activeElement = element;

        if (state.sidePanelOpen && state.captureEnabled && !isSensitiveElement(element)) {
            scheduleGrammarCheck(element, { immediate: true, reason: 'focus' });
        }
    }
}

function handleClick(event) {
    const element = getEditableTarget(event.target);

    if (!element) {
        return;
    }

    state.activeElement = element;

    if (state.sidePanelOpen && state.captureEnabled && !isSensitiveElement(element)) {
        scheduleGrammarCheck(element, { immediate: true, reason: 'click' });
    }
}

/**
 * Check if element is editable
 */
function isEditableElement(element) {
    return Boolean(element && typeof element.matches === 'function' && element.matches(EDITABLE_SELECTORS));
}

function isSensitiveElement(element) {
    if (!element || typeof element.getAttribute !== 'function') {
        return true;
    }

    const type = (element.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') {
        return true;
    }

    if (element.hasAttribute('data-typeright-ignore')) {
        return true;
    }

    const identifyingAttributes = [
        'name',
        'id',
        'class',
        'autocomplete',
        'aria-label',
        'placeholder',
    ];

    return identifyingAttributes.some((attributeName) => {
        const value = element.getAttribute(attributeName);
        return value ? SENSITIVE_FIELD_PATTERN.test(value) : false;
    });
}

function getEditableTarget(node) {
    if (!node) {
        return null;
    }

    if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
        node = node.parentElement;
    }

    if (typeof node.matches === 'function' && node.matches(EDITABLE_SELECTORS)) {
        return node;
    }

    if (typeof node.closest === 'function') {
        return node.closest(EDITABLE_SELECTORS);
    }

    return null;
}

/**
 * Generate unique ID for element
 */
function getElementId(element) {
    let elementId = elementIdentities.get(element);

    if (!elementId) {
        nextElementIdentity += 1;
        elementId = `element-${nextElementIdentity}`;
        elementIdentities.set(element, elementId);
    }

    state.elementsById.set(elementId, element);
    return elementId;
}

/**
 * Get text content from element
 */
function getTextContent(element) {
    if (element.value !== undefined) {
        return element.value;
    }
    return element.textContent || element.innerText || '';
}

/**
 * Check grammar for the given element
 */
async function checkGrammar(element) {
    if (!state.sidePanelOpen || !state.captureEnabled || isSensitiveElement(element)) {
        return;
    }

    const elementId = getElementId(element);

    if (state.typingTimers.has(elementId)) {
        clearTimeout(state.typingTimers.get(elementId));
        state.typingTimers.delete(elementId);
    }

    if (!state.sidePanelOpen) {
        return;
    }

    const text = getTextContent(element).trim();
    const requestVersion = updateElementVersion(elementId, text);

    // Skip if text is too short
    if (text.length < CONFIG.minTextLength) {
        return;
    }

    // Skip if text hasn't changed since last successful check
    const lastText = state.lastCheckedText.get(elementId);
    if (lastText === text) {
        return;
    }

    console.log('TypeRight: Checking grammar for text:', text.substring(0, 50) + '...');

    const requestId = createRequestId();
    state.currentRequests.set(elementId, { requestId, requestVersion });

    try {
        // Check if extension context is valid
        if (!chrome || !chrome.runtime || !chrome.runtime.id) {
            console.warn('TypeRight: Extension context invalidated. Please reload the page.');
            return;
        }

        if (typeof chrome.runtime.sendMessage !== 'function') {
            console.error('TypeRight: chrome.runtime.sendMessage is unavailable in this context');
            return;
        }

        // Send to background script for AI processing
        const response = await chrome.runtime.sendMessage({
            action: 'checkGrammar',
            text: text,
            elementId: elementId,
            requestId,
            requestVersion,
        });

        if (response && response.success && isCurrentRequest(elementId, requestId, requestVersion, text)) {
            state.lastCheckedText.set(elementId, text);
            console.log('TypeRight: Grammar check initiated');
        } else if (response && response.success) {
            console.log('TypeRight: Grammar check response is stale; ignoring it');
        } else if (response && response.panelOpen === false) {
            console.log('TypeRight: Side panel is closed; skipping grammar check for now');
        } else if (response && response.error) {
            console.error('TypeRight: Background reported error:', response.error);
        }
    } catch (error) {
        // Handle extension context invalidation
        if (error.message && error.message.includes('Extension context invalidated')) {
            console.warn('TypeRight: Extension was reloaded. Please refresh this page to continue using TypeRight.');
            // Clear timers to prevent further attempts
            state.typingTimers.clear();
            state.lastCheckedText.clear();
            state.lastObservedText.clear();
            state.requestVersions.clear();
            state.currentRequests.clear();
            return;
        }

        console.error('TypeRight: Error checking grammar (sendMessage failed):', error);
        if (state.currentRequests.get(elementId)?.requestId === requestId) {
            state.currentRequests.delete(elementId);
        }
    }
}

/**
 * Handle messages from background script
 */
function handleMessage(message, sender, sendResponse) {
    try {
        // Check if extension context is still valid
        if (!chrome || !chrome.runtime || !chrome.runtime.id) {
            console.warn('TypeRight: Extension context invalidated in message handler');
            return false;
        }

        switch (message.action) {
            case 'showSuggestion':
                const accepted = showSuggestion(
                    message.elementId,
                    message.suggestion,
                    message.originalText,
                    message.requestId,
                    message.requestVersion,
                );

                if (typeof sendResponse === 'function') {
                    sendResponse({ accepted });
                }
                return true;

            case 'isCurrentCheck':
                if (typeof sendResponse === 'function') {
                    sendResponse({
                        current: isCurrentRequest(
                            message.elementId,
                            message.requestId,
                            message.requestVersion,
                            message.originalText,
                        ),
                    });
                }
                return true;

            case 'highlightElement':
                highlightElement(message.elementId);
                break;

            case 'sidePanelStatus':
                updateSidePanelStatus(Boolean(message.isOpen));
                break;

            case 'setCaptureEnabled':
                if (typeof sendResponse === 'function') {
                    sendResponse({ enabled: updateCaptureStatus(Boolean(message.enabled)) });
                }
                return true;

            case 'getCaptureStatus':
                if (typeof sendResponse === 'function') {
                    sendResponse({ enabled: state.captureEnabled });
                }
                return true;
        }
    } catch (error) {
        console.error('TypeRight: Error handling message:', error);
    }

    return false;
}

function scheduleGrammarCheck(element, { immediate } = { immediate: false }) {
    if (!state.sidePanelOpen || !state.captureEnabled || !isEditableElement(element) || isSensitiveElement(element)) {
        return;
    }

    const elementId = getElementId(element);
    const text = getTextContent(element).trim();
    updateElementVersion(elementId, text);

    // Skip if text is too short
    if (text.length < CONFIG.minTextLength) {
        if (state.typingTimers.has(elementId)) {
            clearTimeout(state.typingTimers.get(elementId));
            state.typingTimers.delete(elementId);
        }
        return;
    }

    // Skip if text hasn't changed since last successful check
    const lastText = state.lastCheckedText.get(elementId);
    if (lastText === text) {
        return;
    }

    if (state.typingTimers.has(elementId)) {
        clearTimeout(state.typingTimers.get(elementId));
    }

    if (immediate) {
        const timer = setTimeout(() => {
            checkGrammar(element);
        }, CONFIG.clickCheckDelay);
        state.typingTimers.set(elementId, timer);
        return;
    }

    const timer = setTimeout(() => {
        checkGrammar(element);
    }, CONFIG.typingDelay);

    state.typingTimers.set(elementId, timer);
}

/**
 * Show suggestion (open side panel)
 */
function showSuggestion(elementId, suggestion, originalText, requestId, requestVersion) {
    if (!isCurrentRequest(elementId, requestId, requestVersion, originalText)) {
        console.log('TypeRight: Ignoring stale suggestion for element:', elementId);
        return false;
    }

    console.log('TypeRight: Showing suggestion for element:', elementId);

    // Add visual indicator to the element
    const element = findElementById(elementId);
    if (element) {
        element.classList.add('typeright-checked');

        // Add temporary border color
        element.style.outline = '2px solid #ffc107';
        element.style.outlineOffset = '2px';

        // Remove after 3 seconds
        setTimeout(() => {
            element.style.outline = '';
            element.style.outlineOffset = '';
        }, 3000);
    }

    return true;
}

function updateElementVersion(elementId, text) {
    const lastObservedText = state.lastObservedText.get(elementId);

    if (lastObservedText !== text) {
        state.lastObservedText.set(elementId, text);
        state.requestVersions.set(elementId, (state.requestVersions.get(elementId) || 0) + 1);
        state.currentRequests.delete(elementId);
    }

    return state.requestVersions.get(elementId) || 0;
}

function clearCheckState() {
    state.typingTimers.forEach((timer) => clearTimeout(timer));
    state.typingTimers.clear();
    state.lastCheckedText.clear();
    state.lastObservedText.clear();
    state.requestVersions.clear();
    state.currentRequests.clear();
    state.elementsById.clear();
}

function updateCaptureStatus(isEnabled) {
    state.captureEnabled = Boolean(isEnabled) && state.sidePanelOpen;

    if (!state.captureEnabled) {
        clearCheckState();
    }

    return state.captureEnabled;
}

function createRequestId() {
    state.requestSequence += 1;
    return `${Date.now()}-${state.requestSequence}`;
}

function isCurrentRequest(elementId, requestId, requestVersion, originalText) {
    const currentRequest = state.currentRequests.get(elementId);

    if (!currentRequest
        || currentRequest.requestId !== requestId
        || currentRequest.requestVersion !== requestVersion) {
        return false;
    }

    const element = findElementById(elementId);
    return Boolean(element && getTextContent(element).trim() === (originalText || '').trim());
}

/**
 * Highlight element
 */
function highlightElement(elementId) {
    const element = findElementById(elementId);

    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.focus();
    }
}

function updateSidePanelStatus(isOpen) {
    if (state.sidePanelOpen === isOpen) {
        return;
    }

    state.sidePanelOpen = isOpen;

    if (!isOpen) {
        state.captureEnabled = false;
        clearCheckState();
    }
}

/**
 * Find element by ID
 */
function findElementById(elementId) {
    const element = state.elementsById.get(elementId);
    return element && element.isConnected ? element : null;
}

/**
 * Add CSS for visual indicators
 */
function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
    .typeright-checked {
      transition: outline 0.3s ease;
    }
  `;
    document.head.appendChild(style);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initialize();
        addStyles();
    });
} else {
    initialize();
    addStyles();
}
