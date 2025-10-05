/**
 * TypeRight Background Service Worker
 * Coordinates between content script and AI service
 */

// Configuration
const CONFIG = {
    aiServiceUrl: 'http://localhost:11434/api/chat',
    model: 'llama3.2:latest', // Using llama3.2:latest for the newest version
    maxRetries: 2,
    requestTimeout: 30000, // 30 seconds
    minTextLength: 25,
};

// State management
const state = {
    pendingChecks: new Map(),
    checkHistory: [],
    sidePanelPorts: new Map(), // Store connections to side panels
};

function hasSidePanelConnection(tabId) {
    if (tabId == null) {
        return false;
    }

    for (const { tabId: portTabId } of state.sidePanelPorts.values()) {
        if (portTabId === tabId) {
            return true;
        }
    }

    return false;
}

/**
 * Broadcast a message to side panels, optionally scoped to a tab
 */
function broadcastToSidePanels(targetTabId, message) {
    let delivered = false;

    state.sidePanelPorts.forEach(({ port, tabId }) => {
        if (targetTabId == null || tabId === targetTabId || tabId == null) {
            try {
                port.postMessage(message);
                delivered = true;
            } catch (err) {
                console.error('TypeRight: Failed to send via port:', err);
            }
        }
    });

    if (!delivered && targetTabId != null) {
        console.warn('TypeRight: No active side panel connection for tab:', targetTabId);
    }
}

/**
 * Listen for connections from side panel
 */
chrome.runtime.onConnect.addListener((port) => {
    console.log('TypeRight: Port connected:', port.name);

    if (port.name === 'sidepanel') {
        const tabId = port.sender?.tab?.id ?? null;
        const portKey = tabId ?? `panel-${port.sender?.documentId ?? Date.now()}`;

        state.sidePanelPorts.set(portKey, { port, tabId });

        port.onDisconnect.addListener(() => {
            console.log('TypeRight: Port disconnected');
            const existing = state.sidePanelPorts.get(portKey);
            const existingTabId = existing?.tabId ?? null;

            state.sidePanelPorts.delete(portKey);

            if (existingTabId != null) {
                try {
                    chrome.tabs.sendMessage(existingTabId, {
                        action: 'sidePanelStatus',
                        isOpen: false,
                    }).catch((error) => {
                        if (error && error.message && error.message.includes('Receiving end does not exist')) {
                            console.debug('TypeRight: Tab has no content script when notifying closure');
                        } else {
                            console.warn('TypeRight: Failed to notify tab about side panel closure:', error);
                        }
                    });
                } catch (error) {
                    console.warn('TypeRight: Failed to notify tab about side panel closure:', error);
                }
            }
        });

        port.onMessage.addListener(async (message) => {
            if (!message || !message.action) {
                return;
            }

            const targetTabId = message.tabId ?? tabId;

            if (targetTabId != null) {
                state.sidePanelPorts.set(portKey, { port, tabId: targetTabId });
            }

            switch (message.action) {
                case 'registerTab':
                    if (message.tabId != null) {
                        state.sidePanelPorts.set(portKey, { port, tabId: message.tabId });
                        console.log('TypeRight: Registered side panel for tab', message.tabId);

                        try {
                            chrome.tabs.sendMessage(message.tabId, {
                                action: 'sidePanelStatus',
                                isOpen: true,
                            }).catch((error) => {
                                if (error && error.message && error.message.includes('Receiving end does not exist')) {
                                    console.debug('TypeRight: Tab has no content script when notifying open status');
                                } else {
                                    console.warn('TypeRight: Failed to notify tab about side panel readiness:', error);
                                }
                            });
                        } catch (error) {
                            console.warn('TypeRight: Failed to notify tab about side panel readiness:', error);
                        }
                    }
                    break;

                case 'requestHistory':
                    {
                        const tabFilteredHistory = message.tabId != null
                            ? state.checkHistory.filter(entry => entry.tabId === message.tabId)
                            : state.checkHistory;

                        port.postMessage({
                            action: 'historyUpdate',
                            history: tabFilteredHistory,
                        });
                    }
                    break;

                case 'dismissEntry':
                    if (message.timestamp == null) {
                        break;
                    }

                    const beforeLength = state.checkHistory.length;
                    state.checkHistory = state.checkHistory.filter((entry) => {
                        const sameTimestamp = entry.timestamp === message.timestamp;
                        const sameElement = message.elementId ? entry.elementId === message.elementId : true;
                        return !(sameTimestamp && sameElement);
                    });

                    if (state.checkHistory.length !== beforeLength) {
                        console.log('TypeRight: Entry dismissed from history');
                        broadcastToSidePanels(null, {
                            action: 'removeSuggestion',
                            data: {
                                timestamp: message.timestamp,
                                elementId: message.elementId ?? null,
                            },
                        });
                    }
                    break;

                case 'highlightElement':
                    if (targetTabId == null) {
                        console.warn('TypeRight: Cannot highlight element without tabId');
                        break;
                    }
                    try {
                        await chrome.tabs.sendMessage(targetTabId, {
                            action: 'highlightElement',
                            elementId: message.elementId,
                        });
                    } catch (err) {
                        console.error('TypeRight: Failed to highlight element:', err);
                    }
                    break;
            }
        });

        // Send initial history when side panel connects
        port.postMessage({
            action: 'historyUpdate',
            history: state.checkHistory,
        });
    }
});

