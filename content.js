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
    activeElement: null,
    sidePanelOpen: false,
};

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

    if (!state.sidePanelOpen) {
        return;
    }

    // Update active element
    state.activeElement = element;

    scheduleGrammarCheck(element, { immediate: false });
}

/**
 * Handle focus events
 */
function handleFocus(event) {
    const element = event.target;

    if (isEditableElement(element)) {
        state.activeElement = element;
        scheduleGrammarCheck(element, { immediate: true, reason: 'focus' });
    }
}

function handleClick(event) {
    const element = getEditableTarget(event.target);

    if (!element) {
        return;
    }

    state.activeElement = element;
    scheduleGrammarCheck(element, { immediate: true, reason: 'click' });
}

/**
 * Check if element is editable
 */
function isEditableElement(element) {
    return element.matches(EDITABLE_SELECTORS);
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
    if (element.id) return element.id;
    if (element.name) return `name-${element.name}`;

    // Generate a stable ID based on element properties
    const tagName = element.tagName.toLowerCase();
    const className = element.className || '';
    const index = Array.from(document.querySelectorAll(tagName)).indexOf(element);

    return `${tagName}-${className}-${index}`;
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
    const elementId = getElementId(element);

    if (state.typingTimers.has(elementId)) {
        clearTimeout(state.typingTimers.get(elementId));
        state.typingTimers.delete(elementId);
    }

    if (!state.sidePanelOpen) {
        return;
    }

    const text = getTextContent(element).trim();

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
        });

        if (response && response.success) {
            state.lastCheckedText.set(elementId, text);
            console.log('TypeRight: Grammar check initiated');
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
            return;
        }

        console.error('TypeRight: Error checking grammar (sendMessage failed):', error);
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
                showSuggestion(message.elementId, message.suggestion, message.originalText);
                break;

            case 'highlightElement':
                highlightElement(message.elementId);
                break;

            case 'sidePanelStatus':
                updateSidePanelStatus(Boolean(message.isOpen));
                break;
        }
    } catch (error) {
        console.error('TypeRight: Error handling message:', error);
    }

    return false;
}

function scheduleGrammarCheck(element, { immediate } = { immediate: false }) {
    if (!state.sidePanelOpen || !isEditableElement(element)) {
        return;
    }

    const elementId = getElementId(element);
    const text = getTextContent(element).trim();

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
function showSuggestion(elementId, suggestion, originalText) {
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
        state.typingTimers.forEach((timer) => clearTimeout(timer));
        state.typingTimers.clear();
        state.lastCheckedText.clear();
    }
}

/**
 * Find element by ID
 */
function findElementById(elementId) {
    // Try direct ID lookup
    let element = document.getElementById(elementId);
    if (element) return element;

    // Try name attribute
    if (elementId.startsWith('name-')) {
        const name = elementId.substring(5);
        element = document.querySelector(`[name="${name}"]`);
        if (element) return element;
    }

    // Check if it's the active element
    if (state.activeElement && getElementId(state.activeElement) === elementId) {
        return state.activeElement;
    }

    return null;
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