/**
 * Listen for messages from content script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('TypeRight: Received message:', message.action, 'from sender:', sender);

    // Get tabId safely
    const tabId = sender.tab ? sender.tab.id : null;

    if (!tabId && message.action !== 'getHistory') {
        console.error('TypeRight: No tab ID available for message:', message.action);
        sendResponse({ success: false, error: 'No tab ID available' });
        return true;
    }

    switch (message.action) {
        case 'checkGrammar':
            if (!hasSidePanelConnection(tabId)) {
                console.warn('TypeRight: Ignoring grammar check because side panel is not open for tab', tabId);
                sendResponse({ success: false, panelOpen: false });
            } else {
                handleGrammarCheck(message, tabId);
                sendResponse({ success: true, panelOpen: true });
            }
            break;

        case 'openSidePanel':
            handleOpenSidePanel(tabId);
            sendResponse({ success: true });
            break;

        case 'getHistory':
            sendResponse({ history: state.checkHistory });
            break;
    }

    return true; // Keep message channel open for async responses
});

/**
 * Handle grammar check request
 */
async function handleGrammarCheck(message, tabId) {
    const { text, elementId } = message;
    const normalizedText = (text || '').trim();

    if (normalizedText.length < CONFIG.minTextLength) {
        console.log('TypeRight: Ignoring grammar check below minimum length');
        return;
    }

    console.log('TypeRight: Checking grammar for text length:', normalizedText.length);

    try {
        const panelConnectedInitially = hasSidePanelConnection(tabId);

        if (panelConnectedInitially) {
            broadcastToSidePanels(tabId, {
                action: 'statusUpdate',
                data: {
                    message: 'Checking with Ollama…',
                    type: 'working',
                },
            });
        }

        // Call AI service to check grammar
        const result = await checkGrammarWithAI(normalizedText);

        const panelConnected = hasSidePanelConnection(tabId);

        if (result.hasIssues) {
            // Store in history
            const historyEntry = {
                timestamp: Date.now(),
                originalText: normalizedText,
                suggestion: result.suggestion,
                correctedText: result.correctedText,
                issues: result.issues,
                alternative: result.alternative,
                summary: result.summary,
                explanation: result.explanation,
                elementId: elementId,
                tabId: tabId,
                hasIssues: true,
                noIssues: false,
            };

            state.checkHistory.unshift(historyEntry);

            // Keep only last 50 checks
            if (state.checkHistory.length > 50) {
                state.checkHistory = state.checkHistory.slice(0, 50);
            }

            // Notify content script
            try {
                await chrome.tabs.sendMessage(tabId, {
                    action: 'showSuggestion',
                    elementId: elementId,
                    suggestion: result.suggestion,
                    originalText: text,
                });
                console.log('TypeRight: Sent suggestion to content script');
            } catch (error) {
                console.error('TypeRight: Failed to send to content script:', error);
            }

            if (panelConnected) {
                broadcastToSidePanels(tabId, {
                    action: 'displaySuggestion',
                    data: historyEntry,
                });
                console.log('TypeRight: Delivered suggestion to connected side panel');
            }
        } else {
            console.log('TypeRight: No grammar issues found');

            const historyEntry = {
                timestamp: Date.now(),
                originalText: normalizedText,
                suggestion: 'Your text looks good! No grammar issues found.',
                correctedText: result.correctedText || text,
                issues: result.issues,
                alternative: result.alternative,
                summary: result.summary,
                explanation: result.explanation,
                elementId: elementId,
                tabId: tabId,
                hasIssues: false,
                noIssues: true,
            };

            state.checkHistory.unshift(historyEntry);

            if (state.checkHistory.length > 50) {
                state.checkHistory = state.checkHistory.slice(0, 50);
            }

            if (panelConnected) {
                broadcastToSidePanels(tabId, {
                    action: 'displaySuggestion',
                    data: historyEntry,
                });
                console.log('TypeRight: Delivered no-issues message to side panel');
            }
        }
    } catch (error) {
        console.error('TypeRight: Grammar check failed:', error);

        // Show error in side panel
        broadcastToSidePanels(tabId, {
            action: 'displayError',
            error: error.message,
        });
    }
}

/**
 * Check grammar using AI service
 */
async function checkGrammarWithAI(text) {
    const systemPrompt = `You're a communication expert. You're tasked with helping the user with communication skills. Your goal is to take the user input and provide feedback on grammatical mistakes and summarize the meaning.`;

    const userPrompt = `User Input:
- Original: ${text}

Please provide your response in the following format:

AI Response:
- Revised: [Correct user input. If no correction is necessary, then say "No correction is needed."]
- Alternative: [Alternative suggestion with more natural and idiomatic language if necessary]
- Summary: [Provide a concise summary of the user input]

Focus on clarity and correctness in the revised version.`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

        const response = await fetch(CONFIG.aiServiceUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: CONFIG.model,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt,
                    },
                    {
                        role: 'user',
                        content: userPrompt,
                    },
                ],
                stream: false,
                temperature: 0.3,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`AI service returned status ${response.status}`);
        }

        const data = await response.json();
        console.log('TypeRight: Ollama raw response:', data);

        if (!data.message || !data.message.content) {
            throw new Error('Invalid response from Ollama');
        }

        const content = data.message.content;
        console.log('TypeRight: AI response content:', content);

        // Parse the AI response (it's plain text, not JSON)
        const result = parseAIResponse(content, text);

        console.log('TypeRight: Parsed result:', result);

        return result;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timeout - AI service took too long to respond');
        }

        // Check if Ollama is running
        if (error.message.includes('fetch')) {
            throw new Error('Cannot connect to AI service. Make sure Ollama is running (ollama serve)');
        }

        throw error;
    }
}

/**
 * Parse AI response into structured format
 */
function parseAIResponse(content, originalText) {
    const contentLower = content.toLowerCase();

    // Extract "Revised" text
    let correctedText = originalText;
    const revisedMatch = content.match(/(?:revised|corrected):\s*(.+?)(?:\n-|\n\n|$)/is);
    if (revisedMatch && revisedMatch[1]) {
        const revised = revisedMatch[1].trim();
        if (!revised.toLowerCase().includes('no correction') && revised.length > 0) {
            correctedText = revised;
        }
    }

    // Extract "Alternative" suggestion
    let alternative = '';
    const alternativeMatch = content.match(/(?:alternative):\s*(.+?)(?:\n-|\n\n|$)/is);
    if (alternativeMatch && alternativeMatch[1]) {
        alternative = alternativeMatch[1].trim();
    }

    // Extract "Issues Found"
    const issues = [];
    const issuesMatch = content.match(/issues?\s+found:?\s*([\s\S]*?)(?:\n\n|summary:|$)/i);
    if (issuesMatch && issuesMatch[1]) {
        const issueLines = issuesMatch[1].split('\n')
            .filter(line => line.trim())
            .map(line => line.replace(/^[\d\-\*\•\.\)]\s*/, '').trim())
            .filter(line => line.length > 0 && !line.toLowerCase().includes('none') && line !== '-');
        if (issueLines.length > 0) {
            issues.push(...issueLines);
        }
    }

    // Extract "Summary"
    let summary = '';
    const summaryMatch = content.match(/summary:?\s*(.+?)(?:\n\n|$)/is);
    if (summaryMatch && summaryMatch[1]) {
        summary = summaryMatch[1].trim().replace(/^[\-\*\•]\s*/, '');
    }

    // Determine if there are issues
    const hasIssues = issues.length > 0 ||
        (correctedText !== originalText && !contentLower.includes('no correction'));

    const result = {
        hasIssues: hasIssues,
        issues: issues,
        correctedText: correctedText,
        alternative: alternative,
        summary: summary,
        explanation: content,
        suggestion: formatSuggestion({ hasIssues, issues, correctedText, alternative, summary }),
    };

    return result;
}

/**
 * Format suggestion for display
 */
function formatSuggestion(result) {
    if (!result.hasIssues) {
        return 'Your text looks good! No grammar issues found.';
    }

    let suggestion = '';

    if (result.issues && result.issues.length > 0) {
        suggestion += '**Issues Found:**\n';
        result.issues.forEach((issue, index) => {
            suggestion += `${index + 1}. ${issue}\n`;
        });
    }

    if (result.alternative) {
        suggestion += `\n**Alternative:**\n${result.alternative}\n`;
    }

    if (result.summary) {
        suggestion += `\n**Summary:**\n${result.summary}`;
    }

    return suggestion;
}

/**
 * Handle open side panel request
 */
async function handleOpenSidePanel(tabId) {
    try {
        await chrome.sidePanel.open({ tabId: tabId });
    } catch (error) {
        console.error('TypeRight: Failed to open side panel:', error);
    }
}

/**
 * Handle extension icon click
 */
chrome.action.onClicked.addListener(async (tab) => {
    await chrome.sidePanel.open({ tabId: tab.id });
});

console.log('TypeRight: Background service worker initialized');